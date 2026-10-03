/**
 * App shell: a toolbar, the canvas with its captions, and the panels that
 * float over them. The only logic that lives here is export, because that is
 * the one action which needs the Konva stage itself, and autosave, because it
 * has to outlive every component.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type Konva from 'konva'
import { SceneStage, StageHint } from './render/SceneStage'
import { Toolbar } from './ui/Toolbar'
import { Properties } from './ui/Properties'
import { TextEditor } from './ui/TextEditor'
import { NoteField, TitleField } from './ui/Captions'
import {
  copyExportToClipboard,
  downloadExport,
  exportFileName,
  type ExportFormat,
} from './lib/exportImage'
import { flushScene, saveScene } from './lib/storage'
import { useStore } from './state/store'
import { registerPreviewSource, useLibrary } from './state/library'
import { startSync, syncCycles, syncNow } from './sync/engine'
import { Library } from './ui/Library'
import { publishDebug } from './lib/debug'
import { useView } from './state/view'
import { useIsMobile } from './ui/useMedia'
import { STAMP_SVG } from './brand/assets'
import { preloadSvgImages } from './brand/svgImage'
import { MobileShell } from './ui/mobile/MobileShell'
import { HelpPopup } from './ui/help'
import './ui/styles.css'

/**
 * "1x" means this many pixels along the long side of the picture. Tying the
 * export to a fixed reference instead of the on-screen stage size is what keeps
 * a diagram made on a phone as sharp as one made on a desktop.
 */
const EXPORT_BASE_PX = 1600

/** the long side of a library thumbnail, in pixels */
const THUMB_PX = 420

export function App() {
  const stageRef = useRef<Konva.Stage | null>(null)
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)

  /* autosave: every change, 500 ms after the last one, and on the way out.
     This is the crash net, not the library: it is one synchronous write that
     survives a killed tab, and the library takes its revisions on top of it. */
  useEffect(() => {
    let last = useStore.getState().scene
    const unsub = useStore.subscribe((s) => {
      if (s.scene !== last) {
        last = s.scene
        saveScene(s.scene)
      }
    })
    const flush = () => flushScene()
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      unsub()
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.error ? 6000 : 2500)
    return () => clearTimeout(t)
  }, [toast])

  const mobile = useIsMobile()

  /* start decoding the brand SVGs now, so the first export never waits */
  useEffect(() => {
    preloadSvgImages([STAMP_SVG])
  }, [])

  /* open the library, then keep it in step with the server */
  useEffect(() => {
    // ?debug=1 only: the acceptance run drives the library and the engine
    publishDebug('__library', useLibrary)
    publishDebug('__sync', syncNow)
    publishDebug('__syncCycles', syncCycles)
    let stop: (() => void) | null = null
    void useLibrary
      .getState()
      .hydrate()
      // the engine starts even if opening the library went wrong: a device
      // that cannot read its own database can still send what it draws now
      .catch(() => {})
      .then(() => {
        stop = startSync()
      })
    const commit = () => void useLibrary.getState().commitNow()
    // a phone backgrounding the tab is the usual way an edit session ends
    document.addEventListener('visibilitychange', commit)
    return () => {
      stop?.()
      document.removeEventListener('visibilitychange', commit)
    }
  }, [])

  /** drop the selection and the zoom, and give React two frames to redraw */
  const settle = useCallback(async () => {
    useStore.getState().select(null)
    useView.getState().resetViewport()
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  }, [])

  const pixelRatioFor = (stage: Konva.Stage, scale: number) =>
    (EXPORT_BASE_PX / Math.max(stage.width(), stage.height(), 1)) * scale

  /* the library's thumbnails come from the live canvas, at the moments the
     coach is stepping away from it - settle() resets the zoom, so this must
     not run while they are drawing */
  useEffect(() => {
    registerPreviewSource(async () => {
      const stage = stageRef.current
      if (!stage) return null
      await settle()
      const ratio = THUMB_PX / Math.max(stage.width(), stage.height(), 1)
      return stage.toDataURL({ pixelRatio: ratio, mimeType: 'image/jpeg', quality: 0.72 })
    })
    return () => registerPreviewSource(null)
  }, [settle])

  const handleExport = useCallback(
    async (scale: number, format: ExportFormat) => {
      const stage = stageRef.current
      if (!stage) return
      await settle()
      const { title, note } = useStore.getState().scene
      try {
        const { bytes } = await downloadExport(stage, {
          pixelRatio: pixelRatioFor(stage, scale),
          format,
          title,
          note,
          fileName: exportFileName(title, new Date(), format),
        })
        setToast({ text: `Сохранено, ${Math.round(bytes / 1024)} КБ`, error: false })
      } catch (e) {
        setToast({ text: e instanceof Error ? e.message : 'Не удалось сохранить', error: true })
      }
    },
    [settle],
  )

  /* No await before clipboard.write: Safari only allows it inside the click. */
  const handleCopy = useCallback((scale: number) => {
    const stage = stageRef.current
    if (!stage) return
    useStore.getState().select(null)
    // a zoomed stage would export a crop; renderExport waits two frames for
    // React to push this reset into the layers before it reads them
    useView.getState().resetViewport()
    const { title, note } = useStore.getState().scene
    copyExportToClipboard(stage, { pixelRatio: pixelRatioFor(stage, scale), title, note })
      .then(() => setToast({ text: 'Скопировано в буфер', error: false }))
      .catch((e: unknown) =>
        setToast({ text: e instanceof Error ? e.message : 'Не удалось скопировать', error: true }),
      )
  }, [])

  if (mobile) {
    return (
      <>
        <MobileShell
          stageRef={stageRef}
          onExport={handleExport}
          onCopy={handleCopy}
          onOpenLibrary={() => setLibraryOpen(true)}
        />
        {libraryOpen && <Library onClose={() => { setLibraryOpen(false); syncNow() }} />}
        <HelpPopup />
        {toast && (
          <div className={toast.error ? 'toast toast--error' : 'toast'} role="status" onClick={() => setToast(null)}>
            {toast.text}
          </div>
        )}
      </>
    )
  }

  return (
    <div className="app">
      <Toolbar onExport={handleExport} onCopy={handleCopy} onOpenLibrary={() => setLibraryOpen(true)} />
      <main className="stage-wrap">
        <TitleField />
        <SceneStage stageRef={stageRef} />
        <NoteField />
        <StageHint />
        <Properties />
        <TextEditor />
      </main>
      {libraryOpen && <Library onClose={() => { setLibraryOpen(false); syncNow() }} />}
      <HelpPopup />
      {toast && (
        <div className={toast.error ? 'toast toast--error' : 'toast'} role="status" onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  )
}
