/**
 * The ball-count ruler: how many balls fit between two balls.
 *
 * A coach sets up an exercise as "the object ball three balls from the cue
 * ball", and a student has to reproduce it on a real table. A number in mm
 * means nothing at the table; a row of ghosts, each touching the next, is
 * exactly what the student lays out with real balls to check the set-up.
 *
 * Pure geometry, in table millimetres. The row starts touching the first ball
 * and runs towards the second; whatever does not fill a whole ball is left as
 * a gap at the far end, and the count says how big it is.
 */

import type { Item, MeasureItem, Vec } from './types'
import { clampToField, type TableGeometry } from './table'

/** a ball the ruler can hang from: a real ball or a wireframe one */
type Anchor = Extract<Item, { type: 'ball' | 'ghostBall' }>

export const isAnchor = (it: Item | undefined): it is Anchor =>
  !!it && (it.type === 'ball' || it.type === 'ghostBall')

/**
 * A gap this close under a whole number of balls still counts as that many:
 * a ball snapped to three balls must show three ghosts, not two, whatever the
 * last bit of floating point says.
 */
const WHOLE_EPS = 0.02
/** within this many balls of a whole count the label drops the decimal */
const ROUND_EPS = 0.05
/** a drag settles on a whole number of balls within this many balls of it */
export const MEASURE_SNAP = 0.08
/** the row is drawn for a gap of at most this many balls; a table holds ~52 */
const MAX_GHOSTS = 80

export function anchorAt(items: Item[], id: string): Vec | null {
  const it = items.find((i) => i.id === id)
  return isAnchor(it) ? { x: it.x, y: it.y } : null
}

/** the centres of the two balls, or null if either is gone */
export function measureEnds(item: MeasureItem, items: Item[]): [Vec, Vec] | null {
  const a = anchorAt(items, item.a)
  const b = anchorAt(items, item.b)
  return a && b ? [a, b] : null
}

export type MeasureLayout = {
  /** unit vector from the first ball to the second */
  u: Vec
  /** clear space between the two balls, mm */
  gap: number
  /** the same in balls, fractional */
  balls: number
  /** centres of the touching ghosts, first ball outwards */
  ghosts: Vec[]
  /** the surfaces the gap is measured between */
  start: Vec
  end: Vec
}

/** where the ghosts go between balls centred at `a` and `b`, of diameter `d` */
export function measureLayout(a: Vec, b: Vec, d: number): MeasureLayout {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  const u = len > 1e-6 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 }
  const gap = Math.max(0, len - d)
  const balls = d > 0 ? gap / d : 0
  const whole = Math.min(MAX_GHOSTS, Math.floor(balls + WHOLE_EPS))
  const ghosts: Vec[] = []
  for (let i = 1; i <= whole; i++) ghosts.push({ x: a.x + u.x * d * i, y: a.y + u.y * d * i })
  const r = d / 2
  return {
    u,
    gap,
    balls,
    ghosts,
    start: { x: a.x + u.x * r, y: a.y + u.y * r },
    end: { x: b.x - u.x * r, y: b.y - u.y * r },
  }
}

/** 1 шар, 2 шара, 5 шаров, 21 шар, 11 шаров */
export function pluralBalls(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'шар'
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'шара'
  return 'шаров'
}

/**
 * The count as a coach says it: "3 шара", "3,4 шара", "вплотную". One decimal
 * with a comma; a fraction always takes "шара", as in "полтора шара".
 */
export function formatBalls(balls: number): string {
  if (balls < ROUND_EPS) return 'вплотную'
  const n = Math.round(balls)
  if (Math.abs(balls - n) < ROUND_EPS) return `${n} ${pluralBalls(n)}`
  return `${balls.toFixed(1).replace('.', ',')} шара`
}

/** the long form for the properties panel: "3 вплотную + 27 мм" */
export function formatGap(gap: number, d: number): string {
  if (d <= 0) return ''
  const balls = gap / d
  const whole = Math.floor(balls + WHOLE_EPS)
  const rest = Math.max(0, Math.round(gap - whole * d))
  if (whole === 0) return rest === 0 ? 'шары касаются' : `${rest} мм`
  return rest === 0 ? `${whole} вплотную` : `${whole} вплотную + ${rest} мм`
}

/**
 * The ball nearest `p` that a press there means, or null. A finger is not a
 * pin: the reach is the larger of the ball itself and `grabMm`.
 */
export function pickAnchor(items: Item[], p: Vec, d: number, grabMm: number, exceptId?: string): { id: string; at: Vec } | null {
  const reach = Math.max(d * 0.75, grabMm)
  let best: { id: string; at: Vec } | null = null
  let bestD = reach
  for (const it of items) {
    if (!isAnchor(it) || it.id === exceptId) continue
    const dist = Math.hypot(it.x - p.x, it.y - p.y)
    if (dist <= bestD) {
      bestD = dist
      best = { id: it.id, at: { x: it.x, y: it.y } }
    }
  }
  return best
}

/**
 * A ball dragged near a whole number of balls from the other end of one of
 * its rulers settles on that number exactly. This is what makes "three balls
 * apart" something a coach can set with a finger rather than with the arrow
 * keys; the magnet switch turns it off with the others.
 */
export function snapToMeasures(items: Item[], id: string, p: Vec, d: number): Vec {
  if (d <= 0) return p
  let out = p
  for (const m of items) {
    if (m.type !== 'measure' || (m.a !== id && m.b !== id)) continue
    const other = anchorAt(items, m.a === id ? m.b : m.a)
    if (!other) continue
    const dx = out.x - other.x
    const dy = out.y - other.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) continue
    const k = (len - d) / d
    const n = Math.round(k)
    if (n < 0 || Math.abs(k - n) > MEASURE_SNAP) continue
    const want = d * (n + 1)
    out = { x: other.x + (dx / len) * want, y: other.y + (dy / len) * want }
  }
  return out
}

/**
 * The ruler magnet combined with the table's own. The table's magnet goes
 * first, so a ball dragged along the long line stays on it; but when that has
 * pulled the ball off a whole count the coach was clearly aiming for, the
 * count wins - a diamond line is a guide, "three balls apart" is the exercise.
 * `grid` is `raw` after the table's magnet.
 */
export function snapWithMeasures(items: Item[], id: string, raw: Vec, grid: Vec, d: number): Vec {
  const fromGrid = snapToMeasures(items, id, grid, d)
  if (fromGrid !== grid) return fromGrid
  const fromRaw = snapToMeasures(items, id, raw, d)
  return fromRaw !== raw ? fromRaw : grid
}

/**
 * Drop every ruler that has lost a ball, and every ghost a ruler made for
 * itself once no ruler holds it any more. Called with the edit that removed
 * the ball or the ruler, so one undo brings them all back together.
 */
export function pruneMeasures(items: Item[]): Item[] {
  const anchors = new Set(items.filter(isAnchor).map((i) => i.id))
  const rulers = items.filter((i): i is MeasureItem => i.type === 'measure' && anchors.has(i.a) && anchors.has(i.b))
  const held = new Set(rulers.flatMap((m) => [m.a, m.b]))
  const alive = new Set(rulers.map((m) => m.id))
  const kept = items.filter((i) => {
    if (i.type === 'measure') return alive.has(i.id)
    // a ghost its ruler made goes with the ruler; one placed by hand stays
    if (i.type === 'ghostBall' && i.owner) return alive.has(i.owner) || held.has(i.id)
    return true
  })
  return kept.length === items.length ? items : kept
}

/* ------------------------------------------------- a ruler to the table */

export type EndKind = 'pocket' | 'spot' | 'cushion' | 'free'

/**
 * Where the free end of a ruler goes: a ruler can run from a ball to a pocket,
 * to a spot or to the cushion as well as to another ball, and there a ghost
 * ball is put to hang it on.
 *
 * `p` is where the finger let go and `from` the ball at the other end. Within
 * `reachMm`, in this order:
 *  - a pocket: the ghost sits in it, on the drop point;
 *  - a spot (the three on the long line, and the house's): on the spot;
 *  - a cushion: touching it - and straight across from `from` when the finger
 *    is anywhere near that line, since "how far from the cushion" means the
 *    shortest way;
 * and anywhere else simply where it was let go, kept on the cloth.
 */
export function settleEnd(g: TableGeometry, p: Vec, from: Vec | null, d: number, reachMm: number): { at: Vec; kind: EndKind } {
  const r = d / 2
  let best: Vec | null = null
  let bestD = reachMm + r
  for (const pk of g.pockets) {
    const dist = Math.hypot(p.x - pk.at.x, p.y - pk.at.y)
    if (dist <= bestD) {
      best = pk.at
      bestD = dist
    }
  }
  if (best) return { at: clampToField(g, best, d), kind: 'pocket' }

  const spots = [...g.spots, { x: g.houseLineX / 2, y: g.widthMm / 2 }]
  bestD = reachMm
  for (const s of spots) {
    const dist = Math.hypot(p.x - s.x, p.y - s.y)
    if (dist <= bestD) {
      best = s
      bestD = dist
    }
  }
  if (best) return { at: { x: best.x, y: best.y }, kind: 'spot' }

  // the line a touching ball's centre runs along, one per cushion, and how
  // far in from it the finger is (negative past it, into the rail)
  const sides = [
    { horiz: true, line: r, depth: p.y - r },
    { horiz: true, line: g.widthMm - r, depth: g.widthMm - r - p.y },
    { horiz: false, line: r, depth: p.x - r },
    { horiz: false, line: g.lengthMm - r, depth: g.lengthMm - r - p.x },
  ]
  const side = sides.filter((s) => s.depth <= reachMm).sort((a, b) => a.depth - b.depth)[0]
  if (side) {
    const along = side.horiz ? p.x : p.y
    const straight = from ? (side.horiz ? from.x : from.y) : along
    const use = Math.abs(along - straight) <= Math.max(d * 1.5, reachMm) ? straight : along
    const at = side.horiz ? { x: use, y: side.line } : { x: side.line, y: use }
    return { at: clampToField(g, at, d), kind: 'cushion' }
  }
  return { at: clampToField(g, p, d), kind: 'free' }
}

/** an existing ruler between these two balls, either way round */
export function findMeasure(items: Item[], a: string, b: string): MeasureItem | null {
  for (const i of items) {
    if (i.type === 'measure' && ((i.a === a && i.b === b) || (i.a === b && i.b === a))) return i
  }
  return null
}

/* --------------------------------------------- one ghost of the row, by index */

/** where ghost `index` of the row stands, or null if the row has no such ghost */
export function ghostCentre(item: MeasureItem, items: Item[], d: number, index: number): Vec | null {
  const ends = measureEnds(item, items)
  if (!ends) return null
  return measureLayout(ends[0], ends[1], d).ghosts[index] ?? null
}

/** the ghost of the row under `p`, if any */
export function ghostIndexAt(item: MeasureItem, items: Item[], d: number, p: Vec): number | null {
  const ends = measureEnds(item, items)
  if (!ends) return null
  const { ghosts } = measureLayout(ends[0], ends[1], d)
  let best: number | null = null
  let bestD = d / 2
  ghosts.forEach((g, i) => {
    const dist = Math.hypot(p.x - g.x, p.y - g.y)
    if (dist <= bestD) {
      best = i
      bestD = dist
    }
  })
  return best
}

/**
 * The ghosts a real ball now stands on: one put there with «Заменить на», or
 * any ball the coach has placed exactly in the row. The row leaves them out,
 * so the ball reads as having taken the ghost's place.
 */
export function coveredGhosts(item: MeasureItem, items: Item[], d: number): number[] {
  const ends = measureEnds(item, items)
  if (!ends) return []
  const { ghosts } = measureLayout(ends[0], ends[1], d)
  const balls = items.filter((i) => i.type === 'ball' && i.id !== item.a && i.id !== item.b)
  const out: number[] = []
  ghosts.forEach((g, i) => {
    if (balls.some((b) => b.type === 'ball' && Math.hypot(b.x - g.x, b.y - g.y) < d * 0.1)) out.push(i)
  })
  return out
}
