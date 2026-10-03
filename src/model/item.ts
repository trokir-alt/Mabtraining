/**
 * Geometry that is common to every scene item, in table millimetres.
 *
 * Adding a stage 3 or 4 object means adding a branch to each of these plus one
 * to ItemView - nothing else in the app needs to know the new type exists.
 */

import type { Item, StrikePointItem, Vec } from './types'
import { quadControl } from './style'
import { GAME_ORDER, scaledPreset } from './game'
import { measureEnds } from './measure'

export type Rect = { x: number; y: number; w: number; h: number }

const v = (p: Vec, dx: number, dy: number): Vec => ({ x: p.x + dx, y: p.y + dy })

/** Move an item bodily. Returns a new item; never mutates. */
export function translateItem(item: Item, dx: number, dy: number): Item {
  switch (item.type) {
    case 'ball':
    case 'text':
    case 'strikePoint':
    case 'power':
    case 'ghostBall':
      return { ...item, x: item.x + dx, y: item.y + dy }
    case 'zone':
      return { ...item, x: item.x + dx, y: item.y + dy }
    case 'arrow':
      return { ...item, points: item.points.map((p) => v(p, dx, dy)) }
    case 'line':
      return { ...item, from: v(item.from, dx, dy), to: v(item.to, dx, dy) }
    case 'ghostTrail':
      return { ...item, from: v(item.from, dx, dy), to: v(item.to, dx, dy) }
    case 'measure':
      // it has no position of its own: it goes where its two balls go
      return item
  }
}

/**
 * Axis-aligned bounds, used to place the properties panel and to hit-test.
 * A ruler is placed by its balls, so it needs the scene's items to have any.
 */
export function itemBounds(item: Item, ballMm: number, items: Item[] = []): Rect {
  const box = (xs: number[], ys: number[], pad = 0): Rect => {
    const x0 = Math.min(...xs) - pad
    const y0 = Math.min(...ys) - pad
    return { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 }
  }
  switch (item.type) {
    case 'ball':
      return box([item.x], [item.y], ballMm / 2)
    case 'strikePoint': {
      // with a second ball the pair is one picture, and the panel must clear it
      if (!item.companion) return box([item.x], [item.y], item.sizeMm / 2)
      const c = companionCentre(item)
      return box([item.x, c.x], [item.y, c.y], item.sizeMm / 2)
    }
    case 'power': {
      // the column plus the +/- buttons above and below it
      const { w, h } = powerSize(item)
      const reach = powerButtonReach(w)
      return { x: item.x - w / 2, y: item.y - h / 2 - reach, w, h: h + 2 * reach }
    }
    case 'ghostBall':
      return box([item.x], [item.y], ballMm / 2)
    case 'text':
      // a rough box is enough: it only positions the panel
      return box([item.x], [item.y], item.size)
    case 'zone':
      return { x: item.x, y: item.y, w: item.w, h: item.h }
    case 'arrow':
      return box(item.points.map((p) => p.x), item.points.map((p) => p.y), item.width)
    case 'line':
      return box([item.from.x, item.to.x], [item.from.y, item.to.y], item.width)
    case 'ghostTrail':
      return box([item.from.x, item.to.x], [item.from.y, item.to.y], ballMm / 2)
    case 'measure': {
      const ends = measureEnds(item, items)
      if (!ends) return { x: 0, y: 0, w: 0, h: 0 }
      return box([ends[0].x, ends[1].x], [ends[0].y, ends[1].y], ballMm / 2)
    }
  }
}

/** The draggable handles of an item, in draw order. */
export type Handle = { id: string; at: Vec; kind: 'end' | 'bend' | 'corner' | 'rotate' | 'resize' }

/**
 * The strength indicator: one column of nine cells, read bottom to top, in the
 * units the cells are laid out in.
 */
export const POWER_CELLS = 9
export const POWER_ART = { w: 100, pad: 7, cell: 62, gap: 6 }
/** 7 + 9*62 + 8*6 + 7 = 620 */
export const POWER_ART_H = 2 * POWER_ART.pad + POWER_CELLS * POWER_ART.cell + (POWER_CELLS - 1) * POWER_ART.gap
export const POWER_RATIO = POWER_ART_H / POWER_ART.w
/** the pyramid's range; see `powerRange` for any other table */
export const POWER_MIN_MM = 70
export const POWER_MAX_MM = 170
export const POWER_DEFAULT_MM = 90

/**
 * How narrow and how wide the plate may be made on this table: the pyramid's
 * range, scaled the way every other preset is (see `presetScale`).
 */
export function powerRange(table: { game?: unknown }): [number, number] {
  return [scaledPreset(POWER_MIN_MM, table), scaledPreset(POWER_MAX_MM, table)]
}

/** width chosen for a table of this length, kept inside the allowed range */
export function defaultPowerWidth(table: { game?: unknown; lengthMm: number }): number {
  const [lo, hi] = powerRange(table)
  return Math.round(Math.min(hi, Math.max(lo, table.lengthMm / 40)))
}

/** the widest range any table allows: the renderer's guard, not a rule */
const POWER_ANY: [number, number] = [
  Math.min(...GAME_ORDER.map((g) => powerRange({ game: g })[0])),
  Math.max(...GAME_ORDER.map((g) => powerRange({ game: g })[1])),
]

/**
 * The cell a value occupies, counted from the TOP - the hardest shot is the
 * top of the column, the way a scale like this is read.
 */
export function powerCellFromTop(value: number): number {
  return POWER_CELLS - Math.round(value * 2)
}

/**
 * The colour of a cell, by its place on the scale rather than by the value
 * chosen: green at the bottom for a soft shot, red at the top for a full one.
 * `spent` cells are the ones this shot reaches; the rest keep the hue and lose
 * the light, so the column still reads as one scale.
 */
export function powerCellColour(fromTop: number, spent: boolean): string {
  const t = fromTop / (POWER_CELLS - 1) // 0 at the head of the column
  const hue = Math.round(130 * t) // 0 red at the top, 130 green at the foot
  return spent ? `hsl(${hue}, 72%, 52%)` : `hsl(${hue}, 42%, 21%)`
}

/**
 * The plate's size in mm, with a width that is always a real number.
 *
 * A scene handed to us without one - an older autosave, a payload someone
 * edited - used to come out NaN, and a NaN reaches Konva as a non-finite
 * gradient stop, which throws inside the layer's draw and takes every object
 * after it off the picture. One bad field must cost one bad plate, not the
 * whole table.
 */
export function powerSize(item: { widthMm?: number }): { w: number; h: number } {
  const raw = Number.isFinite(item.widthMm) ? (item.widthMm as number) : POWER_DEFAULT_MM
  const w = Math.min(POWER_ANY[1], Math.max(POWER_ANY[0], raw))
  return { w, h: w * POWER_RATIO }
}

/** how far the +/- buttons reach above and below the column */
export function powerButtonReach(w: number): number {
  return w * 0.72
}
/** the strike-point ball may be resized between these, on the pyramid */
export const STRIKE_MIN_MM = 200
export const STRIKE_MAX_MM = 500
/** the four sizes offered as buttons; reference values, like the widths */
export const STRIKE_SIZES = [200, 300, 400, 500] as const
export const STRIKE_DEFAULT_MM = 300

/** the strike ball's range on this table, scaled like every other preset */
export function strikeRange(table: { game?: unknown }): [number, number] {
  return [scaledPreset(STRIKE_MIN_MM, table), scaledPreset(STRIKE_MAX_MM, table)]
}
/** where the strike ball's size handle sits, as a multiple of its radius */
export const STRIKE_HANDLE_K = 1.3

/* ------------------------------------------- the second ball at the contact */

/**
 * How full the hit is, the way a coach names it: 1 is a full ball, 0.5 is a
 * half ball (the cue ball's edge on the object ball's centre), 0 is the
 * thinnest contact there is. These are the values the drag settles onto.
 */
export const FULLNESS_STEPS = [
  { value: 0.9, label: 'Полный' },
  { value: 0.75, label: '¾' },
  { value: 0.5, label: '½' },
  { value: 0.25, label: '¼' },
  { value: 0, label: 'Тонкий' },
] as const
/**
 * A dead-on full ball would put the two circles exactly on top of each other:
 * the white one vanishes, the coach sees a single ball and no way to grab it
 * back. The picture stops at a crescent instead - at 0.9 the cut is under six
 * degrees, which is a full ball to anyone at the table.
 */
export const MAX_FULLNESS = 0.9
/** ...and how close the drag has to come, as a fraction, to settle on one */
export const FULLNESS_SNAP = 0.06
/** a new second ball starts here: the half ball every lesson begins with */
export const DEFAULT_FULLNESS = 0.5

export function clampFullness(v: number): number {
  return Number.isFinite(v) ? Math.min(MAX_FULLNESS, Math.max(0, v)) : DEFAULT_FULLNESS
}

/** which side a horizontal offset means */
export function sideFromOffset(dx: number, fallback: CompanionSide): CompanionSide {
  if (Math.abs(dx) < 1e-3) return fallback
  return dx < 0 ? 'left' : 'right'
}

/** the named fraction a raw value settles onto, with the magnet on */
export function settleFullness(v: number, magnet: boolean): number {
  const f = clampFullness(v)
  if (!magnet) return Math.round(f * 100) / 100
  let best = f
  let bestErr = FULLNESS_SNAP
  for (const s of FULLNESS_STEPS) {
    const err = Math.abs(f - s.value)
    if (err < bestErr) {
      bestErr = err
      best = s.value
    }
  }
  return best
}

/** degrees folded into [0, 360) */
export function normDeg(deg: number): number {
  const d = deg % 360
  return d < 0 ? d + 360 : d
}

export type CompanionSide = 'left' | 'right'

/** +1 to the right, -1 to the left, in the widget's own frame */
export function sideSign(side: CompanionSide): number {
  return side === 'left' ? -1 : 1
}

/**
 * How far apart the two centres are for a given fullness: nothing at a full
 * ball, one diameter at the thinnest contact. Both balls are the same size by
 * construction, so there is no second diameter to keep in sync.
 */
export function companionGap(sizeMm: number, fullness: number): number {
  return (1 - clampFullness(fullness)) * sizeMm
}

/**
 * The centre of the object ball.
 *
 * Only x moves: both balls stand on the cloth, so a vertical offset would draw
 * one of them floating. The picture cannot express a shot that does not exist.
 */
export function companionCentre(item: StrikePointItem): Vec {
  const c = item.companion
  const d = companionGap(item.sizeMm, c ? c.fullness : DEFAULT_FULLNESS)
  return { x: item.x + d * sideSign(c ? c.side : 'right'), y: item.y }
}

/** The fullness a centre at distance `d` from the host would draw. */
export function fullnessFromGap(sizeMm: number, d: number): number {
  return clampFullness(1 - d / Math.max(sizeMm, 1e-6))
}


export function itemHandles(item: Item): Handle[] {
  switch (item.type) {
    case 'arrow': {
      const a = item.points[0]
      const b = item.points[item.points.length - 1]
      const through = item.points.length === 3 ? item.points[1] : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      return [
        { id: 'a', at: a, kind: 'end' },
        { id: 'bend', at: through, kind: 'bend' },
        { id: 'b', at: b, kind: 'end' },
      ]
    }
    case 'line':
    case 'ghostTrail':
      return [
        { id: 'a', at: item.from, kind: 'end' },
        { id: 'b', at: item.to, kind: 'end' },
      ]
    case 'zone':
      return [
        { id: 'nw', at: { x: item.x, y: item.y }, kind: 'corner' },
        { id: 'ne', at: { x: item.x + item.w, y: item.y }, kind: 'corner' },
        { id: 'se', at: { x: item.x + item.w, y: item.y + item.h }, kind: 'corner' },
        { id: 'sw', at: { x: item.x, y: item.y + item.h }, kind: 'corner' },
      ]
    case 'text':
      return [{ id: 'rotate', at: { x: item.x, y: item.y - item.size * 1.5 }, kind: 'rotate' }]
    case 'power': {
      // the corner of the plate itself: the aspect is locked, so one handle
      // is the whole story
      const { w, h } = powerSize(item)
      return [{ id: 'size', at: { x: item.x + w / 2, y: item.y + h / 2 }, kind: 'resize' }]
    }
    case 'strikePoint': {
      // the size handle sits OUTSIDE the ball, at 1.3 r on the 45-degree
      // diagonal: on the rim it collided with the dot (which may go to 0.9 r)
      // and stole the drag from it
      const r = item.sizeMm * STRIKE_HANDLE_K / 2
      return [{ id: 'size', at: { x: item.x + r * Math.SQRT1_2, y: item.y + r * Math.SQRT1_2 }, kind: 'resize' }]
    }
    default:
      return []
  }
}

/**
 * Apply a handle drag. Returns a patch for the item, or null if nothing moved.
 * `table` sets the size limits of the two widgets; see `presetScale`.
 */
export function dragHandle(item: Item, handleId: string, to: Vec, table: { game?: unknown } = {}): Partial<Item> | null {
  switch (item.type) {
    case 'arrow': {
      const pts = item.points.slice()
      const a = pts[0]
      const b = pts[pts.length - 1]
      if (handleId === 'a') return { points: pts.length === 3 ? [to, pts[1], b] : [to, b] } as Partial<Item>
      if (handleId === 'b') return { points: pts.length === 3 ? [a, pts[1], to] : [a, to] } as Partial<Item>
      if (handleId === 'bend') return { points: [a, to, b], curved: true } as Partial<Item>
      return null
    }
    case 'line':
      return handleId === 'a' ? ({ from: to } as Partial<Item>) : ({ to } as Partial<Item>)
    case 'ghostTrail':
      return handleId === 'a' ? ({ from: to } as Partial<Item>) : ({ to } as Partial<Item>)
    case 'zone': {
      const x0 = handleId === 'nw' || handleId === 'sw' ? to.x : item.x
      const y0 = handleId === 'nw' || handleId === 'ne' ? to.y : item.y
      const x1 = handleId === 'ne' || handleId === 'se' ? to.x : item.x + item.w
      const y1 = handleId === 'se' || handleId === 'sw' ? to.y : item.y + item.h
      return {
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        w: Math.abs(x1 - x0),
        h: Math.abs(y1 - y0),
      } as Partial<Item>
    }
    case 'text': {
      const angle = (Math.atan2(to.y - item.y, to.x - item.x) * 180) / Math.PI + 90
      return { angle: Math.round(angle) } as Partial<Item>
    }
    case 'power': {
      // the handle rides the corner, so the drag distance is the half
      // diagonal; the locked aspect turns it back into a width
      const d = Math.hypot(to.x - item.x, to.y - item.y)
      const width = (2 * d) / Math.hypot(1, POWER_RATIO)
      const [lo, hi] = powerRange(table)
      return { widthMm: Math.round(Math.min(hi, Math.max(lo, width))) } as Partial<Item>
    }
    case 'strikePoint': {
      const size = (2 * Math.hypot(to.x - item.x, to.y - item.y)) / STRIKE_HANDLE_K
      const [lo, hi] = strikeRange(table)
      return { sizeMm: Math.round(Math.min(hi, Math.max(lo, size))) } as Partial<Item>
    }
    default:
      return null
  }
}

/** Points of the quadratic an arrow follows, for both drawing and hit-testing. */
export function arrowCurve(points: Vec[]): { a: Vec; c: Vec | null; b: Vec } {
  const a = points[0]
  const b = points[points.length - 1]
  if (points.length < 3) return { a, c: null, b }
  return { a, c: quadControl(a, points[1], b), b }
}

/** the dot may not leave this fraction of the radius */
export const DOT_LIMIT = 0.9
/** magnet to the centre and to the two axes, as a fraction of the radius */
export const DOT_SNAP = 0.03

/**
 * Where the dot lands when dragged to `p` (in the ball's own mm frame, origin
 * at the centre): clamped to 0.9 r, snapped to the centre or an axis within 3%.
 */
export function settleDot(p: Vec, radiusMm: number): { u: number; v: number } {
  let u = p.x / radiusMm
  let v = p.y / radiusMm
  const len = Math.hypot(u, v)
  if (len > DOT_LIMIT) {
    u = (u / len) * DOT_LIMIT
    v = (v / len) * DOT_LIMIT
  }
  if (Math.hypot(u, v) <= DOT_SNAP) return { u: 0, v: 0 }
  if (Math.abs(u) <= DOT_SNAP) u = 0
  if (Math.abs(v) <= DOT_SNAP) v = 0
  return { u, v }
}

/** "2,5", "4,0" - a coach's scale, one decimal and a comma, as the brief asks */
export function formatPower(value: number): string {
  return value.toFixed(1).replace('.', ',')
}

/* ----------------------------------------------------- what is under a tap */

/** distance from `p` to the segment a-b */
function segDist(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

/** distance from `p` to an arrow's path, straight or curved */
function arrowDist(p: Vec, points: Vec[]): number {
  const { a, c, b } = arrowCurve(points)
  if (!c) return segDist(p, a, b)
  let best = Infinity
  let prev = a
  for (let i = 1; i <= 24; i++) {
    const t = i / 24
    const u = 1 - t
    const q = { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y }
    best = Math.min(best, segDist(p, prev, q))
    prev = q
  }
  return best
}

/**
 * Is `p` on this item? The same shapes the canvas draws, widened by `tolMm`
 * for a line, which is what a fingertip needs: Konva's own hit test only
 * runs for objects that listen, and while a drawing tool is on they do not.
 */
export function hitsItem(item: Item, p: Vec, ballMm: number, tolMm: number, items: Item[] = []): boolean {
  const r = ballMm / 2
  switch (item.type) {
    case 'ball':
    case 'ghostBall':
      return Math.hypot(p.x - item.x, p.y - item.y) <= r + tolMm / 3
    case 'arrow':
      return arrowDist(p, item.points) <= item.width / 2 + tolMm
    case 'line':
      return segDist(p, item.from, item.to) <= item.width / 2 + tolMm
    case 'ghostTrail':
      return segDist(p, item.from, item.to) <= r + tolMm / 3
    case 'zone': {
      if (item.shape === 'rect') {
        return p.x >= item.x && p.x <= item.x + item.w && p.y >= item.y && p.y <= item.y + item.h
      }
      const rx = Math.max(item.w / 2, 1)
      const ry = Math.max(item.h / 2, 1)
      const nx = (p.x - item.x - rx) / rx
      const ny = (p.y - item.y - ry) / ry
      return nx * nx + ny * ny <= 1
    }
    case 'text': {
      // into the caption's own frame: it is drawn from (x, y), centred on y
      const a = (-item.angle * Math.PI) / 180
      const dx = p.x - item.x
      const dy = p.y - item.y
      const u = dx * Math.cos(a) - dy * Math.sin(a)
      const v = dx * Math.sin(a) + dy * Math.cos(a)
      const w = Math.max(1, item.text.length) * item.size * 0.62
      return u >= -tolMm / 3 && u <= w + tolMm / 3 && Math.abs(v) <= item.size * 0.6 + tolMm / 3
    }
    case 'strikePoint': {
      if (Math.hypot(p.x - item.x, p.y - item.y) <= item.sizeMm / 2) return true
      if (!item.companion) return false
      const c = companionCentre(item)
      return Math.hypot(p.x - c.x, p.y - c.y) <= item.sizeMm / 2
    }
    case 'power': {
      const b = itemBounds(item, ballMm)
      return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
    }
    case 'measure': {
      const ends = measureEnds(item, items)
      return !!ends && segDist(p, ends[0], ends[1]) <= r + tolMm / 3
    }
  }
}

/** The topmost item under `p` that `accept` allows, or null. */
export function itemAt(
  items: Item[],
  p: Vec,
  ballMm: number,
  tolMm: number,
  accept: (item: Item) => boolean = () => true,
): Item | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (accept(it) && hitsItem(it, p, ballMm, tolMm, items)) return it
  }
  return null
}
