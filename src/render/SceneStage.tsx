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
import { Group, Layer, Stage } from 'react-konva'
import Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import type { Item, Vec } from '../model/types'
import { buildGeometry, clampToField } from '../model/table'
import { STRIKE_DEFAULT_MM, dragHandle, defaultPowerWidth, type Handle } from '../model/item'
import { gameOf, scaledPreset } from '../model/game'
import { DEFAULT_ZONE_COLOR, ZONE_OPACITY, ghostCount } from '../model/style'
import { newId, resolveOverlap, snapPoint } from '../lib/place'
import { findMeasure, pickAnchor, snapWithMeasures } from '../model/measure'
import { publishDebug } from '../lib/debug'
import { DRAG_TOOLS, retuneGhost, useStore, type Tool } from '../state/store'
import { useView } from '../state/view'
import { ItemView } from './ItemView'
import { MeasureShape } from './shapes'
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

type Pinch = { dist: number; mid: Vec; view: Viewport }
type Pan = { from: Vec; view: Viewport }

/** a finger, not a mouse: the native event behind a Konva one */
function isTouch(evt: unknown): boolean {
  if (!evt || typeof evt !== 'object') return false
  const o = evt as { touches?: unknown; pointerType?: string }
  return 'touches' in o || o.pointerType === 'touch'
}

/** `a` is the ball a ruler is being drawn from */
type Draft = { tool: Tool; from: Vec; to: Vec; a?: string }

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

  const table = useStore((s) => s.scene.table)
  const items = useStore((s) => s.scene.items)
  const selectedId = useStore((s) => s.selectedId)
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
      publishDebug('__scene', { ...s.scene, selectedId: s.selectedId })
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
      if (st.tool === 'measure') {
        // a ruler hangs between two balls, so it can only start on one
        e.evt.preventDefault()
        const hit = pickAnchor(st.scene.items, p, st.scene.table.ballMm, GRAB_PX / layoutRef.current.scale)
        if (!hit) return
        dragging.current = true
        setDraft({ tool: 'measure', from: hit.at, to: p, a: hit.id })
        return
      }
      if (DRAG_TOOLS.includes(st.tool)) {
        e.evt.preventDefault()
        const from = snapPt(p)
        dragging.current = true
        setDraft({ tool: st.tool, from, to: from })
        return
      }
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
    [pointerMm, snapPt, setEditing, stageRef],
  )

  const onPointerMove = useCallback(() => {
    if (!dragging.current) return
    const p = pointerMm()
    if (!p) return
    setDraft((d) => (d ? { ...d, to: p } : d))
  }, [pointerMm])

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
        if (d.tool === 'measure') {
          // released on another ball: that is the ruler; anywhere else, nothing
          const end = raw ?? d.to
          const hit = d.a
            ? pickAnchor(st.scene.items, end, st.scene.table.ballMm, GRAB_PX / layoutRef.current.scale, d.a)
            : null
          if (!d.a || !hit) return null
          const same = findMeasure(st.scene.items, d.a, hit.id)
          if (same) {
            st.select(same.id)
            return null
          }
          st.addItem({ id: newId('measure'), type: 'measure', a: d.a, b: hit.id, color: st.draft.ink, label: true }, 'bottom')
          return null
        }
        const to = raw ? snapPt(raw) : d.to
        const len = Math.hypot(to.x - d.from.x, to.y - d.from.y)
        const isZone = d.tool === 'zone-rect' || d.tool === 'zone-ellipse'
        const big = isZone
          ? Math.abs(to.x - d.from.x) >= MIN_GESTURE_MM && Math.abs(to.y - d.from.y) >= MIN_GESTURE_MM
          : len >= MIN_GESTURE_MM
        if (!big) return null
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
    [snapPt],
  )

  const onPointerUp = useCallback(() => finishGesture(pointerMm()), [finishGesture, pointerMm])

  const onTouchEnd = useCallback(
    (e: KonvaEventObject<TouchEvent>) => {
      const left = e.evt.touches ? e.evt.touches.length : 0
      if (left < 2) pinchRef.current = null
      if (left === 0) {
        panRef.current = null
        finishGesture(pointerMm())
      }
    },
    [finishGesture, pointerMm],
  )

  /* the pointer can leave the canvas mid-gesture; finish on the window instead */
  useEffect(() => {
    const end = () => finishGesture(null)
    window.addEventListener('mouseup', end)
    window.addEventListener('touchend', end)
    return () => {
      window.removeEventListener('mouseup', end)
      window.removeEventListener('touchend', end)
    }
  }, [finishGesture])

  /* a plain click on empty cloth: add a ball, or drop the selection */
  const onStageTap = useCallback(
    (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (e.target !== e.target.getStage()) return
      if (!isTouch(e.evt) && Date.now() - lastTouchRef.current < 700) return
      const st = useStore.getState()
      if (st.tool === 'ball-white' || st.tool === 'ball-cue') {
        const p = pointerMm()
        if (p) st.addBall(st.tool === 'ball-cue' ? 'cue' : 'white', p)
        return
      }
      if (st.tool === 'select') st.select(null)
    },
    [pointerMm],
  )

  /* ---------------------------------------------------------- item drags */

  const handleDragStart = useCallback((e: KonvaEventObject<DragEvent>) => {
    const node = e.target
    if (touchesRef.current >= 2) {
      // the finger that landed on this object is half of a pinch
      cancelledDragRef.current = true
      node.stopDrag()
      return
    }
    const st = useStore.getState()
    st.select(node.id())
    st.beginHistory()
    dragStartPos.current = { x: node.x(), y: node.y() }
    const name = node.name()
    liftRef.current = null
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
      // Konva puts the node back under the pointer before every move, so the
      // lift is added afresh each frame and never accumulates
      if (node.name() === 'ghostBall') {
        useStore.getState().dragGhostBallTo(node.id(), lifted(node))
        const it = useStore.getState().scene.items.find((i) => i.id === node.id())
        if (it && it.type === 'ghostBall') node.position({ x: it.x, y: it.y })
        return
      }
      if (node.name() !== 'ball') return // other items just ride the group offset
      const p = settleBall(node.id(), lifted(node))
      node.position(p)
      useStore.getState().dragItemTo(node.id(), p)
    },
    [settleBall, lifted],
  )

  const handleDragEnd = useCallback(
    (e: KonvaEventObject<DragEvent>) => {
      const node = e.target
      const st = useStore.getState()
      // dragend sees the position the last dragmove left, lift included
      liftRef.current = null
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
        st.dragGhostBallTo(node.id(), { x: node.x(), y: node.y() })
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
    [settleBall],
  )

  const handleSelect = useCallback((e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    e.cancelBubble = true
    const st = useStore.getState()
    if (st.tool !== 'select') return
    // the handler sits on the group; find its id whichever child was hit
    let node: Konva.Node | null = e.target
    while (node && !node.id()) node = node.getParent()
    if (node) st.select(node.id())
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
        if (!st.selectedId) return
        e.preventDefault()
        st.duplicateSelected()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!st.selectedId) return
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
      if (d && st.selectedId) {
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

  /** a ruler being drawn: from its ball to the ball under the pointer, or
      to the pointer itself while it is over open cloth */
  const measureDraft = useMemo(() => {
    if (!draft || draft.tool !== 'measure' || !draft.a) return null
    const hit = pickAnchor(items, draft.to, table.ballMm, GRAB_PX / layout.scale, draft.a)
    return { a: draft.from, b: hit ? hit.at : draft.to }
  }, [draft, items, table.ballMm, layout.scale])

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
                  selected={item.id === selectedId}
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
              </Group>
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
        <span>Перетащите объект. Двойной клик по тексту - правка.</span>{' '}
        <span className="stage-wrap__keys">Стрелки - сдвиг на 5 мм, Shift - на 1 мм, Ctrl+D - дубль.</span>
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
        <span>Нажмите на шар и протяните до другого шара: между ними встанут шары-призраки вплотную.</span>{' '}
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
