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
 * Drop every ruler that has lost a ball. Called with the edit that removed
 * the ball, so one undo brings both back together.
 */
export function pruneMeasures(items: Item[]): Item[] {
  const anchors = new Set(items.filter(isAnchor).map((i) => i.id))
  const kept = items.filter((i) => i.type !== 'measure' || (anchors.has(i.a) && anchors.has(i.b)))
  return kept.length === items.length ? items : kept
}

/** an existing ruler between these two balls, either way round */
export function findMeasure(items: Item[], a: string, b: string): MeasureItem | null {
  for (const i of items) {
    if (i.type === 'measure' && ((i.a === a && i.b === b) || (i.a === b && i.b === a))) return i
  }
  return null
}
