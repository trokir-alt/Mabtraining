/**
 * Groups and selections of several objects.
 *
 * A group is nothing but a label the objects share (`Item.group`): there is
 * no group object to keep in step with its members, so nothing can go stale.
 * Everything here is pure, on table millimetres.
 */

import type { Item, Vec } from './types'
import { itemBounds, rotateItem, translateItem, type Rect } from './item'

/** the ids given, plus every other member of any group among them, in scene order */
export function expandGroups(items: Item[], ids: readonly string[]): string[] {
  const want = new Set(ids)
  const groups = new Set<string>()
  for (const it of items) if (want.has(it.id) && it.group) groups.add(it.group)
  return items.filter((it) => want.has(it.id) || (it.group !== undefined && groups.has(it.group))).map((it) => it.id)
}

/** A group of one is no group: drop the label where it is left alone. */
export function normalizeGroups(items: Item[]): Item[] {
  const count = new Map<string, number>()
  for (const it of items) if (it.group) count.set(it.group, (count.get(it.group) ?? 0) + 1)
  let changed = false
  const out = items.map((it) => {
    if (it.group && (count.get(it.group) ?? 0) < 2) {
      changed = true
      const { group: _drop, ...rest } = it
      void _drop
      return rest as Item
    }
    return it
  })
  return changed ? out : items
}

/** the group every one of these belongs to, if they are exactly one whole group */
export function wholeGroup(items: Item[], ids: readonly string[]): string | null {
  if (ids.length < 2) return null
  const sel = items.filter((it) => ids.includes(it.id))
  const g = sel[0]?.group
  if (!g || sel.some((it) => it.group !== g)) return null
  return items.filter((it) => it.group === g).length === sel.length ? g : null
}

/** the box around everything selected */
export function unionBounds(items: Item[], ids: readonly string[], ballMm: number): Rect | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const it of items) {
    if (!ids.includes(it.id)) continue
    const b = itemBounds(it, ballMm, items)
    if (!(b.w >= 0 && b.h >= 0) || (b.w === 0 && b.h === 0 && it.type === 'measure')) continue
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

/** everything whose box lies wholly inside the rectangle a-b */
export function itemsInside(items: Item[], a: Vec, b: Vec, ballMm: number): string[] {
  const x0 = Math.min(a.x, b.x)
  const y0 = Math.min(a.y, b.y)
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  return items
    .filter((it) => {
      const r = itemBounds(it, ballMm, items)
      if (it.type === 'measure' && r.w === 0 && r.h === 0) return false
      return r.x >= x0 && r.y >= y0 && r.x + r.w <= x1 && r.y + r.h <= y1
    })
    .map((it) => it.id)
}

/** the selection moved bodily from where `snapshot` had it */
export function movedCopies(snapshot: Item[], dx: number, dy: number): Item[] {
  return snapshot.map((it) => translateItem(it, dx, dy))
}

/** the selection turned about `c` from where `snapshot` had it */
export function turnedCopies(snapshot: Item[], c: Vec, deg: number): Item[] {
  return snapshot.map((it) => rotateItem(it, c, deg))
}

/** settle a turn on the nearest 15 degrees, the magnet's step */
export const ROTATE_STEP = 15
export function snapAngle(deg: number, magnet: boolean): number {
  return magnet ? Math.round(deg / ROTATE_STEP) * ROTATE_STEP : Math.round(deg * 10) / 10
}
