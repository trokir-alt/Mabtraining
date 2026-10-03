/**
 * Scene model.
 *
 * Every coordinate in this file is in TABLE MILLIMETRES, origin at the top-left
 * corner of the play field (the area between the cushion noses). Pixels only
 * ever appear at render time, produced by a single scale factor.
 *
 * `Item` is an open union: stages 2-4 of the spec add new members here and a
 * matching branch in the renderer; nothing else has to change.
 */

export type Vec = { x: number; y: number }

export type ClothColor = 'blue' | 'green' | 'red' | 'grey'

/**
 * Which game the table is for. It decides the table itself - size, pockets,
 * rails, markings - and how the balls look; see model/game.ts.
 */
export type Game = 'pyramid' | 'pool'

export type TableConfig = {
  /**
   * Absent on every scene saved before pool existed, and those are all Russian
   * pyramid; read it through `gameOf`, never directly.
   */
  game?: Game
  lengthMm: number
  widthMm: number
  ballMm: number
  markings: boolean
  cloth: ClothColor
}

export type ItemBase = { id: string }

/* ---------------------------------------------------------------- stage 1 */

export type BallKind = 'white' | 'cue' | 'target'

export type BallItem = ItemBase & {
  type: 'ball'
  x: number
  y: number
  /**
   * 'cue' is the ball that is struck, whatever the game draws it as: amber on
   * a pyramid table, white on a pool one. 'white' is an object ball.
   */
  kind: BallKind
  /** optional digit or letter drawn on the ball */
  label?: string
  /**
   * The pool number, 1..15, of an object ball. It is what the ball looks like
   * on a pool table - its colour, solid or stripe, the number in its disc.
   *
   * A pyramid table ignores it rather than dropping it, so an exercise taken
   * to the pyramid table and back keeps every ball the coach had numbered.
   */
  number?: number
}

/* ---------------------------------------------------------------- stage 2 */

export type StrokeStyle = 'solid' | 'dashed'
export type ArrowHead = 'end' | 'both' | 'none'

/**
 * `points` is [A, B] for a straight arrow and [A, P, B] for a curved one, where
 * P is a point the curve passes THROUGH - not a Bezier control point. Storing
 * the through-point is what lets the middle handle behave the way a hand
 * expects: the curve follows the finger instead of leading it. The control
 * point is derived at draw time, see `quadControl`.
 */
export type ArrowItem = ItemBase & {
  type: 'arrow'
  points: Vec[]
  style: StrokeStyle
  color: string
  /** stroke width in mm */
  width: number
  head: ArrowHead
  curved: boolean
}

export type GhostTrailItem = ItemBase & {
  type: 'ghostTrail'
  from: Vec
  to: Vec
  /** number of ghost balls, 3..8 */
  count: number
  /** recompute `count` from the length until the coach sets it by hand */
  autoCount: boolean
  /** the trail can run into an arrowhead, as it does on the reference */
  head: boolean
  color: string
}

export type ZoneItem = ItemBase & {
  type: 'zone'
  x: number
  y: number
  w: number
  h: number
  shape: 'rect' | 'ellipse'
  color: string
  opacity: number
}

export type LineItem = ItemBase & {
  type: 'line'
  from: Vec
  to: Vec
  style: StrokeStyle
  color: string
  width: number
}

export type TextItem = ItemBase & {
  type: 'text'
  x: number
  y: number
  text: string
  /** cap height in mm */
  size: number
  color: string
  /** degrees */
  angle: number
}

/* ---------------------------------------------------------------- stage 3 */

/**
 * The cue ball seen from behind, with the contact point on it. `dot` is in the
 * unit circle, u right+, v down+, and never further out than 0.9 - a real cue
 * tip that far out miscues.
 */
export type StrikePointItem = ItemBase & {
  type: 'strikePoint'
  x: number
  y: number
  /** diameter in table mm: 200..500 on the pyramid, scaled on pool (strikeRange) */
  sizeMm: number
  dot: { u: number; v: number }
  /**
   * The object ball, drawn white at the same magnification and BEHIND this
   * one - the picture a player sees down the shot line, with their own ball in
   * front of the one they are aiming at.
   *
   * Both balls stand on the cloth, so their centres are at the same height and
   * the offset between them can only ever be sideways: `side` is which way,
   * and there is deliberately no way to express one ball above the other,
   * because no such shot exists.
   *
   * How far they overlap is the aim: `fullness` 1 is a full ball, 0.5 is a
   * half ball - the cue ball's edge on the object ball's centre - and 0 is the
   * thinnest contact, the two rims just touching.
   */
  companion?: { side: 'left' | 'right'; fullness: number }
}

/** the nine values the strength scale can take; nothing in between */
export const POWER_VALUES = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5] as const
export type PowerValue = (typeof POWER_VALUES)[number]

export type PowerItem = ItemBase & {
  type: 'power'
  x: number
  y: number
  value: PowerValue
  /** plate width in table mm; the height follows from the artboard ratio */
  widthMm: number
}

/**
 * A wireframe ball, the table's own diameter: where a ball should BE at the
 * moment of contact. It deliberately takes no part in the push-apart, because
 * touching another ball is its whole purpose.
 */
export type GhostBallItem = ItemBase & {
  type: 'ghostBall'
  x: number
  y: number
}

/**
 * The distance between two balls, counted in balls: a row of ghosts laid
 * touching from the first ball towards the second, and the count beside it.
 *
 * It holds the two balls by id, not their positions, so it follows them as
 * the coach moves either one - the point is that the row is always true. With
 * either ball gone it draws nothing and is pruned with the edit that removed it.
 */
export type MeasureItem = ItemBase & {
  type: 'measure'
  /** the ball the row starts from */
  a: string
  /** the ball it runs to */
  b: string
  color: string
  /** the count beside the row: "3,4 шара" */
  label: boolean
}

/* ------------------------------------------------------------------ union */

export type Item =
  | BallItem
  | ArrowItem
  | GhostTrailItem
  | ZoneItem
  | LineItem
  | TextItem
  | StrikePointItem
  | PowerItem
  | GhostBallItem
  | MeasureItem

export type ItemType = Item['type']

export type Scene = {
  version: 1
  table: TableConfig
  /** exercise title, printed above the table on export */
  title?: string
  /** 1-3 lines printed under the table on export */
  note?: string
  /** draw order == z-order, last item is on top */
  items: Item[]
}

export type Orientation = 'horizontal' | 'vertical'
