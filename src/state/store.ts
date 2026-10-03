/**
 * Scene store: zustand + immer, with an undo/redo stack of whole-scene
 * snapshots capped at 50 (spec section 3).
 *
 * Because the immer middleware freezes state and shares structure, a snapshot
 * is just the previous `scene` reference - cheap to keep and cheap to restore.
 * One user action is one snapshot: a drag pushes once on dragstart and then
 * writes without history until it ends.
 */

import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  ArrowHead,
  BallItem,
  BallKind,
  ClothColor,
  Game,
  GhostBallItem,
  Item,
  MeasureItem,
  Orientation,
  PowerValue,
  Scene,
  StrokeStyle,
  Vec,
} from '../model/types'
import { POWER_VALUES } from '../model/types'
import { DEFAULT_TABLE, buildGeometry, clampToField } from '../model/table'
import {
  DEFAULT_FULLNESS,
  clampFullness,
  itemBounds,
  strikeRange,
  translateItem,
  type CompanionSide,
} from '../model/item'
import { gameOf, isPool, scaledPreset } from '../model/game'
import { convertScene, nextPoolNumber } from '../model/convert'
import { anchorAt, pruneMeasures, settleEnd, snapToMeasures, snapWithMeasures } from '../model/measure'
import {
  DEFAULT_HEAD,
  DEFAULT_INK,
  DEFAULT_STROKE_WIDTH,
  DEFAULT_STYLE,
  DEFAULT_TEXT_SIZE,
  GHOST_MAX,
  GHOST_MIN,
  ghostCount,
} from '../model/style'
import {
  freeSpot,
  housePoint,
  newId,
  poolRackBalls,
  pyramidBalls,
  resolveOverlap,
  snapPoint,
  snapTouch,
  type PoolRack,
} from '../lib/place'
import { loadDensity, loadScene, saveDensity } from '../lib/storage'
import type { Density } from '../brand/watermark'
import { DEFAULT_DENSITY } from '../brand/watermark'

export const HISTORY_LIMIT = 50

/** Every tool the coach can pick. Stage 3 adds 'strike' here and nowhere else. */
export type Tool =
  | 'select'
  | 'ball-white'
  | 'ball-cue'
  | 'arrow'
  | 'ghost'
  | 'zone-rect'
  | 'zone-ellipse'
  | 'line'
  | 'text'
  | 'strike'
  | 'power'
  | 'ghost-ball'
  | 'measure'

/** where a new object lands in the z-order */
export type Placement = 'top' | 'bottom' | 'belowText'

/** tools that are drawn with one press-drag-release gesture */
export const DRAG_TOOLS: Tool[] = ['arrow', 'ghost', 'zone-rect', 'zone-ellipse', 'line']

/**
 * Style carried from one object to the next, so a run of arrows matches.
 *
 * `width` and `textSize` are REFERENCE values - one of STROKE_WIDTHS and
 * TEXT_SIZES, the pyramid's millimetres. The coach chose "thin" or "large",
 * not a number of millimetres, and that choice has to mean the same on
 * either table; what is drawn is `scaledPreset(value, table)`.
 */
export type DraftStyle = {
  ink: string
  width: number
  style: StrokeStyle
  head: ArrowHead
  textSize: number
}

export type AppState = {
  scene: Scene
  selectedId: string | null
  tool: Tool
  draft: DraftStyle
  orientation: Orientation
  orientationAuto: boolean
  snap: boolean
  noOverlap: boolean
  /** how many signatures the cloth carries; a screen setting, not scene data */
  watermarkDensity: Density
  past: Scene[]
  future: Scene[]

  /* ---- tools & view ---- */
  setTool: (tool: Tool) => void
  setOrientation: (o: Orientation) => void
  autoOrientation: (o: Orientation) => void
  setWatermarkDensity: (d: Density) => void
  toggleSnap: () => void
  toggleNoOverlap: () => void
  toggleMarkings: () => void
  setCloth: (cloth: ClothColor) => void
  setBallMm: (mm: number) => void
  /** the whole exercise moves to the other table, as one undo */
  setGame: (game: Game) => void

  /* ---- draft style ---- */
  setInk: (color: string) => void
  setWidth: (mm: number) => void
  setStyle: (style: StrokeStyle) => void
  setHead: (head: ArrowHead) => void
  setTextSize: (mm: number) => void

  /* ---- selection ---- */
  select: (id: string | null) => void

  /* ---- editing ---- */
  addBall: (kind: BallKind, at?: Vec) => void
  /** a pool ball's number, or 'cue' to make it the cue ball */
  setBallNumber: (id: string, number: number | 'cue') => void
  /** a zone lands at the bottom, a widget just under the captions */
  addItem: (item: Item, placement?: Placement) => void
  /** a ruler, with the ghosts it made for its free ends, as one undo step */
  addMeasure: (measure: MeasureItem, ghosts: GhostBallItem[]) => void
  /**
   * wireframe ball: clamp and contact-snap, never push-apart. One at the end
   * of a ruler snaps to a pocket, a spot or a cushion within `reachMm`
   * instead, and otherwise to a whole number of balls.
   */
  dragGhostBallTo: (id: string, at: Vec, reachMm?: number) => void
  setPower: (id: string, value: PowerValue) => void
  adjustPower: (id: string, steps: number) => void
  resetDot: (id: string) => void
  /** add, move or remove the object ball behind the widget; null removes it */
  setCompanion: (id: string, side: CompanionSide | null, fullness?: number) => void
  /** put it on the other side of the widget */
  flipCompanion: (id: string) => void
  /** how full the hit is: 1 a full ball, 0.5 a half ball, 0 the thinnest */
  setFullness: (id: string, fullness: number) => void
  setStrikeSize: (id: string, mm: number) => void
  /** one history entry; for property changes and finished edits */
  updateItem: (id: string, patch: Partial<Item>) => void
  /** no history entry; for the frames of a drag */
  updateItemLive: (id: string, patch: Partial<Item>) => void
  moveItemBy: (id: string, dx: number, dy: number) => void
  dragItemTo: (id: string, at: Vec) => void
  nudgeSelected: (dx: number, dy: number) => void
  removeSelected: () => void
  duplicateSelected: () => void
  bringToFront: (id: string) => void
  sendToBack: (id: string) => void
  adjustGhostCount: (id: string, delta: number) => void
  clear: () => void
  newExercise: () => void
  rackPyramid: () => void
  rackPool: (rack: PoolRack) => void
  replaceScene: (scene: Scene) => void

  /* ---- exercise ---- */
  setTitle: (title: string) => void
  setNote: (note: string) => void

  /* ---- history ---- */
  beginHistory: () => void
  undo: () => void
  redo: () => void
}

/** the saved density, or the default if storage is empty or unreadable */
const initialDensity = (): Density => {
  try {
    return loadDensity()
  } catch {
    return DEFAULT_DENSITY
  }
}

const emptyScene = (): Scene => ({
  version: 1,
  table: { ...DEFAULT_TABLE },
  items: [],
})

/** a saved scene if there is a good one, otherwise a clean table */
const initialScene = (): Scene => {
  try {
    return loadScene() ?? emptyScene()
  } catch {
    return emptyScene()
  }
}

export const useStore = create<AppState>()(
  immer((set, get) => {
    /** push the current scene onto the undo stack and drop the redo stack */
    const beginHistory = () => {
      const { scene, past } = get()
      const trimmed =
        past.length >= HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT + 1) : past.slice()
      trimmed.push(scene)
      set((s) => {
        s.past = trimmed
        s.future = []
      })
    }

    /** every mutation that should be undoable goes through here */
    const edit = (recipe: (s: AppState) => void) => {
      beginHistory()
      set(recipe)
    }

    const geom = () => buildGeometry(get().scene.table)

    const patchItem = (s: AppState, id: string, patch: Partial<Item>) => {
      const i = s.scene.items.findIndex((it) => it.id === id)
      if (i === -1) return
      s.scene.items[i] = { ...s.scene.items[i], ...patch } as Item
    }

    return {
      scene: initialScene(),
      selectedId: null,
      tool: 'select',
      draft: {
        ink: DEFAULT_INK,
        width: DEFAULT_STROKE_WIDTH,
        style: DEFAULT_STYLE,
        head: DEFAULT_HEAD,
        textSize: DEFAULT_TEXT_SIZE,
      },
      orientation: 'horizontal',
      orientationAuto: true,
      snap: true,
      noOverlap: true,
      watermarkDensity: initialDensity(),
      past: [],
      future: [],

      setTool: (tool) =>
        set((s) => {
          s.tool = tool
          if (tool !== 'select') s.selectedId = null
        }),
      setOrientation: (o) =>
        set((s) => {
          s.orientation = o
          s.orientationAuto = false
        }),
      autoOrientation: (o) =>
        set((s) => {
          if (s.orientationAuto) s.orientation = o
        }),
      setWatermarkDensity: (d) => {
        saveDensity(d)
        set((s) => void (s.watermarkDensity = d))
      },
      toggleSnap: () => set((s) => void (s.snap = !s.snap)),
      toggleNoOverlap: () => set((s) => void (s.noOverlap = !s.noOverlap)),

      toggleMarkings: () =>
        edit((s) => {
          s.scene.table.markings = !s.scene.table.markings
        }),
      setCloth: (cloth) =>
        edit((s) => {
          s.scene.table.cloth = cloth
        }),
      setBallMm: (mm) => {
        // pool is played with one ball; the size is the game's, not a setting
        if (isPool(get().scene.table)) return
        edit((s) => {
          s.scene.table.ballMm = mm
        })
      },
      setGame: (game) => {
        const { scene } = get()
        if (gameOf(scene.table) === game) return
        const next = convertScene(scene, game)
        edit((s) => {
          s.scene = next
          s.selectedId = null
        })
      },

      /* the draft style also retargets the current selection, which is what a
         coach means by picking a colour while something is selected */
      setInk: (color) => {
        set((s) => void (s.draft.ink = color))
        const id = get().selectedId
        if (id) get().updateItem(id, { color } as Partial<Item>)
      },
      setWidth: (mm) => {
        set((s) => void (s.draft.width = mm))
        const id = get().selectedId
        if (id) get().updateItem(id, { width: scaledPreset(mm, get().scene.table) } as Partial<Item>)
      },
      setStyle: (style) => {
        set((s) => void (s.draft.style = style))
        const id = get().selectedId
        if (id) get().updateItem(id, { style } as Partial<Item>)
      },
      setHead: (head) => {
        set((s) => void (s.draft.head = head))
        const id = get().selectedId
        if (!id) return
        const item = get().scene.items.find((i) => i.id === id)
        if (item?.type === 'ghostTrail') get().updateItem(id, { head: head !== 'none' } as Partial<Item>)
        else if (item?.type === 'arrow') get().updateItem(id, { head } as Partial<Item>)
      },
      setTextSize: (mm) => {
        set((s) => void (s.draft.textSize = mm))
        const id = get().selectedId
        if (id) get().updateItem(id, { size: scaledPreset(mm, get().scene.table) } as Partial<Item>)
      },

      select: (id) => set((s) => void (s.selectedId = id)),

      addBall: (kind, at) => {
        const g = geom()
        const { scene, noOverlap } = get()
        const ballMm = scene.table.ballMm
        const wanted = at ?? { x: g.lengthMm / 2, y: g.widthMm / 2 }
        const p = freeSpot(g, scene.items, ballMm, clampToField(g, wanted, ballMm), noOverlap)
        const ball: BallItem = { id: newId('ball'), type: 'ball', x: p.x, y: p.y, kind }
        // on a pool table an object ball is a numbered ball, and the next one
        // out of the box is the lowest number not already on the table
        if (kind !== 'cue' && isPool(scene.table)) ball.number = nextPoolNumber(scene.items)
        edit((s) => {
          s.scene.items.push(ball)
          s.selectedId = ball.id
        })
      },

      setBallNumber: (id, number) => {
        const item = get().scene.items.find((i) => i.id === id)
        if (!item || item.type !== 'ball') return
        if (number === 'cue') {
          if (item.kind !== 'cue') get().updateItem(id, { kind: 'cue' } as Partial<Item>)
          return
        }
        if (!Number.isInteger(number) || number < 1 || number > 15) return
        if (item.kind !== 'cue' && item.number === number) return
        get().updateItem(id, { kind: 'white', number } as Partial<Item>)
      },

      addItem: (item, placement = 'top') =>
        edit((s) => {
          if (placement === 'bottom') s.scene.items.unshift(item)
          else if (placement === 'belowText') {
            // above balls and arrows, below captions
            const i = s.scene.items.findIndex((it) => it.type === 'text')
            if (i === -1) s.scene.items.push(item)
            else s.scene.items.splice(i, 0, item)
          } else s.scene.items.push(item)
          s.selectedId = item.id
        }),

      addMeasure: (measure, ghosts) =>
        edit((s) => {
          s.scene.items.unshift(measure)
          // a ghost is drawn over the balls, like one put down by hand
          s.scene.items.push(...ghosts)
          s.selectedId = measure.id
        }),

      dragGhostBallTo: (id, at, reachMm = 40) => {
        const g = geom()
        const { scene, snap } = get()
        const ballMm = scene.table.ballMm
        const ruler = scene.items.find((i): i is MeasureItem => i.type === 'measure' && (i.a === id || i.b === id))
        if (ruler) {
          // the end of a ruler: it marks a pocket, a spot or the cushion, or
          // a whole number of balls - not a contact with some other ball
          let p = clampToField(g, at, ballMm)
          if (snap) {
            const other = anchorAt(scene.items, ruler.a === id ? ruler.b : ruler.a)
            const end = settleEnd(g, p, other, ballMm, reachMm)
            p = end.kind !== 'free' ? end.at : clampToField(g, snapToMeasures(scene.items, id, p, ballMm), ballMm)
          }
          set((s) => patchItem(s, id, { x: p.x, y: p.y } as Partial<Item>))
          return
        }
        let p = clampToField(g, at, ballMm)
        p = snapTouch(scene.items, id, p, ballMm)
        if (snap) p = clampToField(g, snapPoint(g, p, true), ballMm)
        set((s) => patchItem(s, id, { x: p.x, y: p.y } as Partial<Item>))
      },

      setPower: (id, value) => {
        if (!(POWER_VALUES as readonly number[]).includes(value)) return
        get().updateItem(id, { value } as Partial<Item>)
      },

      adjustPower: (id, steps) => {
        const item = get().scene.items.find((i) => i.id === id)
        if (!item || item.type !== 'power') return
        const i = POWER_VALUES.indexOf(item.value)
        const j = Math.min(POWER_VALUES.length - 1, Math.max(0, i + steps))
        if (j !== i) get().updateItem(id, { value: POWER_VALUES[j] } as Partial<Item>)
      },

      resetDot: (id) => get().updateItem(id, { dot: { u: 0, v: 0 } } as Partial<Item>),

      setCompanion: (id, side, fullness) => {
        const item = get().scene.items.find((i) => i.id === id)
        if (!item || item.type !== 'strikePoint') return
        get().updateItem(id, {
          companion:
            side === null
              ? undefined
              : { side, fullness: clampFullness(fullness ?? item.companion?.fullness ?? DEFAULT_FULLNESS) },
        } as Partial<Item>)
      },

      setFullness: (id, fullness) => {
        const item = get().scene.items.find((i) => i.id === id)
        if (!item || item.type !== 'strikePoint' || !item.companion) return
        get().updateItem(id, {
          companion: { side: item.companion.side, fullness: clampFullness(fullness) },
        } as Partial<Item>)
      },

      flipCompanion: (id) => {
        const item = get().scene.items.find((i) => i.id === id)
        if (!item || item.type !== 'strikePoint' || !item.companion) return
        get().updateItem(id, {
          companion: { side: item.companion.side === 'left' ? 'right' : 'left', fullness: item.companion.fullness },
        } as Partial<Item>)
      },

      setStrikeSize: (id, mm) => {
        const [lo, hi] = strikeRange(get().scene.table)
        get().updateItem(id, { sizeMm: Math.round(Math.min(hi, Math.max(lo, mm))) } as Partial<Item>)
      },

      updateItem: (id, patch) => edit((s) => patchItem(s, id, patch)),
      updateItemLive: (id, patch) => set((s) => patchItem(s, id, patch)),

      moveItemBy: (id, dx, dy) =>
        set((s) => {
          const i = s.scene.items.findIndex((it) => it.id === id)
          if (i === -1) return
          s.scene.items[i] = translateItem(s.scene.items[i], dx, dy)
        }),

      dragItemTo: (id, at) => {
        const g = geom()
        const { scene, snap, noOverlap } = get()
        const ballMm = scene.table.ballMm
        const item = scene.items.find((i) => i.id === id)
        if (!item || item.type !== 'ball') return
        const raw = clampToField(g, at, ballMm)
        const grid = clampToField(g, snapPoint(g, raw, snap), ballMm)
        let p = snap ? clampToField(g, snapWithMeasures(scene.items, id, raw, grid, ballMm), ballMm) : grid
        p = resolveOverlap(g, scene.items, id, p, ballMm, noOverlap)
        set((s) => patchItem(s, id, { x: p.x, y: p.y } as Partial<Item>))
      },

      nudgeSelected: (dx, dy) => {
        const { selectedId, scene, noOverlap } = get()
        if (!selectedId) return
        const item = scene.items.find((i) => i.id === selectedId)
        // a ruler goes where its balls go; nudging it alone would be a no-op
        // with an undo step attached
        if (!item || item.type === 'measure') return
        if (item.type === 'ball') {
          const g = geom()
          const ballMm = scene.table.ballMm
          let p = clampToField(g, { x: item.x + dx, y: item.y + dy }, ballMm)
          p = resolveOverlap(g, scene.items, selectedId, p, ballMm, noOverlap)
          edit((s) => patchItem(s, selectedId, { x: p.x, y: p.y } as Partial<Item>))
          return
        }
        edit((s) => {
          const i = s.scene.items.findIndex((it) => it.id === selectedId)
          if (i !== -1) s.scene.items[i] = translateItem(s.scene.items[i], dx, dy)
        })
      },

      removeSelected: () => {
        const { selectedId } = get()
        if (!selectedId) return
        edit((s) => {
          // a ruler hanging on the ball goes with it, in the same undo step
          s.scene.items = pruneMeasures(s.scene.items.filter((i) => i.id !== selectedId))
          s.selectedId = null
        })
      },

      duplicateSelected: () => {
        const { selectedId, scene } = get()
        const item = scene.items.find((i) => i.id === selectedId)
        // a copy of a ruler would lie exactly on the original: it is the two
        // balls that make it, and those have not been copied
        if (!item || item.type === 'measure') return
        // nor does a copy of a ruler's ghost belong to that ruler
        const own = item.type === 'ghostBall' && item.owner ? { owner: undefined } : {}
        // 90 mm clears a ball but not a 600 mm pair of magnified ones: a copy
        // landing on top of its original reads as a rendering fault
        const b = itemBounds(item, scene.table.ballMm)
        const off = Math.max(90, Math.round(Math.max(b.w, b.h) * 0.25))
        const copy = { ...translateItem(item, off, off), ...own, id: newId(item.type) } as Item
        edit((s) => {
          s.scene.items.push(copy)
          s.selectedId = copy.id
        })
      },

      bringToFront: (id) =>
        edit((s) => {
          const i = s.scene.items.findIndex((it) => it.id === id)
          if (i === -1) return
          const [it] = s.scene.items.splice(i, 1)
          s.scene.items.push(it)
        }),

      sendToBack: (id) =>
        edit((s) => {
          const i = s.scene.items.findIndex((it) => it.id === id)
          if (i === -1) return
          const [it] = s.scene.items.splice(i, 1)
          s.scene.items.unshift(it)
        }),

      adjustGhostCount: (id, delta) => {
        const item = get().scene.items.find((i) => i.id === id)
        if (!item || item.type !== 'ghostTrail') return
        const count = Math.min(GHOST_MAX, Math.max(GHOST_MIN, item.count + delta))
        get().updateItem(id, { count, autoCount: false } as Partial<Item>)
      },

      clear: () => {
        if (get().scene.items.length === 0) return
        edit((s) => {
          s.scene.items = []
          s.selectedId = null
        })
      },

      newExercise: () =>
        edit((s) => {
          s.scene.items = []
          s.scene.title = undefined
          s.scene.note = undefined
          s.selectedId = null
        }),

      rackPyramid: () => {
        const g = geom()
        const ballMm = get().scene.table.ballMm
        const balls: Item[] = pyramidBalls(g, ballMm).map((p) => ({
          id: newId('ball'),
          type: 'ball',
          x: p.x,
          y: p.y,
          kind: 'white',
        }))
        const cue = housePoint(g)
        balls.push({ id: newId('ball'), type: 'ball', x: cue.x, y: cue.y, kind: 'cue' })
        edit((s) => {
          // keep everything that is not a ball: the drawing survives a re-rack
          s.scene.items = pruneMeasures([...s.scene.items.filter((i) => i.type !== 'ball'), ...balls])
          s.selectedId = null
        })
      },

      rackPool: (rack) => {
        const g = geom()
        const ballMm = get().scene.table.ballMm
        const balls: Item[] = poolRackBalls(g, ballMm, rack).map((p) => ({
          id: newId('ball'),
          type: 'ball',
          x: p.x,
          y: p.y,
          kind: 'white',
          number: p.number,
        }))
        // the cue ball is broken from the kitchen, behind the head string
        const cue = housePoint(g)
        balls.push({ id: newId('ball'), type: 'ball', x: cue.x, y: cue.y, kind: 'cue' })
        edit((s) => {
          s.scene.items = pruneMeasures([...s.scene.items.filter((i) => i.type !== 'ball'), ...balls])
          s.selectedId = null
        })
      },

      replaceScene: (scene) =>
        edit((s) => {
          s.scene = scene
          s.selectedId = null
        }),

      setTitle: (title) =>
        set((s) => void (s.scene.title = title.trim() === '' ? undefined : title)),
      setNote: (note) => set((s) => void (s.scene.note = note.trim() === '' ? undefined : note)),

      beginHistory,

      undo: () => {
        const { past, future, scene } = get()
        if (past.length === 0) return
        const prev = past[past.length - 1]
        set((s) => {
          s.past = past.slice(0, -1)
          s.future = [...future, scene].slice(-HISTORY_LIMIT)
          s.scene = prev
          s.selectedId = null
        })
      },

      redo: () => {
        const { past, future, scene } = get()
        if (future.length === 0) return
        const next = future[future.length - 1]
        set((s) => {
          s.future = future.slice(0, -1)
          s.past = [...past, scene].slice(-HISTORY_LIMIT)
          s.scene = next
          s.selectedId = null
        })
      },
    }
  })
)

export const selectCanUndo = (s: AppState) => s.past.length > 0
export const selectCanRedo = (s: AppState) => s.future.length > 0

/** Recomputes a trail's ball count from its length, unless it was set by hand. */
export function retuneGhost(item: Item, ballMm: number): Partial<Item> | null {
  if (item.type !== 'ghostTrail' || !item.autoCount) return null
  const len = Math.hypot(item.to.x - item.from.x, item.to.y - item.from.y)
  return { count: ghostCount(len, ballMm) } as Partial<Item>
}
