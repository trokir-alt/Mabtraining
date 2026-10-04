/**
 * The canvas. Owns the Konva stage, the mm -> px transform, pointer input and
 * the keyboard shortcuts; everything it draws comes from the store.
 *
 * Creation is one gesture - press, drag, release - for every linear object,
 * because two separate taps on a tablet produce stray objects and misses. The
 * gesture lives in local state as a draft and only reaches the store when it
 * is released with a real length, so an accidental tap leaves nothing behind.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Circle, Group, Layer, Line as KLine, Rect, Stage, Text } from 'react-konva'
import Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { GhostBallItem, Item, Vec } from '../model/types'
import { buildGeometry, clampToField } from '../model/table'
import { STRIKE_DEFAULT_MM, dragHandle, defaultPowerWidth, itemAt, type Handle } from '../model/item'
import { gameOf, scaledPreset } from '../model/game'
import { DEFAULT_ZONE_COLOR, ZONE_OPACITY, ghostCount } from '../model/style'
import { newId, resolveOverlap, snapPoint } from '../lib/place'
import { findMeasure, ghostIndexAt, pickAnchor, settleEnd, snapWithMeasures } from '../model/measure'
import { itemsInside, snapAngle, unionBounds } from '../model/group'
import { itemBounds } from '../model/item'
import { SELECTION } from '../model/theme'
import { CANVAS_FONT } from '../model/fonts'
import { publishDebug } from '../lib/debug'
import { DRAG_TOOLS, retuneGhost, useStore, type Tool } from '../state/store'
import { useView } from '../state/view'
import { ItemView } from './ItemView'
import { GhostBallShape, MeasureShape } from './shapes'
import { lineHitPx } from './hit'
import { Handles } from './Handles'
import { TableView } from './TableView'
import { Watermark } from './Watermark'
import { ZOOM_MAX, ZOOM_MIN, clampPan, computeLayout, pxToMm, type StageLayout, type Viewport } from './layout'

/** below this the table is turned upright, spec section 9 */
const NARROW_PX = 860
/** a gesture shorter than this is a tap, not an object */
const MIN_GESTURE_MM = 40
/** on touch a dragged ball rides this far above the finger, so the finger
    never hides what it is placing */
const LIFT_PX = 60
/** a press this close to a ball, in screen px, starts or ends a ruler on it */
const GRAB_PX = 22
/** the free end of a ruler finds a pocket, a spot or a cushion this far off */
const END_PX = 28

/** what a tap with a placing tool lands ON rather than next to: a ball is
    not put on a ball, nor a widget on a widget */
const SOLID = new Set<Item['type']>(['ball', 'ghostBall', 'strikePoint', 'power', 'text'])

/** the selection's turning lever stands this far above it, in screen px */
const LEVER_PX = 34
/** a frame smaller than this, across, is a tap on the cloth, not a frame */
const MARQUEE_MIN_PX = 10

type Pinch = { dist: number; mid: Vec; view: Viewport }
/** a frame being drawn over the cloth to select what lies inside it */
type Marquee = { from: Vec; to: Vec; add: boolean }
/** several objects dragged as one: where the dragged node and each object began */
type MultiDrag = { start: Vec; snapshot: Item[] }
/** the selection being turned: about `c`, from the lever's angle `a0` */
type Turn = { c: Vec; a0: number; snapshot: Item[] }
type Pan = { from: Vec; view: Viewport }

/** a finger, not a mouse: the native event behind a Konva one */
function isTouch(evt: unknown): boolean {
  if (!evt || typeof evt !== 'object') return false
  const o = evt as { touches?: unknown; pointerType?: string }
  return 'touches' in o || o.pointerType === 'touch'
}

/**
 * `a` is the ball a ruler is being drawn from, if it starts on one; `press`
 * is where the finger went down, before any magnet moved it - a tap is
 * looked up there.
 */
type Draft = { tool: Tool; from: Vec; to: Vec; a?: string; press: Vec }

export type SceneStageProps = {
  stageRef: React.MutableRefObject<Konva.Stage | null>
}

export function SceneStage({ stageRef }: SceneStageProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [draft, setDraft] = useState<Draft | null>(null)
  const ready = box.w > 0 && box.h > 0
  const dragging = useRef(false)
  /** running delta of a non-ball drag; the store is only written on release */
  const dragStartPos = useRef<Vec | null>(null)
  /** mm offset added to a touch-dragged ball, see LIFT_PX; null for a mouse */
  const liftRef = useRef<Vec | null>(null)
  /** the two-finger gesture in progress */
  const pinchRef = useRef<Pinch | null>(null)
  /** one finger sliding a zoomed picture */
  const panRef = useRef<Pan | null>(null)
  /** fingers on the canvas right now, kept by native listeners: Konva stops
      delivering touch events to the stage while one of its nodes is dragged */
  const touchesRef = useRef(0)
  /** a node drag that a second finger turned into a pinch; its end writes nothing */
  const cancelledDragRef = useRef(false)
  /** when the last finger went down; a mouse event right after it is the
      browser's compatibility echo of the same tap, not a second tap */
  const lastTouchRef = useRef(0)
  /** the selection frame, in a ref for the handlers and in state to draw it */
  const marqueeRef = useRef<Marquee | null>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  /** a frame just ended: the click that follows it must not clear what it selected */
  const marqueeDone = useRef(false)
  /** a selected object pressed with Shift or in «Выбрать несколько»: a click
      without a drag takes it out of the selection */
  const pendingOff = useRef<string | null>(null)
  const multiDrag = useRef<MultiDrag | null>(null)
  const turnRef = useRef<Turn | null>(null)
  /** the angle of a turn in progress, and where the lever was when it began:
      while it is dragged the lever must keep the place the finger gives it,
      not the one the turning box would - React would pull it back each frame */
  const [turning, setTurning] = useState<{ deg: number; at: Vec; c: Vec } | null>(null)

  const table = useStore((s) => s.scene.table)
  const items = useStore((s) => s.scene.items)
  const selectedId = useStore((s) => s.selectedId)
  const selection = useStore((s) => s.selection)
  const tool = useStore((s) => s.tool)
  const orientation = useStore((s) => s.orientation)
  const density = useStore((s) => s.watermarkDensity)
  const setEditing = useView((s) => s.setEditing)
  const viewport = useView((s) => s.viewport)

  const g = useMemo(() => buildGeometry(table), [table])
  const layout = useMemo(
    () => computeLayout(g, orientation, box.w, box.h, viewport),
    [g, orientation, box.w, box.h, viewport],
  )
  const layoutRef = useRef<StageLayout>(layout)
  useEffect(() => {
    layoutRef.current = layout
  }, [layout])

  /* ---------------------------------------------------- size + auto rotate */

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const apply = () => {
      const r = el.getBoundingClientRect()
      setBox({ w: Math.max(0, Math.floor(r.width)), h: Math.max(0, Math.floor(r.height)) })
      useStore
        .getState()
        .autoOrientation(r.width < NARROW_PX && r.height > r.width ? 'vertical' : 'horizontal')
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* tell the DOM side (properties panel, text editor) where the canvas is */
  useEffect(() => {
    const stage = stageRef.current
    const wrap = wrapRef.current?.closest('.stage-wrap')
    if (!stage || !wrap) return
    const c = stage.container().getBoundingClientRect()
    const w = wrap.getBoundingClientRect()
    useView
      .getState()
      .setView(layout, c.left - w.left, c.top - w.top, { left: w.left, top: w.top, width: w.width, height: w.height })
  }, [layout, stageRef, box.w, box.h])

  /* Inspection hook for the browser test suite; a no-op in a normal build. */
  useEffect(() => {
    publishDebug('__layout', layout)
    // the very nodes the export renders, so a test can read a caption's text
    publishDebug('__stage', stageRef.current)
    publishDebug('__view', useView)
    publishDebug('__konva', Konva)
  }, [layout, stageRef])

  useEffect(() => {
    publishDebug('__store', useStore)
    const publish = () => {
      const s = useStore.getState()
      publishDebug('__scene', { ...s.scene, selectedId: s.selectedId, selection: s.selection })
    }
    publish()
    return useStore.subscribe(publish)
  }, [])

  /* ------------------------------------------------------------- pointers */

  const pointerMm = useCallback(() => {
    const stage = stageRef.current
    const pos = stage?.getPointerPosition()
    if (!pos) return null
    return pxToMm(layout, pos)
  }, [layout, stageRef])

  /** snap + push-apart for a ball, applied straight to the node so it never
      lags a frame behind the finger */
  const settleBall = useCallback(
    (id: string, raw: Vec) => {
      const st = useStore.getState()
      const ballMm = st.scene.table.ballMm
      const free = clampToField(g, raw, ballMm)
      const grid = clampToField(g, snapPoint(g, free, st.snap), ballMm)
      let p = st.snap ? clampToField(g, snapWithMeasures(st.scene.items, id, free, grid, ballMm), ballMm) : grid
      p = resolveOverlap(g, st.scene.items, id, p, ballMm, st.noOverlap)
      return p
    },
    [g],
  )

  const snapPt = useCallback(
    (p: Vec) => snapPoint(g, p, useStore.getState().snap),
    [g],
  )

  /**
   * A tap on something already drawn, with a drawing tool still on: that is
   * the coach reaching for it, not starting another one. It is selected and
   * the tool goes back to «Выбор», so the panel - and «Удалить» in it - comes
   * up. Without this the object could only be reached by changing tool
   * first, which on a phone, with no Delete key, looked like it could not be
   * deleted at all. Returns whether something was hit.
   */
  const tapSelects = useCallback((p: Vec, solidOnly: boolean): boolean => {
    const st = useStore.getState()
    const tol = solidOnly ? 0 : lineHitPx() / 2 / layoutRef.current.scale
    const hit = itemAt(st.scene.items, p, st.scene.table.ballMm, tol, solidOnly ? (it) => SOLID.has(it.type) : undefined)
    if (!hit) return false
    st.setTool('select')
    const ghost = hit.type === 'measure' && !hit.group ? ghostIndexAt(hit, st.scene.items, st.scene.table.ballMm, p) : null
    if (hit.type === 'measure' && ghost !== null) st.pickGhost(hit.id, ghost)
    else st.select(hit.id)
    return true
  }, [])

  /* the press: start a gesture, place a caption, or just clear the selection */
  const onPointerDown = useCallback(
    (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (isTouch(e.evt)) {
        lastTouchRef.current = Date.now()
        // no compatibility mouse events after this touch, so a tap on the
        // cloth places one ball, not two; and the keyboard goes away
        if (e.evt.cancelable) e.evt.preventDefault()
        const el = document.activeElement
        if (el instanceof HTMLElement && el !== document.body) el.blur()
      } else if (Date.now() - lastTouchRef.current < 700) return
      if (e.target !== e.target.getStage()) return
      const st = useStore.getState()
      const p = pointerMm()
      if (!p) return
      if (st.tool === 'select' && isTouch(e.evt) && layoutRef.current.zoom > 1) {
        // a zoomed picture slides under one finger; the tap still deselects
        const pos = stageRef.current?.getPointerPosition()
        if (pos) panRef.current = { from: pos, view: useView.getState().viewport }
        return
      }
      if (st.tool === 'select') {
        // a frame over the cloth selects what lies wholly inside it; with
        // Shift it adds to what is selected already
        const add = 'shiftKey' in e.evt && e.evt.shiftKey
        marqueeRef.current = { from: p, to: p, add }
        marqueeDone.current = false
        return
      }
      if (st.tool === 'measure') {
        // from a ball, or from a pocket, a spot or a cushion to a ball
        e.evt.preventDefault()
        const hit = pickAnchor(st.scene.items, p, st.scene.table.ballMm, GRAB_PX / layoutRef.current.scale)
        dragging.current = true
        setDraft(hit ? { tool: 'measure', from: hit.at, to: p, a: hit.id, press: p } : { tool: 'measure', from: p, to: p, press: p })
        return
      }
      if (DRAG_TOOLS.includes(st.tool)) {
        e.evt.preventDefault()
        const from = snapPt(p)
        dragging.current = true
        setDraft({ tool: st.tool, from, to: from, press: p })
        return
      }
      if ((st.tool === 'strike' || st.tool === 'power' || st.tool === 'ghost-ball' || st.tool === 'text') && tapSelects(p, true)) return
      if (st.tool === 'strike' || st.tool === 'power' || st.tool === 'ghost-ball') {
        const id = newId(st.tool)
        const item: Item =
          st.tool === 'strike'
            ? { id, type: 'strikePoint', x: p.x, y: p.y, sizeMm: scaledPreset(STRIKE_DEFAULT_MM, st.scene.table), dot: { u: 0, v: 0 } }
            : st.tool === 'power'
              ? { id, type: 'power', x: p.x, y: p.y, value: 2.5, widthMm: defaultPowerWidth(st.scene.table) }
              : { id, type: 'ghostBall', x: p.x, y: p.y }
        // widgets sit above the balls and arrows, below the captions
        st.addItem(item, st.tool === 'ghost-ball' ? 'top' : 'belowText')
        return
      }
      if (st.tool === 'text') {
        const item: Item = {
          id: newId('text'),
          type: 'text',
          x: p.x,
          y: p.y,
          text: 'Текст',
          // the draft remembers the coach's choice on the pyramid's scale
          size: scaledPreset(st.draft.textSize, st.scene.table),
          color: st.draft.ink,
          angle: 0,
        }
        st.addItem(item)
        setEditing(item.id)
        return
      }
    },
    [pointerMm, snapPt, setEditing, stageRef, tapSelects],
  )

  const onPointerMove = useCallback(() => {
    const m = marqueeRef.current
    if (m) {
      const p = pointerMm()
      if (!p) return
      marqueeRef.current = { ...m, to: p }
      setMarquee(marqueeRef.current)
      return
    }
    if (!dragging.current) return
    const p = pointerMm()
    if (!p) return
    setDraft((d) => (d ? { ...d, to: p } : d))
  }, [pointerMm])

  /** the frame let go: select what it holds, unless it was only a tap */
  const finishMarquee = useCallback(
    (raw: Vec | null) => {
      const m = marqueeRef.current
      if (!m) return
      marqueeRef.current = null
      setMarquee(null)
      const to = raw ?? m.to
      const scale = layoutRef.current.scale
      if (Math.hypot(to.x - m.from.x, to.y - m.from.y) * scale < MARQUEE_MIN_PX) return
      const st = useStore.getState()
      const ids = itemsInside(st.scene.items, m.from, to, st.scene.table.ballMm)
      marqueeDone.current = true
      if (ids.length) st.selectMany(ids, m.add)
      else if (!m.add) st.select(null)
    },
    [],
  )

  /* ------------------------------------------------ pinch zoom, touch pan */

  /** stage px of the first two fingers, or null */
  const twoFingers = useCallback((): [Vec, Vec] | null => {
    const stage = stageRef.current
    if (!stage) return null
    const pts = stage.getPointersPositions()
    if (pts.length < 2) return null
    return [
      { x: pts[0].x, y: pts[0].y },
      { x: pts[1].x, y: pts[1].y },
    ]
  }, [stageRef])

  /** two fingers: zoom about their midpoint. Runs on the container in the
      capture phase, so it sees every move even while Konva drags a node. */
  const pinchMove = useCallback(
    (evt: TouchEvent) => {
      const stage = stageRef.current
      if (!stage) return
      if (evt.touches.length < 2) {
        pinchRef.current = null
        return
      }
      if (evt.cancelable) evt.preventDefault()
      stage.setPointersPositions(evt)
      const fingers = twoFingers()
      if (!fingers) return
      // a second finger turns any gesture into a pinch
      if (dragging.current) {
        dragging.current = false
        setDraft(null)
      }
      if (marqueeRef.current) {
        marqueeRef.current = null
        setMarquee(null)
      }
      panRef.current = null
      stage.find((n: Konva.Node) => n.isDragging()).forEach((n) => {
        cancelledDragRef.current = true
        n.stopDrag()
      })
      const L = layoutRef.current
      const [a, b] = fingers
      const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      let start = pinchRef.current
      if (!start) {
        start = { dist, mid, view: useView.getState().viewport }
        pinchRef.current = start
        return
      }
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (start.view.zoom * dist) / start.dist))
      const k = zoom / start.view.zoom
      const cx = L.stageW / 2
      const cy = L.stageH / 2
      // the cloth under the fingers' midpoint stays under the midpoint
      const next: Viewport = {
        zoom,
        panX: mid.x - cx - (start.mid.x - cx - start.view.panX) * k,
        panY: mid.y - cy - (start.mid.y - cy - start.view.panY) * k,
      }
      useView.getState().setViewport(clampPan(next, L.stageW, L.stageH))
    },
    [twoFingers, stageRef],
  )

  useEffect(() => {
    const stage = stageRef.current
    if (!ready || !stage) return
    const el = stage.container()
    const count = (evt: TouchEvent) => {
      touchesRef.current = evt.touches.length
      if (evt.touches.length < 2) pinchRef.current = null
    }
    const opts = { capture: true, passive: false } as const
    el.addEventListener('touchstart', count, opts)
    el.addEventListener('touchend', count, opts)
    el.addEventListener('touchcancel', count, opts)
    el.addEventListener('touchmove', pinchMove, opts)
    return () => {
      el.removeEventListener('touchstart', count, opts)
      el.removeEventListener('touchend', count, opts)
      el.removeEventListener('touchcancel', count, opts)
      el.removeEventListener('touchmove', pinchMove, opts)
    }
  }, [ready, pinchMove, stageRef])

  /** one finger: slide a zoomed picture, or extend the draft */
  const onTouchMove = useCallback(
    (e: KonvaEventObject<TouchEvent>) => {
      if (e.evt.touches.length >= 2) return // pinchMove has it
      const pan = panRef.current
      const pos = stageRef.current?.getPointerPosition()
      if (pan && pos) {
        if (e.evt.cancelable) e.evt.preventDefault()
        const L = layoutRef.current
        useView.getState().setViewport(
          clampPan(
            {
              zoom: pan.view.zoom,
              panX: pan.view.panX + (pos.x - pan.from.x),
              panY: pan.view.panY + (pos.y - pan.from.y),
            },
            L.stageW,
            L.stageH,
          ),
        )
        return
      }
      onPointerMove()
    },
    [onPointerMove, stageRef],
  )

  /** release: commit the draft if it is long enough to be an object */
  const finishGesture = useCallback(
    (raw: Vec | null) => {
      if (!dragging.current) return
      dragging.current = false
      setDraft((d) => {
        if (!d) return null
        const st = useStore.getState()
        const tapped = Math.hypot((raw ?? d.to).x - d.press.x, (raw ?? d.to).y - d.press.y) < MIN_GESTURE_MM
        if (d.tool === 'measure') {
          const end = raw ?? d.to
          const D = st.scene.table.ballMm
          const scale = layoutRef.current.scale
          const hit = pickAnchor(st.scene.items, end, D, GRAB_PX / scale, d.a)
          const ink = st.draft.ink
          if (d.a && hit) {
            // ball to ball
            const same = findMeasure(st.scene.items, d.a, hit.id)
            if (same) st.select(same.id)
            else st.addItem({ id: newId('measure'), type: 'measure', a: d.a, b: hit.id, color: ink, label: true }, 'bottom')
            return null
          }
          if (d.a) {
            // pressed on a ball and let go on it: that is a tap on the ball
            if (Math.hypot(end.x - d.from.x, end.y - d.from.y) < D * 1.2) {
              tapSelects(d.press, false)
              return null
            }
            // from a ball to a pocket, a spot, the cushion or open cloth
            const id = newId('measure')
            const at = settleEnd(g, end, d.from, D, END_PX / scale).at
            if (Math.hypot(at.x - d.from.x, at.y - d.from.y) < D * 0.99) return null
            const ghost: GhostBallItem = { id: newId('ghost-ball'), type: 'ghostBall', x: at.x, y: at.y, owner: id }
            st.addMeasure({ id, type: 'measure', a: d.a, b: ghost.id, color: ink, label: true }, [ghost])
            return null
          }
          if (!hit) {
            // neither end on a ball: nothing to measure, but a tap still selects
            if (tapped) tapSelects(d.press, false)
            return null
          }
          // from a pocket, a spot or the cushion to a ball
          const id = newId('measure')
          const at = settleEnd(g, d.from, hit.at, D, END_PX / scale).at
          if (Math.hypot(at.x - hit.at.x, at.y - hit.at.y) < D * 0.99) return null
          const ghost: GhostBallItem = { id: newId('ghost-ball'), type: 'ghostBall', x: at.x, y: at.y, owner: id }
          st.addMeasure({ id, type: 'measure', a: ghost.id, b: hit.id, color: ink, label: true }, [ghost])
          return null
        }
        const to = raw ? snapPt(raw) : d.to
        const len = Math.hypot(to.x - d.from.x, to.y - d.from.y)
        const isZone = d.tool === 'zone-rect' || d.tool === 'zone-ellipse'
        const big = isZone
          ? Math.abs(to.x - d.from.x) >= MIN_GESTURE_MM && Math.abs(to.y - d.from.y) >= MIN_GESTURE_MM
          : len >= MIN_GESTURE_MM
        if (!big) {
          if (tapped) tapSelects(d.press, false)
          return null
        }
        const ds = st.draft
        let item: Item
        switch (d.tool) {
          case 'arrow':
            item = {
              id: newId('arrow'),
              type: 'arrow',
              points: [d.from, to],
              style: ds.style,
              color: ds.ink,
              width: scaledPreset(ds.width, st.scene.table),
              head: ds.head,
              curved: false,
            }
            break
          case 'line':
            item = {
              id: newId('line'),
              type: 'line',
              from: d.from,
              to,
              style: ds.style,
              color: ds.ink,
              width: scaledPreset(ds.width, st.scene.table),
            }
            break
          case 'ghost':
            item = {
              id: newId('ghost'),
              type: 'ghostTrail',
              from: d.from,
              to,
              count: ghostCount(len, st.scene.table.ballMm),
              autoCount: true,
              head: ds.head !== 'none',
              color: ds.ink,
            }
            break
          default:
            item = {
              id: newId('zone'),
              type: 'zone',
              x: Math.min(d.from.x, to.x),
              y: Math.min(d.from.y, to.y),
              w: Math.abs(to.x - d.from.x),
              h: Math.abs(to.y - d.from.y),
              shape: d.tool === 'zone-ellipse' ? 'ellipse' : 'rect',
              color: ds.ink === '#FFFFFF' ? DEFAULT_ZONE_COLOR : ds.ink,
              opacity: ZONE_OPACITY,
            }
        }
        // a zone belongs under the balls, never over them
        st.addItem(item, isZone ? 'bottom' : 'top')
        return null
      })
    },
    [snapPt, g, tapSelects],
  )

  const onPointerUp = useCallback(() => {
    const p = pointerMm()
    finishMarquee(p)
    finishGesture(p)
  }, [finishGesture, finishMarquee, pointerMm])

  const onTouchEnd = useCallback(
    (e: KonvaEventObject<TouchEvent>) => {
      const left = e.evt.touches ? e.evt.touches.length : 0
      if (left < 2) pinchRef.current = null
      if (left === 0) {
        panRef.current = null
        const p = pointerMm()
        finishMarquee(p)
        finishGesture(p)
      }
    },
    [finishGesture, finishMarquee, pointerMm],
  )

  /* the pointer can leave the canvas mid-gesture; finish on the window instead */
  useEffect(() => {
    const end = () => {
      finishMarquee(null)
      finishGesture(null)
    }
    window.addEventListener('mouseup', end)
    window.addEventListener('touchend', end)
    return () => {
      window.removeEventListener('mouseup', end)
      window.removeEventListener('touchend', end)
    }
  }, [finishGesture, finishMarquee])

  /* a plain click on empty cloth: add a ball, or drop the selection */
  const onStageTap = useCallback(
    (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
      // a selected object pressed with Shift (or in «Выбрать несколько») and
      // let go without moving: it leaves the selection
      const off = pendingOff.current
      pendingOff.current = null
      if (off && e.target !== e.target.getStage()) {
        useStore.getState().toggleSelect(off)
        return
      }
      if (e.target !== e.target.getStage()) return
      if (!isTouch(e.evt) && Date.now() - lastTouchRef.current < 700) return
      // the click that ends a frame is not a tap on empty cloth
      if (marqueeDone.current) {
        marqueeDone.current = false
        return
      }
      const st = useStore.getState()
      if (st.tool === 'ball-white' || st.tool === 'ball-cue') {
        const p = pointerMm()
        // on a ball: the coach means that ball, not a second one beside it
        if (p && !tapSelects(p, true)) st.addBall(st.tool === 'ball-cue' ? 'cue' : 'white', p)
        return
      }
      if (st.tool === 'select') st.select(null)
    },
    [pointerMm, tapSelects],
  )

  /* ---------------------------------------------------------- item drags */

  /** a node back where the scene has its object: a ball's centre, or a
      group's origin for everything drawn in table coordinates */
  const placeNode = useCallback((node: Konva.Node) => {
    const it = useStore.getState().scene.items.find((i) => i.id === node.id())
    if (it && (it.type === 'ball' || it.type === 'ghostBall')) node.position({ x: it.x, y: it.y })
    else node.position({ x: 0, y: 0 })
  }, [])

  const handleDragStart = useCallback((e: KonvaEventObject<DragEvent>) => {
    const node = e.target
    if (touchesRef.current >= 2) {
      // the finger that landed on this object is half of a pinch
      cancelledDragRef.current = true
      node.stopDrag()
      return
    }
    const st = useStore.getState()
    pendingOff.current = null
    // dragging one of a selection of several moves them all; any other
    // object becomes the selection - with its group, if it has one
    if (!st.selection.includes(node.id())) st.select(node.id())
    st.beginHistory()
    dragStartPos.current = { x: node.x(), y: node.y() }
    const name = node.name()
    liftRef.current = null
    const sel = useStore.getState().selection
    if (sel.length > 1) {
      const items = useStore.getState().scene.items
      multiDrag.current = { start: { x: node.x(), y: node.y() }, snapshot: items.filter((i) => sel.includes(i.id)) }
      return
    }
    multiDrag.current = null
    if ((name === 'ball' || name === 'ghostBall') && isTouch(e.evt)) {
      const L = layoutRef.current
      const a = pxToMm(L, { x: 0, y: 0 })
      const b = pxToMm(L, { x: 0, y: -LIFT_PX })
      liftRef.current = { x: b.x - a.x, y: b.y - a.y }
    }
  }, [])

  /** where the dragged ball goes: under the mouse, or above the finger */
  const lifted = useCallback((node: Konva.Node): Vec => {
    const l = liftRef.current
    return l ? { x: node.x() + l.x, y: node.y() + l.y } : { x: node.x(), y: node.y() }
  }, [])

  const handleDragMove = useCallback(
    (e: KonvaEventObject<DragEvent>) => {
      const node = e.target
      if (touchesRef.current >= 2) {
        cancelledDragRef.current = true
        node.stopDrag()
        return
      }
      const multi = multiDrag.current
      if (multi) {
        // Konva puts the node where the pointer has taken it from its start,
        // so the delta is fresh each frame; the store moves every object, and
        // the node is put back where the store now has it
        useStore.getState().moveSelectionLive(multi.snapshot, node.x() - multi.start.x, node.y() - multi.start.y)
        placeNode(node)
        return
      }
      // Konva puts the node back under the pointer before every move, so the
      // lift is added afresh each frame and never accumulates
      if (node.name() === 'ghostBall') {
        useStore.getState().dragGhostBallTo(node.id(), lifted(node), END_PX / layoutRef.current.scale)
        const it = useStore.getState().scene.items.find((i) => i.id === node.id())
        if (it && it.type === 'ghostBall') node.position({ x: it.x, y: it.y })
        return
      }
      if (node.name() !== 'ball') return // other items just ride the group offset
      const p = settleBall(node.id(), lifted(node))
      node.position(p)
      useStore.getState().dragItemTo(node.id(), p)
    },
    [settleBall, lifted, placeNode],
  )

  const handleDragEnd = useCallback(
    (e: KonvaEventObject<DragEvent>) => {
      const node = e.target
      const st = useStore.getState()
      // dragend sees the position the last dragmove left, lift included
      liftRef.current = null
      const multi = multiDrag.current
      multiDrag.current = null
      if (multi) {
        if (cancelledDragRef.current) {
          cancelledDragRef.current = false
          st.moveSelectionLive(multi.snapshot, 0, 0)
        } else st.moveSelectionEnd(multi.snapshot, node.x() - multi.start.x, node.y() - multi.start.y)
        placeNode(node)
        dragStartPos.current = null
        return
      }
      if (cancelledDragRef.current) {
        // a pinch, not a move: put the node back where the scene has it
        cancelledDragRef.current = false
        dragStartPos.current = null
        const it = st.scene.items.find((i) => i.id === node.id())
        if (it && (it.type === 'ball' || it.type === 'ghostBall')) node.position({ x: it.x, y: it.y })
        else node.position({ x: 0, y: 0 })
        return
      }
      if (node.name() === 'ghostBall') {
        st.dragGhostBallTo(node.id(), { x: node.x(), y: node.y() }, END_PX / layoutRef.current.scale)
        const it = st.scene.items.find((i) => i.id === node.id())
        if (it && it.type === 'ghostBall') node.position({ x: it.x, y: it.y })
        return
      }
      if (node.name() === 'ball') {
        const p = settleBall(node.id(), { x: node.x(), y: node.y() })
        node.position(p)
        st.dragItemTo(node.id(), p)
        return
      }
      // one write for the whole drag, then the group goes back to the origin
      const start = dragStartPos.current ?? { x: 0, y: 0 }
      st.moveItemBy(node.id(), node.x() - start.x, node.y() - start.y)
      node.position({ x: 0, y: 0 })
      dragStartPos.current = null
    },
    [settleBall, placeNode],
  )

  const handleSelect = useCallback((e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    e.cancelBubble = true
    const st = useStore.getState()
    if (st.tool !== 'select') return
    // the handler sits on the group; find its id whichever child was hit, and
    // on the way which ghost of a ruler's row, if that is what was hit
    let node: Konva.Node | null = e.target
    let ghost: number | null = null
    while (node && !node.id()) {
      const m = /\bghost-(\d+)\b/.exec(node.name())
      if (m) ghost = Number(m[1])
      node = node.getParent()
    }
    if (!node) return
    const id = node.id()
    const shift = 'shiftKey' in e.evt && e.evt.shiftKey
    if (shift || st.multiMode) {
      // into the selection at once, so it can be dragged with the rest; out
      // of it only on a click that does not become a drag
      if (st.selection.includes(id)) pendingOff.current = id
      else st.toggleSelect(id)
      return
    }
    pendingOff.current = null
    // one of several selected: keep them all, the press may be a drag
    if (st.selection.length > 1 && st.selection.includes(id)) return
    const item = st.scene.items.find((i) => i.id === id)
    if (item?.type === 'measure' && ghost !== null && !item.group) st.pickGhost(id, ghost)
    else st.select(id)
  }, [])

  const handleEdit = useCallback(
    (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
      let node: Konva.Node | null = e.target
      while (node && !node.id()) node = node.getParent()
      const id = node?.id()
      const item = useStore.getState().scene.items.find((i) => i.id === id)
      if (item?.type === 'text') {
        setEditing(item.id)
        return
      }
      // two taps on the strike widget put the object ball on the side tapped:
      // on a phone, where the properties strip is cramped, this is the real way
      if (item?.type === 'strikePoint' && !item.companion) {
        const p = pointerMm()
        if (p) useStore.getState().setCompanion(item.id, p.x < item.x ? 'left' : 'right')
      }
    },
    [setEditing, pointerMm],
  )

  /* --------------------------------------------------------- handle drags */

  const onHandleStart = useCallback(() => {
    useStore.getState().beginHistory()
  }, [])

  const onHandleMove = useCallback(
    (h: Handle, e: KonvaEventObject<DragEvent>) => {
      const st = useStore.getState()
      const item = st.scene.items.find((i) => i.id === st.selectedId)
      if (!item) return
      const node = e.target
      const p = snapPt({ x: node.x(), y: node.y() })
      const patch = dragHandle(item, h.id, p, useStore.getState().scene.table)
      if (patch) st.updateItemLive(item.id, patch)
    },
    [snapPt],
  )

  const onHandleEnd = useCallback(
    (h: Handle, e: KonvaEventObject<DragEvent>) => {
      onHandleMove(h, e)
      const st = useStore.getState()
      const item = st.scene.items.find((i) => i.id === st.selectedId)
      if (!item) return
      const tune = retuneGhost(item, st.scene.table.ballMm)
      if (tune) st.updateItemLive(item.id, tune)
    },
    [onHandleMove],
  )

  /* ------------------------------------------------------------ keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      if (typing) return
      const st = useStore.getState()
      const mod = e.ctrlKey || e.metaKey

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) st.redo()
        else st.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        st.redo()
        return
      }
      if (mod && e.key.toLowerCase() === 'd') {
        if (!st.selection.length) return
        e.preventDefault()
        st.duplicateSelected()
        return
      }
      // Ctrl+G groups what is selected, Ctrl+Shift+G takes the group apart
      if (mod && e.key.toLowerCase() === 'g') {
        if (!st.selection.length) return
        e.preventDefault()
        if (e.shiftKey) st.ungroupSelection()
        else st.groupSelection()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!st.selection.length) return
        e.preventDefault()
        st.removeSelected()
        return
      }
      if (e.key === 'Escape') {
        st.select(null)
        st.setTool('select')
        return
      }
      // strength plate: plus and minus step the scale
      if (st.selectedId && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')) {
        const it = st.scene.items.find((i) => i.id === st.selectedId)
        if (it?.type === 'power') {
          e.preventDefault()
          st.adjustPower(it.id, e.key === '+' || e.key === '=' ? 1 : -1)
          return
        }
      }
      // precise nudge: 5 mm, or 1 mm with shift (spec section 7)
      const step = e.shiftKey ? 1 : 5
      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }
      const d = nudge[e.key]
      if (d && st.selection.length) {
        e.preventDefault()
        st.nudgeSelected(d[0], d[1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* -------------------------------------------------------------- render */

  const selecting = tool === 'select'
  const selected = items.find((i) => i.id === selectedId)
  /** the box round a selection of several, which the lever turns */
  const selBox = selecting && selection.length > 1 ? unionBounds(items, selection, table.ballMm) : null
  const px = 1 / layout.scale
  const lever = selBox ? (turning ? turning.at : { x: selBox.x + selBox.w / 2, y: selBox.y - 12 * px - LEVER_PX * px }) : null

  /* ---------------------------------------------------- turning the lever */

  const onLeverStart = useCallback(
    (e: KonvaEventObject<DragEvent>) => {
      const st = useStore.getState()
      const b = unionBounds(st.scene.items, st.selection, st.scene.table.ballMm)
      if (!b) return
      st.beginHistory()
      const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
      const n = e.target
      turnRef.current = { c, a0: Math.atan2(n.y() - c.y, n.x() - c.x), snapshot: st.scene.items.filter((i) => st.selection.includes(i.id)) }
      setTurning({ deg: 0, at: { x: n.x(), y: n.y() }, c })
    },
    [],
  )

  const leverAngle = useCallback((n: Konva.Node): number => {
    const t = turnRef.current
    if (!t) return 0
    const raw = ((Math.atan2(n.y() - t.c.y, n.x() - t.c.x) - t.a0) * 180) / Math.PI
    // the shortest way round, then onto the magnet's 15-degree steps
    const wrapped = ((((raw + 180) % 360) + 360) % 360) - 180
    return snapAngle(wrapped, useStore.getState().snap)
  }, [])

  const onLeverMove = useCallback(
    (e: KonvaEventObject<DragEvent>) => {
      const t = turnRef.current
      if (!t) return
      const deg = leverAngle(e.target)
      useStore.getState().rotateSelectionLive(t.snapshot, t.c, deg)
      setTurning((cur) => (cur ? { ...cur, deg } : cur))
    },
    [leverAngle],
  )

  const onLeverEnd = useCallback(
    (e: KonvaEventObject<DragEvent>) => {
      const t = turnRef.current
      if (!t) return
      // the angle first: it is read off the lever relative to the turn's start
      const deg = leverAngle(e.target)
      turnRef.current = null
      setTurning(null)
      useStore.getState().rotateSelectionEnd(t.snapshot, t.c, deg)
      // the lever goes back above the turned selection
      const st = useStore.getState()
      const b = unionBounds(st.scene.items, st.selection, st.scene.table.ballMm)
      const s1 = 1 / layoutRef.current.scale
      if (b) e.target.position({ x: b.x + b.w / 2, y: b.y - 12 * s1 - LEVER_PX * s1 })
    },
    [leverAngle],
  )

  /** the gesture in progress, drawn like the object it is about to become */
  const preview = useMemo<Item | null>(() => {
    if (!draft || draft.tool === 'measure') return null
    const { from, to } = draft
    const st = useStore.getState()
    const ds = st.draft
    switch (draft.tool) {
      case 'arrow':
        return { id: 'draft', type: 'arrow', points: [from, to], style: ds.style, color: ds.ink, width: scaledPreset(ds.width, table), head: ds.head, curved: false }
      case 'line':
        return { id: 'draft', type: 'line', from, to, style: ds.style, color: ds.ink, width: scaledPreset(ds.width, table) }
      case 'ghost':
        return {
          id: 'draft',
          type: 'ghostTrail',
          from,
          to,
          count: ghostCount(Math.hypot(to.x - from.x, to.y - from.y), table.ballMm),
          autoCount: true,
          head: ds.head !== 'none',
          color: ds.ink,
        }
      default:
        return {
          id: 'draft',
          type: 'zone',
          x: Math.min(from.x, to.x),
          y: Math.min(from.y, to.y),
          w: Math.abs(to.x - from.x),
          h: Math.abs(to.y - from.y),
          shape: draft.tool === 'zone-ellipse' ? 'ellipse' : 'rect',
          color: ds.ink === '#FFFFFF' ? DEFAULT_ZONE_COLOR : ds.ink,
          opacity: ZONE_OPACITY,
        }
    }
  }, [draft, table])

  /**
   * A ruler being drawn, as it would land: to the ball under the pointer, or
   * to the ghost that would be put where the finger is - in the pocket, on
   * the spot, against the cushion. `ghosts` are those would-be ghosts.
   */
  const measureDraft = useMemo(() => {
    if (!draft || draft.tool !== 'measure') return null
    const D = table.ballMm
    const reach = END_PX / layout.scale
    const hit = pickAnchor(items, draft.to, D, GRAB_PX / layout.scale, draft.a)
    if (draft.a) {
      if (hit) return { a: draft.from, b: hit.at, ghosts: [] as Vec[] }
      if (Math.hypot(draft.to.x - draft.from.x, draft.to.y - draft.from.y) < D * 1.2) return null
      const end = settleEnd(g, draft.to, draft.from, D, reach).at
      return { a: draft.from, b: end, ghosts: [end] }
    }
    const start = settleEnd(g, draft.from, hit ? hit.at : draft.to, D, reach).at
    if (Math.hypot(draft.to.x - start.x, draft.to.y - start.y) < D * 1.2) return null
    return { a: start, b: hit ? hit.at : draft.to, ghosts: [start] }
  }, [draft, items, table.ballMm, layout.scale, g])

  const noop = useCallback(() => {}, [])

  return (
    <div className="stage-wrap__canvas" ref={wrapRef}>
      {ready && (
        <Stage
          ref={stageRef}
          width={layout.stageW}
          height={layout.stageH}
          onMouseDown={onPointerDown}
          onTouchStart={onPointerDown}
          onMouseMove={onPointerMove}
          onTouchMove={onTouchMove}
          onMouseUp={onPointerUp}
          onTouchEnd={onTouchEnd}
          onClick={onStageTap}
          onTap={onStageTap}
        >
          {/* The table is static, so it gets a layer of its own: Konva redraws
              per layer, and without this every frame of a drag repaints sixty
              gradient-and-shadow shapes that never change. On a tablet that is
              the difference between a drag that follows the finger and one
              that stutters. Both layers carry the same mm -> px transform. */}
          <Layer
            listening={false}
            scaleX={layout.scale}
            scaleY={layout.scale}
            x={layout.x}
            y={layout.y}
            rotation={layout.rotation}
          >
            <TableView g={g} />
          </Layer>
          {/* The watermark is its own layer, between the cloth and everything
              drawn on it: it never changes while an object is dragged, and it
              must not sit over a trajectory. */}
          <Layer
            listening={false}
            scaleX={layout.scale}
            scaleY={layout.scale}
            x={layout.x}
            y={layout.y}
            rotation={layout.rotation}
          >
            <Watermark g={g} density={density} />
          </Layer>
          <Layer
            scaleX={layout.scale}
            scaleY={layout.scale}
            x={layout.x}
            y={layout.y}
            rotation={layout.rotation}
          >
            {/* while drawing, nothing underneath may catch the gesture */}
            <Group listening={selecting}>
              {items.map((item) => (
                <ItemView
                  key={item.id}
                  item={item}
                  ballMm={table.ballMm}
                  game={gameOf(table)}
                  selected={selection.includes(item.id)}
                  draggable={selecting}
                  onSelect={handleSelect}
                  onDragStart={handleDragStart}
                  onDragMove={handleDragMove}
                  onDragEnd={handleDragEnd}
                  onEdit={handleEdit}
                />
              ))}
            </Group>
            {preview && (
              <Group listening={false} opacity={0.8}>
                <ItemView
                  item={preview}
                  ballMm={table.ballMm}
                  game={gameOf(table)}
                  selected={false}
                  draggable={false}
                  onSelect={noop}
                  onDragStart={noop}
                  onDragMove={noop}
                  onDragEnd={noop}
                />
              </Group>
            )}
            {measureDraft && (
              <Group listening={false} opacity={0.85}>
                <MeasureShape
                  a={measureDraft.a}
                  b={measureDraft.b}
                  ballMm={table.ballMm}
                  color={useStore.getState().draft.ink}
                  label
                  selected={false}
                  counter={-layout.rotation}
                  toward={{ x: table.lengthMm / 2, y: table.widthMm / 2 }}
                  scale={layout.scale}
                />
                {measureDraft.ghosts.map((p, i) => (
                  <GhostBallShape key={i} item={{ id: 'draft-ghost', type: 'ghostBall', x: p.x, y: p.y }} ballMm={table.ballMm} />
                ))}
              </Group>
            )}
            {selBox && lever && (
              <Group name="selection-frame">
                {/* each object of the selection, and the box round them all */}
                {items
                  .filter((i) => selection.includes(i.id) && i.type !== 'ball' && i.type !== 'ghostBall' && i.type !== 'measure')
                  .map((i) => {
                    const b = itemBounds(i, table.ballMm, items)
                    return (
                      <Rect key={i.id} x={b.x} y={b.y} width={b.w} height={b.h} stroke={SELECTION} strokeWidth={1.5 * px} dash={[5 * px, 4 * px]} listening={false} />
                    )
                  })}
                <Rect
                  x={selBox.x - 12 * px}
                  y={selBox.y - 12 * px}
                  width={selBox.w + 24 * px}
                  height={selBox.h + 24 * px}
                  stroke={SELECTION}
                  strokeWidth={2 * px}
                  dash={[9 * px, 6 * px]}
                  cornerRadius={6 * px}
                  listening={false}
                />
                {!turning && (
                  <KLine
                    points={[lever.x, selBox.y - 12 * px, lever.x, lever.y]}
                    stroke={SELECTION}
                    strokeWidth={2 * px}
                    listening={false}
                  />
                )}
                {turning && (
                  <Text
                    name="turn-angle"
                    x={turning.c.x}
                    y={turning.c.y}
                    offsetY={8 * px}
                    text={`${turning.deg > 0 ? '+' : ''}${turning.deg}°`}
                    fontSize={16 * px}
                    fontFamily={CANVAS_FONT}
                    fontStyle="bold"
                    fill="#FFFFFF"
                    rotation={-layout.rotation}
                    shadowColor="rgba(0,0,0,0.6)"
                    shadowBlur={4 * px}
                    listening={false}
                  />
                )}
                <Circle
                  name="rotate-lever"
                  x={lever.x}
                  y={lever.y}
                  radius={10 * px}
                  fill="#FFFFFF"
                  stroke={SELECTION}
                  strokeWidth={2.5 * px}
                  hitStrokeWidth={22 * px}
                  draggable
                  onMouseDown={(e) => void (e.cancelBubble = true)}
                  onTouchStart={(e) => void (e.cancelBubble = true)}
                  onDragStart={onLeverStart}
                  onDragMove={onLeverMove}
                  onDragEnd={onLeverEnd}
                />
              </Group>
            )}
            {marquee && (
              <Rect
                name="marquee"
                x={Math.min(marquee.from.x, marquee.to.x)}
                y={Math.min(marquee.from.y, marquee.to.y)}
                width={Math.abs(marquee.to.x - marquee.from.x)}
                height={Math.abs(marquee.to.y - marquee.from.y)}
                fill="rgba(255,209,102,0.08)"
                stroke={SELECTION}
                strokeWidth={1.5 * px}
                dash={[6 * px, 4 * px]}
                listening={false}
              />
            )}
            {selecting && selected && selected.type !== 'ball' && selected.type !== 'ghostBall' && selected.type !== 'measure' && (
              <Handles
                item={selected}
                scale={layout.scale}
                onDragStart={onHandleStart}
                onDragMove={onHandleMove}
                onDragEnd={onHandleEnd}
              />
            )}
          </Layer>
        </Stage>
    )}
    </div>
  )
}

/** One line under the table saying what the current tool does. */
export function StageHint() {
  const tool = useStore((s) => s.tool)
  if (tool === 'select')
    return (
      <p className="stage-wrap__hint">
        <span>Перетащите объект. Рамка по пустому сукну или Shift+клик - выделить несколько.</span>{' '}
        <span className="stage-wrap__keys">Стрелки - сдвиг на 5 мм, Shift - на 1 мм, Ctrl+D - дубль, Ctrl+G - группа.</span>
      </p>
    )
  if (tool === 'ball-white' || tool === 'ball-cue')
    return <p className="stage-wrap__hint">Нажмите на стол, чтобы поставить шар.</p>
  if (tool === 'text') return <p className="stage-wrap__hint">Нажмите на стол, чтобы поставить подпись.</p>
  if (tool === 'strike')
    return (
      <p className="stage-wrap__hint">
        <span>Нажмите на стол, чтобы поставить шар с точкой удара.</span>{' '}
        <span className="stage-wrap__keys">Двойной клик по нему - прицельный шар сзади; тяните его вбок, чтобы показать, какой частью бьём.</span>
      </p>
    )
  if (tool === 'measure')
    return (
      <p className="stage-wrap__hint">
        <span>Протяните от шара до шара, лузы, точки или борта: между ними встанут шары-призраки вплотную.</span>{' '}
        <span className="stage-wrap__keys">С магнитом шар, который тянут, встаёт ровно на целое число шаров.</span>
      </p>
    )
  if (tool === 'power' || tool === 'ghost-ball')
    return <p className="stage-wrap__hint">Нажмите на стол, чтобы поставить виджет. Потом его можно тянуть.</p>
  return (
    <p className="stage-wrap__hint">
      Нажмите и протяните по столу. Инструмент остаётся активным, Esc - выход.
    </p>
  )
}
