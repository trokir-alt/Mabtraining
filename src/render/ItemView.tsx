/**
 * Dispatches one scene item to its renderer.
 *
 * This is the only place that has to grow when a stage adds an object type:
 * add a branch here and a component next to the others. Every non-ball item
 * lives in a Group at (0,0) whose drag offset the parent reads as a delta and
 * folds back into the item's millimetres.
 */

import { Circle, Group } from 'react-konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { Game, Item, MeasureItem } from '../model/types'
import { BallShape } from './BallShape'
import {
  ArrowShape,
  GhostBallShape,
  GhostTrailShape,
  LineShape,
  MeasureShape,
  PowerShape,
  StrikePointShape,
  TextShape,
  ZoneShape,
} from './shapes'
import { useStore } from '../state/store'
import { useView } from '../state/view'
import { lineHitPx } from './hit'

export type ItemViewProps = {
  item: Item
  ballMm: number
  /** decides how a ball and the strike widget are coloured */
  game: Game
  selected: boolean
  draggable: boolean
  onSelect: (e: KonvaEventObject<MouseEvent | TouchEvent>) => void
  onDragStart: (e: KonvaEventObject<DragEvent>) => void
  onDragMove: (e: KonvaEventObject<DragEvent>) => void
  onDragEnd: (e: KonvaEventObject<DragEvent>) => void
  onEdit?: (e: KonvaEventObject<MouseEvent | TouchEvent>) => void
}

function inner(item: Item, ballMm: number, game: Game, selected: boolean, scale: number) {
  const st = useStore.getState
  switch (item.type) {
    case 'strikePoint':
      return (
        <StrikePointShape
          item={item}
          game={game}
          scale={scale}
          magnet={st().snap}
          onDotStart={() => st().beginHistory()}
          onDot={(dot) => st().updateItemLive(item.id, { dot })}
          onCompanionStart={() => st().beginHistory()}
          onCompanion={(side, fullness) => st().updateItemLive(item.id, { companion: { side, fullness } })}
        />
      )
    case 'power':
      return (
        <PowerShape
          item={item}
          selected={selected}
          onValue={(value) => st().setPower(item.id, value)}
          onStep={(steps) => st().adjustPower(item.id, steps)}
        />
      )
    case 'arrow':
      return <ArrowShape item={item} minHit={lineHitPx() / scale} />
    case 'ghostTrail':
      return <GhostTrailShape item={item} ballMm={ballMm} minHit={lineHitPx() / scale} />
    case 'zone':
      return <ZoneShape item={item} />
    case 'line':
      return <LineShape item={item} minHit={lineHitPx() / scale} />
    case 'text':
      return <TextShape item={item} />
    default:
      return null
  }
}

/** one coordinate of a ball by id, NaN once it is gone: a primitive, so the
    selector below never hands zustand a fresh object to re-render on */
const coord = (items: Item[], id: string, axis: 'x' | 'y'): number => {
  const it = items.find((i) => i.id === id)
  return it && (it.type === 'ball' || it.type === 'ghostBall') ? it[axis] : NaN
}

/**
 * A ruler reads its balls straight from the store, so it follows a ball
 * frame by frame while the ball is dragged and nothing else re-renders.
 */
function MeasureView({ item, ballMm, selected }: { item: MeasureItem; ballMm: number; selected: boolean }) {
  const ax = useStore((s) => coord(s.scene.items, item.a, 'x'))
  const ay = useStore((s) => coord(s.scene.items, item.a, 'y'))
  const bx = useStore((s) => coord(s.scene.items, item.b, 'x'))
  const by = useStore((s) => coord(s.scene.items, item.b, 'y'))
  const lengthMm = useStore((s) => s.scene.table.lengthMm)
  const widthMm = useStore((s) => s.scene.table.widthMm)
  const rotation = useView((s) => s.layout?.rotation ?? 0)
  const scale = useView((s) => s.layout?.scale ?? 0.3)
  if (![ax, ay, bx, by].every(Number.isFinite)) return null
  return (
    <MeasureShape
      a={{ x: ax, y: ay }}
      b={{ x: bx, y: by }}
      ballMm={ballMm}
      color={item.color}
      label={item.label}
      selected={selected}
      counter={-rotation}
      toward={{ x: lengthMm / 2, y: widthMm / 2 }}
      scale={scale}
      fill={item.fill === true}
      minHit={lineHitPx() / scale}
    />
  )
}

export function ItemView({ item, ballMm, game, onEdit, ...rest }: ItemViewProps) {
  const scale = useView((s) => s.layout?.scale ?? 0.3)
  if (item.type === 'ball') return <BallShape item={item} ballMm={ballMm} game={game} scale={scale} {...rest} />
  const { selected, ...handlers } = rest
  // a ruler is not dragged: it goes where its balls go
  if (item.type === 'measure') {
    return (
      <Group id={item.id} name="measure" onMouseDown={handlers.onSelect} onTouchStart={handlers.onSelect}>
        <MeasureView item={item} ballMm={ballMm} selected={selected} />
      </Group>
    )
  }
  // the wireframe ball is positioned like a real ball, so the stage can clamp
  // and contact-snap it from the node's own coordinates
  if (item.type === 'ghostBall') {
    return (
      <Group
        id={item.id}
        name="ghostBall"
        x={item.x}
        y={item.y}
        draggable={handlers.draggable}
        onMouseDown={handlers.onSelect}
        onTouchStart={handlers.onSelect}
        onDragStart={handlers.onDragStart}
        onDragMove={handlers.onDragMove}
        onDragEnd={handlers.onDragEnd}
      >
        <Circle radius={Math.max(ballMm / 2, 22 / scale)} fill="rgba(0,0,0,0)" />
        <GhostBallShape item={{ ...item, x: 0, y: 0 }} ballMm={ballMm} />
        {selected && (
          <Circle radius={ballMm / 2 + 9} stroke="#FFD166" strokeWidth={5} dash={[22, 14]} listening={false} />
        )}
      </Group>
    )
  }
  return (
    <Group
      id={item.id}
      name={item.type}
      draggable={handlers.draggable}
      onMouseDown={handlers.onSelect}
      onTouchStart={handlers.onSelect}
      onDragStart={handlers.onDragStart}
      onDragMove={handlers.onDragMove}
      onDragEnd={handlers.onDragEnd}
      onDblClick={onEdit}
      onDblTap={onEdit}
    >
      {inner(item, ballMm, game, selected, scale)}
    </Group>
  )
}
