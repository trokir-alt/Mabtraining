/**
 * Autosave.
 *
 * A coach works from a tablet in the hall, where the browser drops the tab out
 * of memory without asking. Losing a half-built diagram is the most painful
 * thing that can happen in this app and the cheapest to prevent, so the scene
 * goes to localStorage on a 500 ms debounce and comes back on load.
 *
 * Everything read back is treated as hostile: localStorage survives across
 * versions and a half-written or hand-edited value must never white-screen the
 * app. Anything that does not validate is dropped and the coach gets an empty
 * table instead of a crash.
 */

import type { ClothColor, Item, PowerValue, Scene, TableConfig } from '../model/types'
import { POWER_VALUES } from '../model/types'
import { DEFAULT_TABLE } from '../model/table'
import { POWER_DEFAULT_MM, STRIKE_DEFAULT_MM, powerRange, strikeRange } from '../model/item'
import { gameOf, scaledPreset } from '../model/game'
import { isCloth } from '../model/theme'
import { pruneMeasures } from '../model/measure'
import { DEFAULT_DENSITY, isDensity, type Density } from '../brand/watermark'
import { DEFAULT_FULLNESS, clampFullness, normDeg } from '../model/item'

const KEY = 'biliardconf.scene.v1'
/**
 * Which library record the autosaved scene belongs to, and when it was
 * written. The scene itself stays in localStorage because that is the one
 * store a browser lets us write synchronously as the tab is killed;
 * IndexedDB, where the library lives, quietly drops writes at that moment.
 * So this slot is the crash net and the library is the record, and the stamp
 * is how the two are told apart on the next boot.
 */
const DRAFT_KEY = 'biliardconf.draft.v1'
/** the watermark density is a setting, not scene data: it belongs to the
    coach and their screen, not to the exercise they are drawing */
const DENSITY_KEY = 'biliardconf.watermark.v1'
const DEBOUNCE_MS = 500

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const vec = (v: unknown): { x: number; y: number } | null => {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.x !== 'number' || typeof o.y !== 'number') return null
  if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) return null
  return { x: o.x, y: o.y }
}

/** a pool number: a whole 1..15, or nothing */
const poolNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 15 ? v : undefined

/**
 * Keeps only items this build understands, with every field forced into range.
 * The ranges of the two widgets depend on the table, so it comes along.
 */
function parseItem(raw: unknown, table: TableConfig): Item | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = str(o.id)
  if (!id) return null
  switch (o.type) {
    case 'ball': {
      const p = vec(o)
      if (!p) return null
      const kind = o.kind === 'cue' || o.kind === 'target' ? o.kind : 'white'
      const number = poolNumber(o.number)
      return { id, type: 'ball', x: p.x, y: p.y, kind, label: str(o.label), ...(number ? { number } : {}) }
    }
    case 'arrow': {
      if (!Array.isArray(o.points)) return null
      const points = o.points.map(vec).filter((p): p is { x: number; y: number } => p !== null)
      if (points.length < 2) return null
      return {
        id,
        type: 'arrow',
        points,
        style: o.style === 'dashed' ? 'dashed' : 'solid',
        color: str(o.color) ?? '#FFFFFF',
        width: num(o.width, 14),
        head: o.head === 'both' || o.head === 'none' ? o.head : 'end',
        curved: points.length === 3,
      }
    }
    case 'ghostTrail': {
      const from = vec(o.from)
      const to = vec(o.to)
      if (!from || !to) return null
      return {
        id,
        type: 'ghostTrail',
        from,
        to,
        count: Math.min(8, Math.max(3, Math.round(num(o.count, 5)))),
        autoCount: o.autoCount !== false,
        head: o.head === true,
        color: str(o.color) ?? '#FFFFFF',
      }
    }
    case 'zone': {
      const p = vec(o)
      if (!p) return null
      return {
        id,
        type: 'zone',
        x: p.x,
        y: p.y,
        w: Math.abs(num(o.w, 0)),
        h: Math.abs(num(o.h, 0)),
        shape: o.shape === 'ellipse' ? 'ellipse' : 'rect',
        color: str(o.color) ?? '#F5A623',
        opacity: Math.min(1, Math.max(0, num(o.opacity, 0.25))),
      }
    }
    case 'line': {
      const from = vec(o.from)
      const to = vec(o.to)
      if (!from || !to) return null
      return {
        id,
        type: 'line',
        from,
        to,
        style: o.style === 'dashed' ? 'dashed' : 'solid',
        color: str(o.color) ?? '#FFFFFF',
        width: num(o.width, 14),
      }
    }
    case 'text': {
      const p = vec(o)
      const text = str(o.text)
      if (!p || !text) return null
      return {
        id,
        type: 'text',
        x: p.x,
        y: p.y,
        text,
        size: num(o.size, 90),
        color: str(o.color) ?? '#FFFFFF',
        angle: num(o.angle, 0),
      }
    }
    case 'strikePoint': {
      const comp = o.companion as Record<string, unknown> | undefined
      let companion: { side: 'left' | 'right'; fullness: number } | undefined
      if (comp && typeof comp === 'object') {
        // scenes written while this was an angle keep their side; the vertical
        // part of that angle is dropped, because no such shot exists
        const side =
          comp.side === 'left' || comp.side === 'right'
            ? comp.side
            : typeof comp.angleDeg === 'number' && Number.isFinite(comp.angleDeg)
              ? Math.cos(normDeg(comp.angleDeg) * (Math.PI / 180)) < 0
                ? 'left'
                : 'right'
              : null
        if (side) companion = { side, fullness: clampFullness(num(comp.fullness, DEFAULT_FULLNESS)) }
      }
      const p = vec(o)
      const dot = vec(o.dot) ?? { x: 0, y: 0 }
      if (!p) return null
      const len = Math.hypot(dot.x, dot.y)
      const k = len > 0.9 ? 0.9 / len : 1
      return {
        id,
        type: 'strikePoint',
        x: p.x,
        y: p.y,
        sizeMm: Math.min(strikeRange(table)[1], Math.max(strikeRange(table)[0], num(o.sizeMm, scaledPreset(STRIKE_DEFAULT_MM, table)))),
        dot: { u: dot.x * k, v: dot.y * k },
        // an object ball that fails to validate is dropped, never guessed at:
        // half an aiming picture is one the coach did not draw
        companion,
      }
    }
    case 'power': {
      const p = vec(o)
      if (!p) return null
      const value = (POWER_VALUES as readonly number[]).includes(o.value as number) ? (o.value as PowerValue) : 2.5
      const [lo, hi] = powerRange(table)
      const widthMm = Math.min(hi, Math.max(lo, num(o.widthMm, scaledPreset(POWER_DEFAULT_MM, table))))
      return { id, type: 'power', x: p.x, y: p.y, value, widthMm }
    }
    case 'ghostBall': {
      const p = vec(o)
      if (!p) return null
      return { id, type: 'ghostBall', x: p.x, y: p.y }
    }
    case 'measure': {
      const a = str(o.a)
      const b = str(o.b)
      if (!a || !b || a === b) return null
      return { id, type: 'measure', a, b, color: str(o.color) ?? '#FFFFFF', label: o.label !== false }
    }
    default:
      return null
  }
}

function parseScene(raw: unknown): Scene | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.version !== 1) return null
  const t = (o.table ?? {}) as Record<string, unknown>
  const cloth: ClothColor = isCloth(t.cloth) ? t.cloth : 'blue'
  const table: TableConfig = {
    // written only for pool, as tableFor does, so a pyramid scene reads back
    // exactly as it was saved
    ...(gameOf(t) === 'pool' ? { game: 'pool' as const } : {}),
    lengthMm: num(t.lengthMm, DEFAULT_TABLE.lengthMm),
    widthMm: num(t.widthMm, DEFAULT_TABLE.widthMm),
    ballMm: num(t.ballMm, DEFAULT_TABLE.ballMm),
    markings: t.markings !== false,
    cloth,
  }
  // a ruler whose ball did not survive the parse has nothing to measure
  const items = Array.isArray(o.items)
    ? pruneMeasures(o.items.map((i) => parseItem(i, table)).filter((i): i is Item => i !== null))
    : []
  return {
    version: 1,
    table,
    title: str(o.title),
    note: str(o.note),
    items,
  }
}

export function loadScene(): Scene | null {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    return parseScene(JSON.parse(raw))
  } catch {
    // private mode, blocked storage, or junk in the slot: start clean
    return null
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
let pending: Scene | null = null
/** the library record the autosaved scene belongs to, or null for a new one */
let owner: string | null = null

function stamp(): void {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ id: owner, at: Date.now() }))
  } catch {
    // same as the scene below: losing the stamp costs a little, not the work
  }
}

function flush(): void {
  timer = null
  if (!pending) return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(pending))
  } catch {
    // quota or private mode: autosave is a convenience, never a hard failure
  }
  stamp()
  pending = null
}

/**
 * Name the record the autosaved scene belongs to, and write it out now.
 *
 * Now, and not on the next change: an exercise that is created and then
 * reloaded before anything else is touched would otherwise leave a draft that
 * names no record, and the next boot would read it as a library from before
 * this version and adopt it a second time. That is one duplicate per device,
 * and it is silent.
 */
export function setDraftOwner(id: string | null): void {
  owner = id
  stamp()
}

export function saveScene(scene: Scene): void {
  pending = scene
  if (timer !== null) return
  timer = setTimeout(flush, DEBOUNCE_MS)
}

/** the autosaved scene together with what it is a draft of, or null */
export function loadDraft(): { scene: Scene; id: string | null; at: number } | null {
  const scene = loadScene()
  if (!scene) return null
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY)
    if (!raw) return { scene, id: null, at: 0 }
    const o = JSON.parse(raw) as Record<string, unknown>
    return {
      scene,
      id: typeof o.id === 'string' ? o.id : null,
      at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0,
    }
  } catch {
    return { scene, id: null, at: 0 }
  }
}

/** the draft has been folded into the library; the crash net starts over */
export function clearDraft(): void {
  owner = null
  try {
    window.localStorage.removeItem(DRAFT_KEY)
  } catch {
    // nothing to do
  }
}

/** the legacy autosave slot, kept under its own name once migrated */
export const LEGACY_SCENE_KEY = KEY

export function readLegacyScene(): Scene | null {
  return loadScene()
}

/**
 * Mark the legacy slot as migrated by COPYING it aside, not by deleting it.
 * If the migration turns out to have gone wrong, the coach's only copy of
 * that diagram is still on the disk where it always was.
 */
export function stampLegacyMigrated(): void {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw) window.localStorage.setItem(KEY + '.migrated', raw)
  } catch {
    // nothing to do
  }
}

/** Write immediately - used when the tab is going away. */
export function flushScene(): void {
  if (timer !== null) clearTimeout(timer)
  flush()
}

export function clearSaved(): void {
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    // nothing to do
  }
}

/** The watermark density the coach last chose. Anything odd reads as the default. */
export function loadDensity(): Density {
  try {
    const raw = window.localStorage.getItem(DENSITY_KEY)
    return isDensity(raw) ? raw : DEFAULT_DENSITY
  } catch {
    return DEFAULT_DENSITY
  }
}

export function saveDensity(d: Density): void {
  try {
    window.localStorage.setItem(DENSITY_KEY, d)
  } catch {
    // private mode, or storage full: the choice just does not outlive the tab
  }
}
