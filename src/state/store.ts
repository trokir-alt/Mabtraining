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
import { anchorAt, ghostCentre, pruneMeasures, settleEnd, snapToMeasures, snapWithMeasures } from '../model/measure'
import { expandGroups, movedCopies, normalizeGroups, turnedCopies, unionBounds } from '../model/group'
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
  /**
   * Everything selected: one object, a whole group, or several picked
   * together. `selectedId` is that one object when there is exactly one, and
   * null otherwise - the properties of a single object are edited through it.
   */
  selectedId: string | null
  selection: string[]
  /** a ghost of a ruler's row the coach tapped: what «Заменить на» acts on */
  pickedGhost: { measure: string; index: number } | null
  /** «Выбрать несколько»: a tap puts an object in the selection or takes it out */
  multiMode: boolean
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
  /** select one object - or, if it is in a group, the whole group */
  select: (id: string | null) => void
  /** select these, with their groups; `add` keeps what was selected already */
  selectMany: (ids: string[], add?: boolean) => void
  /** in or out of the selection, with its group */
  toggleSelect: (id: string) => void
  setMultiMode: (on: boolean) => void
  /** select a ruler with one ghost of its row picked */
  pickGhost: (measureId: string, index: number) => void

  /* ---- editing ---- */
  addBall: (kind: BallKind, at?: Vec) => void
  /** a pool ball's number, or 'cue' to make it the cue ball */
  setBallNumber: (id: string, number: number | 'cue') => void
  /** a zone lands at the bottom, a widget just under the captions */
  addItem: (item: Item, placement?: Placement) => void
  /** a ruler, with the ghosts it made for its free ends, as one undo step */
  addMeasure: (measure: MeasureItem, ghosts: GhostBallItem[]) => void
  /** a real ball exactly where a ghost of a ruler's row stood */
  replaceGhost: (measureId: string, index: number, kind: 'white' | 'cue') => void
  /** a wireframe ball made real, keeping its id so its rulers stay on it */
  ghostBallToBall: (id: string, kind: 'white' | 'cue') => void
  groupSelection: () => void
  ungroupSelection: () => void
  /** a frame of a drag of several objects, from where `snapshot` had them; no history */
  moveSelectionLive: (snapshot: Item[], dx: number, dy: number) => void
  /** the drop: the same, then balls pushed off any they landed on */
  moveSelectionEnd: (snapshot: Item[], dx: number, dy: number) => void
  /** a frame of a turn about `c`, from where `snapshot` had them; no history */
  rotateSelectionLive: (snapshot: Item[], c: Vec, deg: number) => void
  /** the end of the turn: balls kept on the cloth and off the others */
  rotateSelectionEnd: (snapshot: Item[], c: Vec, deg: number) => void
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

    /** the one place the selection is set: `selectedId` follows it */
    const setSel = (s: AppState, ids: string[]) => {
      s.selection = ids
      s.selectedId = ids.length === 1 ? ids[0] : null
      s.pickedGhost = null
      if (ids.length === 0) s.multiMode = false
    }

    /** the same objects, replaced by these copies of them */
    const putAll = (s: AppState, copies: Item[]) => {
      const byId = new Map(copies.map((c) => [c.id, c]))
      s.scene.items = s.scene.items.map((it) => byId.get(it.id) ?? it)
    }

    /** a move cut short where it would take any of the balls off the cloth */
    const fitDelta = (snapshot: Item[], dx: number, dy: number) => {
      const g = geom()
      const D = get().scene.table.ballMm
      let ox = dx
      let oy = dy
      for (let pass = 0; pass < 2; pass++) {
        for (const it of snapshot) {
          if (it.type !== 'ball' && it.type !== 'ghostBall') continue
          const want = { x: it.x + ox, y: it.y + oy }
          const c = clampToField(g, want, D)
          ox += c.x - want.x
          oy += c.y - want.y
        }
      }
      return { dx: ox, dy: oy }
    }

    /**
     * After a group lands: every ball on the cloth, and - with «Без
     * наложения» - off the balls outside the group it came down on.
     */
    const settleSelectionBalls = (ids: string[]) => {
      const g = geom()
      const { noOverlap } = get()
      set((s) => {
        const D = s.scene.table.ballMm
        for (const id of ids) {
          const i = s.scene.items.findIndex((it) => it.id === id)
          const it = s.scene.items[i]
          if (!it || (it.type !== 'ball' && it.type !== 'ghostBall')) continue
          let p = clampToField(g, { x: it.x, y: it.y }, D)
          if (it.type === 'ball') p = resolveOverlap(g, s.scene.items, id, p, D, noOverlap)
          s.scene.items[i] = { ...it, x: p.x, y: p.y }
        }
      })
    }

    return {
      scene: initialScene(),
      selectedId: null,
      selection: [],
      pickedGhost: null,
      multiMode: false,
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
          if (tool !== 'select') setSel(s, [])
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
          setSel(s, [])
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

      select: (id) => set((s) => setSel(s, id ? expandGroups(s.scene.items, [id]) : [])),
      selectMany: (ids, add = false) =>
        set((s) => setSel(s, expandGroups(s.scene.items, add ? [...s.selection, ...ids] : ids))),
      toggleSelect: (id) =>
        set((s) => {
          const members = expandGroups(s.scene.items, [id])
          const next = s.selection.includes(id)
            ? s.selection.filter((x) => !members.includes(x))
            : expandGroups(s.scene.items, [...s.selection, ...members])
          const multi = s.multiMode
          setSel(s, next)
          if (next.length) s.multiMode = multi
        }),
      setMultiMode: (on) => set((s) => void (s.multiMode = on)),
      pickGhost: (measureId, index) =>
        set((s) => {
          setSel(s, [measureId])
          s.pickedGhost = { measure: measureId, index }
        }),

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
          setSel(s, [ball.id])
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
          setSel(s, [item.id])
        }),

      addMeasure: (measure, ghosts) =>
        edit((s) => {
          s.scene.items.unshift(measure)
          // a ghost is drawn over the balls, like one put down by hand
          s.scene.items.push(...ghosts)
          setSel(s, [measure.id])
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
        const { selectedId, selection, scene, noOverlap } = get()
        if (selection.length > 1) {
          // several at once: all of them by the same step, as one undo
          const snap = scene.items.filter((i) => selection.includes(i.id))
          const d = fitDelta(snap, dx, dy)
          edit((s) => putAll(s, movedCopies(snap, d.dx, d.dy)))
          return
        }
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
        const { selection } = get()
        if (!selection.length) return
        const gone = new Set(selection)
        edit((s) => {
          // a ruler hanging on a ball goes with it, in the same undo step,
          // and a group left with one member is no group
          s.scene.items = normalizeGroups(pruneMeasures(s.scene.items.filter((i) => !gone.has(i.id))))
          setSel(s, [])
        })
      },

      duplicateSelected: () => {
        const { selection, scene } = get()
        const picked = scene.items.filter((i) => selection.includes(i.id))
        const ids = new Set(picked.map((i) => i.id))
        // a copy of a ruler would lie exactly on the original unless its two
        // balls are copied with it
        const take = picked.filter((i) => i.type !== 'measure' || (ids.has(i.a) && ids.has(i.b)))
        if (!take.length) return
        // 90 mm clears a ball but not a 600 mm pair of magnified ones: a copy
        // landing on top of its original reads as a rendering fault
        const b = unionBounds(scene.items, take.map((i) => i.id), scene.table.ballMm) ?? itemBounds(take[0], scene.table.ballMm)
        const off = Math.max(90, Math.round(Math.max(b.w, b.h) * 0.25))
        const idOf = new Map(take.map((i) => [i.id, newId(i.type)]))
        const groupOf = new Map<string, string>()
        const copies = take.map((i) => {
          let c = { ...translateItem(i, off, off), id: idOf.get(i.id) as string } as Item
          // the copy of a group is a group of its own
          if (i.group) {
            if (!groupOf.has(i.group)) groupOf.set(i.group, newId('group'))
            c = { ...c, group: groupOf.get(i.group) }
          }
          if (c.type === 'measure') c = { ...c, a: idOf.get(c.a) as string, b: idOf.get(c.b) as string }
          // a ruler's ghost belongs to the copied ruler, or to none
          if (c.type === 'ghostBall' && c.owner) c = { ...c, owner: idOf.get(c.owner) }
          return c
        })
        edit((s) => {
          // rulers lie under everything, the rest on top, as when drawn
          s.scene.items.unshift(...copies.filter((c) => c.type === 'measure'))
          s.scene.items.push(...copies.filter((c) => c.type !== 'measure'))
          s.scene.items = normalizeGroups(s.scene.items)
          setSel(s, copies.map((c) => c.id))
        })
      },

      groupSelection: () => {
        const { selection } = get()
        if (selection.length < 2) return
        const g = newId('group')
        edit((s) => {
          s.scene.items = s.scene.items.map((it) => (selection.includes(it.id) ? { ...it, group: g } : it))
          s.selection = [...selection]
        })
      },

      ungroupSelection: () => {
        const { selection, scene } = get()
        if (!scene.items.some((i) => selection.includes(i.id) && i.group)) return
        edit((s) => {
          s.scene.items = s.scene.items.map((it) => {
            if (!selection.includes(it.id) || !it.group) return it
            const { group: _g, ...rest } = it
            void _g
            return rest as Item
          })
          s.selection = [...selection]
        })
      },

      moveSelectionLive: (snapshot, dx, dy) => {
        const d = fitDelta(snapshot, dx, dy)
        set((s) => putAll(s, movedCopies(snapshot, d.dx, d.dy)))
      },

      moveSelectionEnd: (snapshot, dx, dy) => {
        get().moveSelectionLive(snapshot, dx, dy)
        settleSelectionBalls(snapshot.map((i) => i.id))
      },

      rotateSelectionLive: (snapshot, c, deg) => set((s) => putAll(s, turnedCopies(snapshot, c, deg))),

      rotateSelectionEnd: (snapshot, c, deg) => {
        get().rotateSelectionLive(snapshot, c, deg)
        settleSelectionBalls(snapshot.map((i) => i.id))
      },

      replaceGhost: (measureId, index, kind) => {
        const { scene } = get()
        const m = scene.items.find((i): i is MeasureItem => i.id === measureId && i.type === 'measure')
        const at = m ? ghostCentre(m, scene.items, scene.table.ballMm, index) : null
        if (!at) return
        const ball: BallItem = { id: newId('ball'), type: 'ball', x: at.x, y: at.y, kind }
        if (kind !== 'cue' && isPool(scene.table)) ball.number = nextPoolNumber(scene.items)
        edit((s) => {
          s.scene.items.push(ball)
          setSel(s, [ball.id])
        })
      },

      ghostBallToBall: (id, kind) => {
        const { scene } = get()
        const i = scene.items.findIndex((it) => it.id === id && it.type === 'ghostBall')
        const ghost = scene.items[i]
        if (!ghost || ghost.type !== 'ghostBall') return
        // the same id: the rulers hanging on it stay on it, now a real ball
        const ball: BallItem = { id, type: 'ball', x: ghost.x, y: ghost.y, kind, ...(ghost.group ? { group: ghost.group } : {}) }
        if (kind !== 'cue' && isPool(scene.table)) ball.number = nextPoolNumber(scene.items)
        edit((s) => {
          s.scene.items[i] = ball
          setSel(s, [id])
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
          setSel(s, [])
        })
      },

      newExercise: () =>
        edit((s) => {
          s.scene.items = []
          s.scene.title = undefined
          s.scene.note = undefined
          setSel(s, [])
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
          s.scene.items = normalizeGroups(pruneMeasures([...s.scene.items.filter((i) => i.type !== 'ball'), ...balls]))
          setSel(s, [])
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
          s.scene.items = normalizeGroups(pruneMeasures([...s.scene.items.filter((i) => i.type !== 'ball'), ...balls]))
          setSel(s, [])
        })
      },

      replaceScene: (scene) =>
        edit((s) => {
          s.scene = scene
          setSel(s, [])
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
          setSel(s, [])
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
          setSel(s, [])
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
