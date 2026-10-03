/**
 * Taking an exercise from one table to the other.
 *
 * A coach who starts drawing on the wrong table should not have to start
 * again, so a change of game carries the whole exercise across. Positions keep
 * their place on the table - a ball two diamonds from the corner pocket is two
 * diamonds from it on the other table - and every size that was chosen from a
 * preset lands on the same preset of the new table, so a thin arrow stays thin
 * and a large caption stays large.
 *
 * Pure: a scene in, a scene out, nothing else read or written.
 */

import type { BallItem, Game, Item, Scene, TableConfig, Vec } from './types'
import { gameOf, presetScale, scaledPreset, tableFor } from './game'
import { STROKE_WIDTHS, TEXT_SIZES, ghostCount, referenceOf } from './style'
import { STRIKE_SIZES, powerRange, strikeRange } from './item'
import { buildGeometry, clampToField, type TableGeometry } from './table'

/** the push-apart overshoots contact by this much, as in lib/place */
const EPS_MM = 0.05
const PASSES = 60
const GOLDEN_ANGLE = 2.399963229728653

/** the number a new object ball takes on a pool table: the lowest one free */
export function nextPoolNumber(items: Item[]): number {
  const used = new Set(items.filter((i): i is BallItem => i.type === 'ball' && i.kind !== 'cue').map((b) => b.number))
  for (let n = 1; n <= 15; n++) if (!used.has(n)) return n
  // all fifteen are out: a sixteenth object ball is odd but not wrong
  const count = items.filter((i) => i.type === 'ball' && i.kind !== 'cue').length
  return (count % 15) + 1
}

/**
 * Give every object ball that has none a number, lowest free first, in the
 * order the balls were placed. Balls that already have one keep it, which is
 * what brings an exercise back from the pyramid table exactly as it left.
 */
function numberBalls(items: Item[]): Item[] {
  const out: Item[] = []
  for (const it of items) {
    if (it.type === 'ball' && it.kind !== 'cue' && it.number === undefined) {
      out.push({ ...it, number: nextPoolNumber([...out, ...items.slice(out.length)]) })
    } else out.push(it)
  }
  return out
}

/**
 * Push overlapping balls apart, every one of them, symmetrically.
 *
 * Going from the pyramid to pool, positions shrink by the ratio of the tables
 * (0.72) but the balls only by the ratio of the balls (0.85), so a racked
 * pyramid comes out squeezed into itself. Moving only one ball of each pair,
 * the way a drag does, would shove the rack sideways; moving both half the
 * overlap lets it breathe back out around where it was.
 */
function relax(g: TableGeometry, balls: BallItem[], ballMm: number): BallItem[] {
  const min = ballMm + EPS_MM
  const pts = balls.map((b) => ({ x: b.x, y: b.y }))
  for (let pass = 0; pass < PASSES; pass++) {
    let moved = false
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[j].x - pts[i].x
        const dy = pts[j].y - pts[i].y
        const d = Math.hypot(dx, dy)
        if (d >= min) continue
        let ux: number
        let uy: number
        if (d < 1e-6) {
          const a = (j * GOLDEN_ANGLE) % (Math.PI * 2)
          ux = Math.cos(a)
          uy = Math.sin(a)
        } else {
          ux = dx / d
          uy = dy / d
        }
        const half = (min - d) / 2
        pts[i] = { x: pts[i].x - ux * half, y: pts[i].y - uy * half }
        pts[j] = { x: pts[j].x + ux * half, y: pts[j].y + uy * half }
        moved = true
      }
    }
    for (let i = 0; i < pts.length; i++) pts[i] = clampToField(g, pts[i], ballMm)
    if (!moved) break
  }
  return balls.map((b, i) => ({ ...b, x: pts[i].x, y: pts[i].y }))
}

/** a size chosen from a preset lands on the same preset; anything else scales */
function onPreset(actual: number, refs: readonly number[], from: TableConfig, to: TableConfig): number {
  const ref = referenceOf(actual, refs, from)
  return ref !== null ? scaledPreset(ref, to) : Math.round(actual * (presetScale(to) / presetScale(from)))
}

const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v))

/** The same exercise, on the table for `game`. Returns `scene` itself if it is already there. */
export function convertScene(scene: Scene, game: Game): Scene {
  const from = scene.table
  if (gameOf(from) === game) return scene
  const to = tableFor(game, from)
  const sx = to.lengthMm / from.lengthMm
  const sy = to.widthMm / from.widthMm
  const k = presetScale(to) / presetScale(from)
  const P = (p: Vec): Vec => ({ x: p.x * sx, y: p.y * sy })

  const moved: Item[] = scene.items.map((it): Item => {
    switch (it.type) {
      case 'ball':
      case 'ghostBall':
        return { ...it, ...P(it) }
      case 'arrow':
        return { ...it, points: it.points.map(P), width: onPreset(it.width, STROKE_WIDTHS, from, to) }
      case 'line':
        return { ...it, from: P(it.from), to: P(it.to), width: onPreset(it.width, STROKE_WIDTHS, from, to) }
      case 'ghostTrail': {
        const a = P(it.from)
        const b = P(it.to)
        const count = it.autoCount ? ghostCount(Math.hypot(b.x - a.x, b.y - a.y), to.ballMm) : it.count
        return { ...it, from: a, to: b, count }
      }
      case 'zone':
        return { ...it, ...P(it), w: it.w * sx, h: it.h * sy }
      case 'text':
        return { ...it, ...P(it), size: onPreset(it.size, TEXT_SIZES, from, to) }
      case 'strikePoint':
        return { ...it, ...P(it), sizeMm: clamp(onPreset(it.sizeMm, STRIKE_SIZES, from, to), strikeRange(to)) }
      case 'power':
        return { ...it, ...P(it), widthMm: clamp(Math.round(it.widthMm * k), powerRange(to)) }
      case 'measure':
        // it hangs on its balls by id, and they keep their ids
        return it
    }
  })

  const g = buildGeometry(to)
  const numbered = game === 'pool' ? numberBalls(moved) : moved
  const balls = relax(
    g,
    numbered.filter((i): i is BallItem => i.type === 'ball'),
    to.ballMm,
  )
  let b = 0
  const items = numbered.map((it) => (it.type === 'ball' ? balls[b++] : it))
  return { ...scene, table: to, items }
}
