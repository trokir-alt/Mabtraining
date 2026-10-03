/**
 * The drawing objects of stage 2, all in table millimetres.
 *
 * Each is a pure presentational component: the parent owns selection, dragging
 * and history. Adding a stage 3 object means another component here and another
 * branch in ItemView.
 */

import { Circle, Ellipse, Group, Line as KLine, Rect, Shape, Text } from 'react-konva'
import type { Context } from 'konva/lib/Context'
import type { Shape as KonvaShape } from 'konva/lib/Shape'
import type { KonvaEventObject } from 'konva/lib/Node'
import type {
  ArrowItem,
  Game,
  GhostBallItem,
  GhostTrailItem,
  LineItem,
  PowerItem,
  StrikePointItem,
  TextItem,
  Vec,
  ZoneItem,
} from '../model/types'
import { POWER_VALUES } from '../model/types'
import {
  DEFAULT_FULLNESS,
  POWER_ART,
  arrowCurve,
  companionGap,
  formatPower,
  fullnessFromGap,
  powerButtonReach,
  powerCellColour,
  powerCellFromTop,
  powerSize,
  settleDot,
  settleFullness,
  sideFromOffset,
  sideSign,
} from '../model/item'
import { formatBalls, measureLayout } from '../model/measure'
import { BRAND } from '../brand/assets'
import { BRAND_FONT, CANVAS_FONT } from '../model/fonts'
import { BALL, POOL_GENERIC } from '../model/theme'

/** dashes scale with the stroke, so a thin dashed line never looks like a rash */
const dashFor = (w: number, style: string): number[] | undefined =>
  style === 'dashed' ? [w * 2.2, w * 1.7] : undefined

/**
 * anything thinner than this is miserable to grab on a tablet; `minMm` is the
 * screen's own minimum (see render/hit), converted to table millimetres
 */
const hitWidth = (w: number, minMm = 0) => Math.max(w * 2, 60, minMm)

/** an arrowhead as a filled triangle pointing along `dir` */
function head(ctx: Context, tip: Vec, dir: Vec, w: number): void {
  const len = Math.hypot(dir.x, dir.y) || 1
  const ux = dir.x / len
  const uy = dir.y / len
  const back = w * 2.6
  const half = w * 1.5
  ctx.moveTo(tip.x, tip.y)
  ctx.lineTo(tip.x - ux * back + -uy * half, tip.y - uy * back + ux * half)
  ctx.lineTo(tip.x - ux * back - -uy * half, tip.y - uy * back - ux * half)
  ctx.closePath()
}

export function ArrowShape({ item, minHit = 0 }: { item: ArrowItem; minHit?: number }) {
  const { a, c, b } = arrowCurve(item.points)
  // tangents of the quadratic at its ends; for a straight arrow that is the chord
  const dirEnd = c ? { x: b.x - c.x, y: b.y - c.y } : { x: b.x - a.x, y: b.y - a.y }
  const dirStart = c ? { x: a.x - c.x, y: a.y - c.y } : { x: a.x - b.x, y: a.y - b.y }
  return (
    <Group>
      <Shape
        sceneFunc={(ctx: Context, shape: KonvaShape) => {
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          if (c) ctx.quadraticCurveTo(c.x, c.y, b.x, b.y)
          else ctx.lineTo(b.x, b.y)
          ctx.strokeShape(shape)
        }}
        stroke={item.color}
        strokeWidth={item.width}
        dash={dashFor(item.width, item.style)}
        lineCap="round"
        lineJoin="round"
        hitStrokeWidth={hitWidth(item.width, minHit)}
      />
      {item.head !== 'none' && (
        <Shape
          sceneFunc={(ctx: Context, shape: KonvaShape) => {
            ctx.beginPath()
            head(ctx, b, dirEnd, item.width)
            if (item.head === 'both') head(ctx, a, dirStart, item.width)
            ctx.fillShape(shape)
          }}
          fill={item.color}
          listening={false}
        />
      )}
    </Group>
  )
}

export function LineShape({ item, minHit = 0 }: { item: LineItem; minHit?: number }) {
  return (
    <KLine
      points={[item.from.x, item.from.y, item.to.x, item.to.y]}
      stroke={item.color}
      strokeWidth={item.width}
      dash={dashFor(item.width, item.style)}
      lineCap="round"
      hitStrokeWidth={hitWidth(item.width, minHit)}
    />
  )
}

/**
 * The ghost trail: the element that actually makes a diagram readable.
 *
 * The ghosts are real balls, at the table's own ball diameter - decorative
 * circles of some other size would quietly lie about whether a shot fits.
 */
export function GhostTrailShape({ item, ballMm, minHit = 0 }: { item: GhostTrailItem; ballMm: number; minHit?: number }) {
  const n = Math.max(2, item.count)
  const dx = item.to.x - item.from.x
  const dy = item.to.y - item.from.y
  const r = ballMm / 2
  const ghosts = Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1)
    return {
      x: item.from.x + dx * t,
      y: item.from.y + dy * t,
      // fades along the run, 0.75 down to 0.15
      o: 0.75 - (0.75 - 0.15) * t,
    }
  })
  return (
    <Group>
      {/* the gaps between ghosts are most of the trail; without this a finger
          landing between two balls would grab nothing */}
      <KLine
        points={[item.from.x, item.from.y, item.to.x, item.to.y]}
        stroke="rgba(0,0,0,0)"
        strokeWidth={1}
        hitStrokeWidth={Math.max(ballMm, minHit)}
      />
      {ghosts.map((g, i) => (
        <Circle
          key={i}
          x={g.x}
          y={g.y}
          radius={r}
          fill={item.color}
          opacity={g.o}
          stroke={item.color}
          strokeWidth={1.5}
          hitStrokeWidth={0}
        />
      ))}
      {item.head && (
        <Shape
          sceneFunc={(ctx: Context, shape: KonvaShape) => {
            ctx.beginPath()
            head(ctx, item.to, { x: dx, y: dy }, r * 0.55)
            ctx.fillShape(shape)
          }}
          fill={item.color}
          opacity={0.85}
          listening={false}
        />
      )}
    </Group>
  )
}

export function ZoneShape({ item }: { item: ZoneItem }) {
  const common = {
    fill: item.color,
    opacity: item.opacity,
    stroke: item.color,
    strokeWidth: 5,
  }
  if (item.shape === 'ellipse') {
    return (
      <Ellipse
        x={item.x + item.w / 2}
        y={item.y + item.h / 2}
        radiusX={Math.max(item.w / 2, 1)}
        radiusY={Math.max(item.h / 2, 1)}
        {...common}
      />
    )
  }
  return <Rect x={item.x} y={item.y} width={item.w} height={item.h} cornerRadius={12} {...common} />
}

/**
 * Text on the cloth. The dark halo is not decoration: a caption has to survive
 * landing on a pale ball or on the bright middle of the bed.
 */
export function TextShape({ item }: { item: TextItem }) {
  return (
    <Text
      x={item.x}
      y={item.y}
      text={item.text}
      fontSize={item.size}
      fontFamily={CANVAS_FONT}
      fontStyle="bold"
      fill={item.color}
      rotation={item.angle}
      offsetY={item.size / 2}
      shadowColor="rgba(0,0,0,0.55)"
      shadowBlur={item.size * 0.22}
      shadowForStrokeEnabled={false}
    />
  )
}

/* ---------------------------------------------------------------- stage 3 */

const ORANGE = '#F5A623'
const DOT_RED = '#E5322D'
/** the light the sights and the pocket rims are cut from */
const CREAM = '#E8E2D0'
/** the brand navy, lit from above and shaded below */
const PLATE_TOP = '#22485F'
const PLATE_BOTTOM = '#0E2231'

export type StrikePointProps = {
  item: StrikePointItem
  /**
   * Whose picture this is. The widget shows the struck ball in front and the
   * object ball behind it, and the two games colour them the other way round:
   * amber in front of white on the pyramid, white in front of the yellow
   * 1-ball on pool.
   */
  game: Game
  /** px per mm, so the dot's grab area can be sized in screen pixels */
  scale: number
  /** live while dragging, final on release */
  onDot: (dot: { u: number; v: number }, final: boolean) => void
  onDotStart: () => void
  /** where the second ball is dragged to: a side and a fullness */
  onCompanion: (side: 'left' | 'right', fullness: number, final: boolean) => void
  onCompanionStart: () => void
  /** whether the angle settles onto the 15-degree grid */
  magnet: boolean
}

/**
 * The cue ball from behind with the contact point on it. The dot is its own
 * draggable node: dragging it moves only the dot, and its drag events are
 * stopped here so the widget underneath does not also start moving.
 */
/** the same modelling as a ball on the cloth, pulled a shade darker - see below */
const WIDGET_WHITE = [0, '#FDFDFD', 0.34, '#EFF1F2', 0.8, '#DDE1E4', 1, '#B9BFC4']
const WIDGET_AMBER = [0, '#FFD98A', 0.4, BALL.cue.base, 1, BALL.cue.shade]
const WIDGET_YELLOW = [0, '#FFE27A', 0.34, POOL_GENERIC, 0.8, POOL_GENERIC, 1, '#9C7400']

export function StrikePointShape({ item, game, scale, onDot, onDotStart, onCompanion, onCompanionStart, magnet }: StrikePointProps) {
  const r = item.sizeMm / 2
  const pool = game === 'pool'
  // The object ball's centre in the host's own frame. Only x moves: both balls
  // stand on the cloth, so their centres are at the same height and one can
  // never be drawn above the other. How far out it sits IS the aim.
  const side = item.companion ? item.companion.side : 'right'
  const gapMm = companionGap(item.sizeMm, item.companion ? item.companion.fullness : DEFAULT_FULLNESS)
  const cc = { x: gapMm * sideSign(side), y: 0 }
  const dotR = item.sizeMm / 16
  // a grab area of at least 44 screen px, however small the dot is drawn
  const grabR = Math.max(dotR, 22 / Math.max(scale, 1e-6))
  const stop = (e: KonvaEventObject<Event>) => {
    e.cancelBubble = true
  }
  const move = (e: KonvaEventObject<DragEvent>, final: boolean) => {
    e.cancelBubble = true
    const node = e.target
    const dot = settleDot({ x: node.x(), y: node.y() }, r)
    node.position({ x: dot.u * r, y: dot.v * r })
    onDot(dot, final)
  }
  const swing = (e: KonvaEventObject<DragEvent>, final: boolean) => {
    e.cancelBubble = true
    const node = e.target
    // the vertical part of the drag is thrown away, not clamped: there is no
    // shot in which one ball sits above the other
    const s = sideFromOffset(node.x(), side)
    const f = settleFullness(fullnessFromGap(item.sizeMm, Math.abs(node.x())), magnet)
    // straight back onto the geometry, so the named fractions are visible
    // while dragging rather than only on release
    node.position({ x: companionGap(item.sizeMm, f) * sideSign(s), y: 0 })
    onCompanion(s, f, final)
  }
  const ring = (k: number) => (
    <Circle key={k} radius={r * k} stroke="rgba(0,0,0,0.55)" strokeWidth={1.6} listening={false} />
  )
  return (
    <Group x={item.x} y={item.y}>
      {/* Both shadows go down before either body: a shadow drawn after the
          white ball would smear grey across it. The second ball's shadow also
          leans OUTWARD along the bearing, so the seam where the two rims meet -
          the one line in this picture that carries the physics - stays clean
          whichever side the ball is on. */}
      {item.companion && (
        <Ellipse
          x={cc.x + r * 0.3 + r * 0.28 * sideSign(side)}
          y={cc.y + r * 0.38}
          radiusX={r * 0.94}
          radiusY={r * 0.68}
          fillRadialGradientStartPoint={{ x: 0, y: 0 }}
          fillRadialGradientStartRadius={0}
          fillRadialGradientEndPoint={{ x: 0, y: 0 }}
          fillRadialGradientEndRadius={r * 0.94}
          fillRadialGradientColorStops={[0, 'rgba(0,0,0,0.34)', 0.55, 'rgba(0,0,0,0.14)', 1, 'rgba(0,0,0,0)']}
          listening={false}
        />
      )}
      {/* the same soft contact shadow a ball has */}
      <Ellipse
        x={r * 0.3}
        y={r * 0.38}
        radiusX={r * 0.94}
        radiusY={r * 0.68}
        fillRadialGradientStartPoint={{ x: 0, y: 0 }}
        fillRadialGradientStartRadius={0}
        fillRadialGradientEndPoint={{ x: 0, y: 0 }}
        fillRadialGradientEndRadius={r * 0.94}
        fillRadialGradientColorStops={[0, 'rgba(0,0,0,0.34)', 0.55, 'rgba(0,0,0,0.14)', 1, 'rgba(0,0,0,0)']}
        listening={false}
      />
      {/* The object ball: a plain white ball, with none of the host's rings and
          no red dot - those say where the CUE hits, and putting them on both
          balls would lose which one is being struck.

          It is drawn BEFORE the host, so the host covers it: that is the
          picture a player sees down the shot line, and how much of the white
          ball still shows is exactly the aim. Dragging it sets both the side
          and that fraction. */}
      {item.companion && (
        <Group
          name="companion"
          x={cc.x}
          y={cc.y}
          draggable
          onMouseDown={stop}
          onTouchStart={stop}
          onDragStart={(e) => {
            e.cancelBubble = true
            onCompanionStart()
          }}
          onDragMove={(e) => swing(e, false)}
          onDragEnd={(e) => swing(e, true)}
        >
          {/* Modelled like every other ball in the app, one lamp from the upper
              left, but pulled a shade darker than a ball on the cloth: at this
              magnification a pure white disc next to the yellow one glares and
              flattens the picture. */}
          <Circle
            radius={r}
            fillRadialGradientStartPoint={{ x: -r * 0.2, y: -r * 0.22 }}
            fillRadialGradientStartRadius={r * 0.06}
            fillRadialGradientEndPoint={{ x: r * 0.04, y: r * 0.06 }}
            fillRadialGradientEndRadius={r * 1.06}
            fillRadialGradientColorStops={pool ? WIDGET_YELLOW : WIDGET_WHITE}
            stroke="rgba(0,0,0,0.6)"
            strokeWidth={2}
          />
          {/* a thin rim of its own, so the ball keeps an edge where it leaves
              the widget and meets the cloth */}
          <Circle radius={r} stroke={BALL.white.rim} strokeWidth={1.6} opacity={0.45} listening={false} />
          {/* the same specular the balls on the cloth carry */}
          <Ellipse
            x={-r * 0.36}
            y={-r * 0.42}
            radiusX={r * 0.3}
            radiusY={r * 0.2}
            rotation={-28}
            fillRadialGradientStartPoint={{ x: 0, y: 0 }}
            fillRadialGradientStartRadius={0}
            fillRadialGradientEndPoint={{ x: 0, y: 0 }}
            fillRadialGradientEndRadius={r * 0.3}
            fillRadialGradientColorStops={[
              0,
              'rgba(255,255,255,0.8)',
              0.4,
              'rgba(255,255,255,0.4)',
              0.7,
              'rgba(255,255,255,0.07)',
              1,
              'rgba(255,255,255,0)',
            ]}
            listening={false}
          />
        </Group>
      )}
      <Circle
        radius={r}
        fillRadialGradientStartPoint={{ x: -r * 0.2, y: -r * 0.22 }}
        fillRadialGradientStartRadius={r * 0.06}
        fillRadialGradientEndPoint={{ x: 0, y: 0 }}
        fillRadialGradientEndRadius={r * 1.06}
        fillRadialGradientColorStops={pool ? WIDGET_WHITE : WIDGET_AMBER}
        stroke="rgba(0,0,0,0.6)"
        strokeWidth={2}
      />
      {[0.25, 0.5, 0.75].map(ring)}
      <KLine points={[-r, 0, r, 0]} stroke="rgba(0,0,0,0.55)" strokeWidth={1.6} listening={false} />
      <KLine points={[0, -r, 0, r]} stroke="rgba(0,0,0,0.55)" strokeWidth={1.6} listening={false} />
      <Group
        name="dot"
        x={item.dot.u * r}
        y={item.dot.v * r}
        draggable
        onMouseDown={stop}
        onTouchStart={stop}
        onDragStart={(e) => {
          e.cancelBubble = true
          onDotStart()
        }}
        onDragMove={(e) => move(e, false)}
        onDragEnd={(e) => move(e, true)}
      >
        <Circle radius={grabR} fill="rgba(0,0,0,0)" />
        <Circle radius={dotR} fill={DOT_RED} stroke="#FFFFFF" strokeWidth={Math.max(1.2, dotR * 0.14)} listening={false} />
      </Group>
    </Group>
  )
}

export type PowerProps = {
  item: PowerItem
  selected: boolean
  onValue: (value: (typeof POWER_VALUES)[number]) => void
  onStep: (steps: number) => void
}

/**
 * The strength indicator: one column of nine cells, read bottom to top.
 *
 * The scale is a colour, not a count - green at the foot for a soft shot, red
 * at the head for a full one - and the cells the shot reaches are lit while
 * the rest keep the hue and lose the light, so the column still reads as one
 * scale rather than two. The number sits in the topmost lit cell, which is the
 * value itself: nothing to cross-reference.
 *
 * Nothing about how it behaves changed: a cell sets its own value, the +/-
 * buttons and the keyboard step it, and it is still one item on the table.
 */
export function PowerShape({ item, selected, onValue, onStep }: PowerProps) {
  const { w, h } = powerSize(item)
  const u = w / POWER_ART.w // artboard unit -> table mm
  const x0 = -w / 2
  const y0 = -h / 2
  const cell = POWER_ART.cell * u
  const gap = POWER_ART.gap * u
  const pad = POWER_ART.pad * u
  const inner = w - 2 * pad
  const cellY = (fromTop: number) => y0 + pad + fromTop * (cell + gap)
  const lit = powerCellFromTop(item.value)
  const reach = powerButtonReach(w)
  const btnR = reach * 0.42
  const stop = (e: KonvaEventObject<Event>) => {
    e.cancelBubble = true
  }
  const btn = (sign: -1 | 1) => (
    <Group
      x={0}
      y={-sign * (h / 2 + reach * 0.55)}
      onClick={(e) => {
        stop(e)
        onStep(sign)
      }}
      onTap={(e) => {
        stop(e)
        onStep(sign)
      }}
    >
      <Circle
        radius={btnR}
        fillLinearGradientStartPoint={{ x: 0, y: -btnR }}
        fillLinearGradientEndPoint={{ x: 0, y: btnR }}
        fillLinearGradientColorStops={[0, PLATE_TOP, 1, PLATE_BOTTOM]}
        stroke={CREAM}
        strokeWidth={btnR * 0.07}
        shadowColor="rgba(0,0,0,0.45)"
        shadowBlur={btnR * 0.5}
        shadowOffsetY={btnR * 0.12}
      />
      <Text
        text={sign > 0 ? '+' : '−'}
        fontSize={btnR * 1.25}
        fontFamily={BRAND_FONT}
        fontStyle="700"
        fill={CREAM}
        width={btnR * 2}
        height={btnR * 2}
        offsetX={btnR}
        offsetY={btnR}
        align="center"
        verticalAlign="middle"
        listening={false}
      />
    </Group>
  )
  return (
    <Group x={item.x} y={item.y}>
      {/* the case the cells are set into, with the table's own soft shadow */}
      <Rect
        x={x0}
        y={y0}
        width={w}
        height={h}
        cornerRadius={9 * u}
        fillLinearGradientStartPoint={{ x: 0, y: y0 }}
        fillLinearGradientEndPoint={{ x: 0, y: y0 + h }}
        fillLinearGradientColorStops={[0, PLATE_TOP, 0.5, BRAND.navy, 1, PLATE_BOTTOM]}
        stroke="rgba(0,0,0,0.6)"
        strokeWidth={1.6 * u}
        shadowColor="rgba(0,0,0,0.45)"
        shadowBlur={7 * u}
        shadowOffsetX={1.4 * u}
        shadowOffsetY={2.4 * u}
      />
      {POWER_VALUES.map((v) => {
        const fromTop = powerCellFromTop(v)
        const spent = fromTop >= lit
        const y = cellY(fromTop)
        return (
          <Group key={v}>
            <Rect
              x={x0 + pad}
              y={y}
              width={inner}
              height={cell}
              cornerRadius={4 * u}
              fill={powerCellColour(fromTop, spent)}
              stroke="rgba(0,0,0,0.45)"
              strokeWidth={0.9 * u}
              listening={false}
            />
            {/* a thin lip along the top of a lit cell, so it reads as raised */}
            {spent && (
              <KLine
                points={[x0 + pad + 4 * u, y + 2.2 * u, x0 + pad + inner - 4 * u, y + 2.2 * u]}
                stroke="rgba(255,255,255,0.3)"
                strokeWidth={1 * u}
                lineCap="round"
                listening={false}
              />
            )}
            {/* the value lives in its own cell: the top of what the shot reaches */}
            {fromTop === lit && (
              <Text
                x={x0 + pad}
                y={y}
                width={inner}
                height={cell}
                align="center"
                verticalAlign="middle"
                wrap="none"
                text={formatPower(v)}
                fontSize={cell * 0.62}
                fontFamily={BRAND_FONT}
                fontStyle="700"
                fill="#FFFFFF"
                shadowColor="rgba(0,0,0,0.45)"
                shadowBlur={cell * 0.12}
                listening={false}
              />
            )}
            {/* the cell's own target, the whole row including its gap */}
            <Rect
              x={x0}
              y={y - gap / 2}
              width={w}
              height={cell + gap}
              fill="rgba(0,0,0,0)"
              onClick={(e) => {
                stop(e)
                onValue(v)
              }}
              onTap={(e) => {
                stop(e)
                onValue(v)
              }}
            />
          </Group>
        )
      })}
      {selected && btn(-1)}
      {selected && btn(1)}
    </Group>
  )
}

/**
 * The wireframe ball: where a ball should be at the moment of contact. Drawn
 * at the table's own ball diameter, because the point of it is that the
 * distance between two centres is exactly one diameter.
 */
export function GhostBallShape({ item, ballMm }: { item: GhostBallItem; ballMm: number }) {
  const r = ballMm / 2
  return (
    <Group x={item.x} y={item.y}>
      {/* a faint fill is the grab area; the wire alone is too thin for a finger */}
      <Circle radius={r} fill="rgba(245,166,35,0.12)" stroke={ORANGE} strokeWidth={4} />
      <Ellipse radiusX={r} radiusY={r * 0.42} stroke={ORANGE} strokeWidth={2.2} opacity={0.9} listening={false} />
      <Ellipse radiusX={r * 0.42} radiusY={r} stroke={ORANGE} strokeWidth={2.2} opacity={0.9} listening={false} />
      <KLine points={[-r * 0.2, 0, r * 0.2, 0]} stroke={ORANGE} strokeWidth={2.2} listening={false} />
      <KLine points={[0, -r * 0.2, 0, r * 0.2]} stroke={ORANGE} strokeWidth={2.2} listening={false} />
    </Group>
  )
}

/* ------------------------------------------------------------ ball ruler */

export type MeasureShapeProps = {
  /** centres of the two balls */
  a: Vec
  b: Vec
  ballMm: number
  color: string
  label: boolean
  selected: boolean
  /** degrees that undo the stage's own turn, so the figures read upright */
  counter: number
  /** the label goes on the side of the row facing this point: the cloth's middle */
  toward: Vec
  /** screen px per mm: on a phone the table is small, and a ring a third of
      a pixel wide or a 9 px count is there without being seen */
  scale: number
  /** ghosts filled with the colour rather than drawn as rings */
  fill?: boolean
  /** the narrowest band, in mm, the row can be picked up by; see render/hit */
  minHit?: number
}

/** dark figures on a light fill, white ones on a dark fill */
function figureOn(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color)
  if (!m) return '#FFFFFF'
  const n = parseInt(m[1], 16)
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
  return lum > 140 ? '#1B2430' : '#FFFFFF'
}

/**
 * The row of ghosts between two balls, each touching the next, numbered so a
 * student can count them, and the count beside the row.
 *
 * The ghosts are the table's own ball - a ruler in some other unit would
 * quietly lie about how many real balls fit.
 */
export function MeasureShape({ a, b, ballMm, color, label, selected, counter, toward, scale, fill = false, minHit = 0 }: MeasureShapeProps) {
  const L = measureLayout(a, b, ballMm)
  const r = ballMm / 2
  const px = 1 / Math.max(scale, 1e-3)
  const sw = Math.max(ballMm * 0.045, 1.4 * px)
  const mid = { x: (L.start.x + L.end.x) / 2, y: (L.start.y + L.end.y) / 2 }
  let n = { x: -L.u.y, y: L.u.x }
  if ((toward.x - mid.x) * n.x + (toward.y - mid.y) * n.y < 0) n = { x: -n.x, y: -n.y }
  const fs = Math.max(ballMm * 0.9, 12 * px)
  const text = formatBalls(L.balls)
  /**
   * How far out the label sits. It is drawn upright on the screen whatever
   * the row's direction, so a row that runs up the screen has the label's
   * whole width across it: the offset is the label box's reach towards the
   * row, plus the ghost's radius, plus air. The width is an estimate (bold
   * sans runs ~0.56 em a character); a little too much air is harmless.
   */
  const c = (counter * Math.PI) / 180
  const across = Math.abs(n.x * Math.cos(c) + n.y * Math.sin(c))
  const along = Math.abs(-n.x * Math.sin(c) + n.y * Math.cos(c))
  const reach = ((text.length * 0.56 * fs) / 2) * across + (fs / 2) * along
  const off = r + ballMm * 0.25 + reach
  const at = { x: mid.x + n.x * off, y: mid.y + n.y * off }
  const textW = ballMm * 8
  const numFs = ballMm * 0.5
  const last = L.ghosts[L.ghosts.length - 1]
  const rest = last ? { x: last.x + L.u.x * r, y: last.y + L.u.y * r } : L.start
  // a short bar across the row at each ball's surface: where the count starts and ends
  const tick = (p: Vec) => [p.x - n.x * r * 0.7, p.y - n.y * r * 0.7, p.x + n.x * r * 0.7, p.y + n.y * r * 0.7]
  return (
    <Group>
      {/* the gaps are most of the row; this makes all of it grabbable */}
      <KLine points={[a.x, a.y, b.x, b.y]} stroke="rgba(0,0,0,0)" strokeWidth={1} hitStrokeWidth={Math.max(ballMm, minHit)} />
      {selected && (
        <KLine
          points={[L.start.x, L.start.y, L.end.x, L.end.y]}
          stroke="#FFD166"
          strokeWidth={sw * 2.4}
          dash={[ballMm * 0.32, ballMm * 0.2]}
          lineCap="round"
          listening={false}
        />
      )}
      {/* the dashes are only the part no whole ball fills: through the ghosts
          they would run across the numbers */}
      {Math.hypot(L.end.x - rest.x, L.end.y - rest.y) > 1 && (
        <KLine
          points={[rest.x, rest.y, L.end.x, L.end.y]}
          stroke={color}
          strokeWidth={sw * 0.8}
          dash={[ballMm * 0.18, ballMm * 0.12]}
          opacity={0.75}
          listening={false}
        />
      )}
      <KLine points={tick(L.start)} stroke={color} strokeWidth={sw} lineCap="round" opacity={0.9} listening={false} />
      <KLine points={tick(L.end)} stroke={color} strokeWidth={sw} lineCap="round" opacity={0.9} listening={false} />
      {L.ghosts.map((g, i) => (
        <Group key={i} x={g.x} y={g.y} name="measure-ghost">
          <Circle radius={r - sw / 2} fill={color} opacity={fill ? 0.88 : 0.14} />
          <Circle radius={r - sw / 2} stroke={color} strokeWidth={sw} opacity={0.9} listening={false} />
          <Text
            text={String(i + 1)}
            fontSize={numFs}
            fontFamily={CANVAS_FONT}
            fontStyle="bold"
            fill={fill ? figureOn(color) : color}
            opacity={0.9}
            width={ballMm}
            align="center"
            offsetX={ballMm / 2}
            offsetY={numFs / 2}
            rotation={counter}
            listening={false}
          />
        </Group>
      ))}
      {label && (
        <Text
          name="measure-label"
          x={at.x}
          y={at.y}
          text={text}
          fontSize={fs}
          fontFamily={CANVAS_FONT}
          fontStyle="bold"
          fill={color}
          width={textW}
          align="center"
          offsetX={textW / 2}
          offsetY={fs / 2}
          rotation={counter}
          shadowColor="rgba(0,0,0,0.55)"
          shadowBlur={fs * 0.22}
          shadowForStrokeEnabled={false}
          listening={false}
        />
      )}
    </Group>
  )
}
