/**
 * The phone layout: a thin top bar, the table filling the middle, a dock of
 * tool icons along the bottom. Export and table settings live in sheets, so
 * the table never has to share the screen with a column of buttons.
 */

import { useState } from 'react'
import type Konva from 'konva'
import { SceneStage } from '../../render/SceneStage'
import { Properties } from '../Properties'
import { TextEditor } from '../TextEditor'
import { selectCanRedo, selectCanUndo, useStore, type Tool } from '../../state/store'
import { useView } from '../../state/view'
import { BALL_SIZES } from '../../model/table'
import { CLOTH_SWATCHES } from '../../model/theme'
import type { ExportFormat } from '../../lib/exportImage'
import { GLYPH, toolsFor } from '../tools'
import { GamePicker, RackButtons } from '../GameControls'
import { useGame } from '../useGame'
import { BrandSign } from '../Brand'
import { DensityPicker } from '../DensityPicker'
import { SyncBadge } from '../SyncBadge'
import { useLibrary } from '../../state/library'
import { Sheet } from './Sheet'
import { HelpDot, HelpGeneralButton } from '../help'

export type MobileShellProps = {
  stageRef: React.MutableRefObject<Konva.Stage | null>
  onExport: (scale: number, format: ExportFormat) => void
  onCopy: (scale: number) => void
  onOpenLibrary: () => void
}

export function MobileShell({ stageRef, onExport, onCopy, onOpenLibrary }: MobileShellProps) {
  const [sheet, setSheet] = useState<'export' | 'menu' | null>(null)
  const tool = useStore((s) => s.tool)
  const game = useGame()
  const setTool = useStore((s) => s.setTool)
  const title = useStore((s) => s.scene.title ?? '')
  const setTitle = useStore((s) => s.setTitle)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const canUndo = useStore(selectCanUndo)
  const canRedo = useStore(selectCanRedo)
  const zoom = useView((s) => s.viewport.zoom)
  const resetViewport = useView((s) => s.resetViewport)

  /* sticky tool: tapping the active one is the way back to select */
  const pick = (id: Tool) => setTool(tool === id && id !== 'select' ? 'select' : id)

  return (
    <div className="m-shell">
      <header className="m-top">
        <BrandSign size={32} />
        <button
          type="button"
          className="btn btn--icon"
          onClick={onOpenLibrary}
          aria-label="Библиотека"
          title="Библиотека"
        >
          {GLYPH.library}
        </button>
        <input
          className="m-top__title"
          type="text"
          value={title}
          placeholder="Название упражнения"
          aria-label="Название упражнения"
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
        />
        {zoom > 1.001 && (
          <button type="button" className="btn btn--icon" onClick={resetViewport} aria-label="Показать весь стол" title="Весь стол">
            {GLYPH.fit}
          </button>
        )}
        <button type="button" className="btn btn--icon" onClick={undo} disabled={!canUndo} aria-label="Отменить">
          {GLYPH.undo}
        </button>
        <button type="button" className="btn btn--icon" onClick={redo} disabled={!canRedo} aria-label="Вернуть">
          {GLYPH.redo}
        </button>
        <button type="button" className="btn btn--icon btn--accent" onClick={() => setSheet('export')} aria-label="Экспорт">
          {GLYPH.share}
        </button>
        <button type="button" className="btn btn--icon" onClick={() => setSheet('menu')} aria-label="Меню">
          {GLYPH.more}
        </button>
        <SyncBadge compact />
      </header>

      <main className="stage-wrap m-stage">
        <SceneStage stageRef={stageRef} />
        <Properties />
        <TextEditor />
      </main>

      <nav className="m-dock" aria-label="Инструменты">
        {toolsFor(game).map((t) => (
          <div key={t.id} className="m-dock__cell">
            <button
              type="button"
              className={tool === t.id ? 'm-dock__tool is-active' : 'm-dock__tool'}
              aria-pressed={tool === t.id}
              aria-label={t.label}
              onClick={() => pick(t.id)}
            >
              {t.icon}
              <span className="m-dock__label">{t.short}</span>
            </button>
            <HelpDot tool={t.id} label={t.label} />
          </div>
        ))}
      </nav>

      <ExportSheet open={sheet === 'export'} onClose={() => setSheet(null)} onExport={onExport} onCopy={onCopy} />
      <MenuSheet open={sheet === 'menu'} onClose={() => setSheet(null)} />
    </div>
  )
}

function ExportSheet({ open, onClose, onExport, onCopy }: { open: boolean; onClose: () => void; onExport: MobileShellProps['onExport']; onCopy: MobileShellProps['onCopy'] }) {
  const [scale, setScale] = useState(2)
  const [format, setFormat] = useState<ExportFormat>('jpeg')
  const note = useStore((s) => s.scene.note ?? '')
  const setNote = useStore((s) => s.setNote)
  return (
    <Sheet title="Экспорт" open={open} onClose={onClose}>
      <textarea
        className="caption caption--note caption--sheet"
        value={note}
        placeholder="Описание под столом (1–3 строки)"
        aria-label="Описание упражнения"
        rows={2}
        maxLength={300}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="row">
        <span className="row__label">Размер</span>
        <span className="seg" role="group" aria-label="Масштаб экспорта">
          {[1, 2, 3].map((s) => (
            <button key={s} type="button" className="btn seg__btn" aria-pressed={scale === s} onClick={() => setScale(s)}>
              {s}x
            </button>
          ))}
        </span>
      </div>
      <div className="row">
        <span className="row__label">Формат</span>
        <span className="seg" role="group" aria-label="Формат файла">
          <button type="button" className="btn seg__btn" aria-pressed={format === 'jpeg'} onClick={() => setFormat('jpeg')}>
            JPEG
          </button>
          <button type="button" className="btn seg__btn" aria-pressed={format === 'png'} onClick={() => setFormat('png')}>
            PNG
          </button>
        </span>
      </div>
      <button
        type="button"
        className="btn btn--primary btn--wide"
        onClick={() => {
          onClose()
          onExport(scale, format)
        }}
      >
        Скачать {format === 'jpeg' ? 'JPEG' : 'PNG'}
      </button>
      <button
        type="button"
        className="btn btn--wide"
        onClick={() => {
          // must stay synchronous inside the tap for Safari's clipboard
          onCopy(scale)
          onClose()
        }}
      >
        Копировать в буфер
      </button>
    </Sheet>
  )
}

function MenuSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const game = useGame()
  const createNew = useLibrary((s) => s.createNew)
  const orientation = useStore((s) => s.orientation)
  const setOrientation = useStore((s) => s.setOrientation)
  const cloth = useStore((s) => s.scene.table.cloth)
  const setCloth = useStore((s) => s.setCloth)
  const ballMm = useStore((s) => s.scene.table.ballMm)
  const setBallMm = useStore((s) => s.setBallMm)
  const markings = useStore((s) => s.scene.table.markings)
  const toggleMarkings = useStore((s) => s.toggleMarkings)
  const snap = useStore((s) => s.snap)
  const toggleSnap = useStore((s) => s.toggleSnap)
  const noOverlap = useStore((s) => s.noOverlap)
  const toggleNoOverlap = useStore((s) => s.toggleNoOverlap)
  /* nothing is lost: the library takes a revision before the table is cleared */
  const askNew = () => {
    void createNew()
    onClose()
  }
  return (
    <Sheet title="Стол" open={open} onClose={onClose}>
      <HelpGeneralButton className="btn btn--quiet" after={onClose} />
      <GamePicker id="game-mobile" />
      <div className="row row--wrap">
        <RackButtons after={onClose} />
        <button type="button" className="btn" onClick={askNew}>
          Новое упражнение
        </button>
      </div>
      <div className="row">
        <span className="row__label">Стол</span>
        <span className="seg" role="group" aria-label="Ориентация">
          <button type="button" className="btn seg__btn" aria-pressed={orientation === 'vertical'} onClick={() => setOrientation('vertical')}>
            Вертикально
          </button>
          <button type="button" className="btn seg__btn" aria-pressed={orientation === 'horizontal'} onClick={() => setOrientation('horizontal')}>
            Горизонтально
          </button>
        </span>
      </div>
      <DensityPicker id="density-mobile" />

      <div className="row">
        <span className="row__label">Сукно</span>
        <span className="row__control">
          {CLOTH_SWATCHES.map((c) => (
            <button key={c.id} type="button" className="swatch swatch--cloth" style={{ background: c.swatch }} aria-pressed={cloth === c.id} aria-label={c.label} onClick={() => setCloth(c.id)} />
          ))}
        </span>
      </div>
      {game === 'pyramid' && (
        <div className="row">
          <label className="row__label" htmlFor="m-ball-mm">
            Диаметр шара
          </label>
          <span className="row__control">
            <select id="m-ball-mm" className="select" value={ballMm} onChange={(e) => setBallMm(Number(e.target.value))}>
              {BALL_SIZES.map((mm) => (
                <option key={mm} value={mm}>
                  {mm}
                </option>
              ))}
            </select>
            <span className="row__unit">мм</span>
          </span>
        </div>
      )}
      <label className="switch">
        <span className="switch__label">Разметка</span>
        <input type="checkbox" className="switch__input" checked={markings} onChange={toggleMarkings} />
        <span className="switch__track">
          <span className="switch__knob" />
        </span>
      </label>
      <label className="switch">
        <span className="switch__label">Магнит к разметке</span>
        <input type="checkbox" className="switch__input" checked={snap} onChange={toggleSnap} />
        <span className="switch__track">
          <span className="switch__knob" />
        </span>
      </label>
      <label className="switch">
        <span className="switch__label">Без наложения</span>
        <input type="checkbox" className="switch__input" checked={noOverlap} onChange={toggleNoOverlap} />
        <span className="switch__track">
          <span className="switch__knob" />
        </span>
      </label>
    </Sheet>
  )
}
