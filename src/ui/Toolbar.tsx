/**
 * Left-hand control panel. Plain DOM - the millimetre coordinate system of the
 * canvas stops at the Konva layer, so everything here is ordinary CSS pixels.
 *
 * Every store read is a scalar selector: zustand v5 compares snapshots by
 * identity, so returning a fresh object or array from a selector would loop.
 */

import { useState } from 'react'
import { selectCanRedo, selectCanUndo, useStore, type Tool } from '../state/store'
import { BALL_SIZES } from '../model/table'
import { CLOTH_SWATCHES } from '../model/theme'
import type { ExportFormat } from '../lib/exportImage'

export type ToolbarProps = {
  /** the parent owns the Konva stage, so export is a callback */
  onExport: (scale: number, format: ExportFormat) => void
  /** must run synchronously inside the click, see copyExportToClipboard */
  onCopy: (scale: number) => void
  onOpenLibrary: () => void
}

const EXPORT_SCALES = [1, 2, 3]

import { toolsFor } from './tools'
import { HelpDot, HelpGeneralButton } from './help'
import { GamePicker, RackButtons } from './GameControls'
import { useGame } from './useGame'
import { BrandLockup } from './Brand'
import { DensityPicker } from './DensityPicker'
import { SyncBadge } from './SyncBadge'
import { useLibrary } from '../state/library'

export function Toolbar({ onExport, onCopy, onOpenLibrary }: ToolbarProps) {
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  const createNew = useLibrary((s) => s.createNew)
  const libraryCount = useLibrary((s) => s.items.filter((m) => m.deletedAt === null).length)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const canUndo = useStore(selectCanUndo)
  const canRedo = useStore(selectCanRedo)
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
  const game = useGame()

  const [exportScale, setExportScale] = useState(2)
  const [format, setFormat] = useState<ExportFormat>('jpeg')

  /* the tool is sticky; tapping the active one again is the way back to select */
  const pick = (id: Tool) => setTool(tool === id && id !== 'select' ? 'select' : id)

  /* the current exercise is saved by the library first, so "new" costs nothing */
  const askNew = () => void createNew()

  return (
    <aside className="toolbar">
      <div className="brand">
        <BrandLockup />
      </div>
      <section className="tool-group">
        <div className="tool-group__body">
          <button type="button" className="btn btn--primary" onClick={onOpenLibrary}>
            <span>Библиотека</span>
            <span className="btn__hint">{libraryCount}</span>
          </button>
          <SyncBadge />
          <HelpGeneralButton className="btn btn--quiet" />
        </div>
      </section>
      <section className="tool-group">
        <h2 className="tool-group__title">Инструменты</h2>
        <div className="tool-group__body tool-grid">
          {toolsFor(game).map((t) => (
            <div key={t.id} className="tool-cell">
              <button
                type="button"
                className={tool === t.id ? 'btn btn--tool is-active' : 'btn btn--tool'}
                aria-pressed={tool === t.id}
                onClick={() => pick(t.id)}
                title={t.label}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
              <HelpDot tool={t.id} label={t.label} />
            </div>
          ))}
        </div>
      </section>

      <section className="tool-group">
        <h2 className="tool-group__title">Расстановка</h2>
        <div className="tool-group__body">
          {/* the game first: it decides which racks there are and what every
              ball on the table looks like */}
          <GamePicker id="game-desktop" />
          <RackButtons />
          <button type="button" className="btn" onClick={askNew}>
            Новое упражнение
          </button>
        </div>
      </section>

      <section className="tool-group tool-group--export">
        <h2 className="tool-group__title">Экспорт</h2>
        <div className="tool-group__body">
          <div className="row">
            <span className="row__label">Размер</span>
            <span className="seg" role="group" aria-label="Масштаб экспорта">
              {EXPORT_SCALES.map((scale) => (
                <button
                  key={scale}
                  type="button"
                  className="btn seg__btn"
                  aria-pressed={exportScale === scale}
                  onClick={() => setExportScale(scale)}
                >
                  {scale}x
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
          <button type="button" className="btn btn--primary" onClick={() => onExport(exportScale, format)}>
            Скачать {format === 'jpeg' ? 'JPEG' : 'PNG'}
          </button>
          <button type="button" className="btn" onClick={() => onCopy(exportScale)}>
            Копировать в буфер
          </button>
        </div>
      </section>

      <section className="tool-group">
        <h2 className="tool-group__title">История</h2>
        <div className="tool-group__body">
          <button type="button" className="btn" onClick={undo} disabled={!canUndo}>
            <span>Отменить</span>
            <span className="btn__hint">
              <kbd>Ctrl</kbd>
              <kbd>Z</kbd>
            </span>
          </button>
          <button type="button" className="btn" onClick={redo} disabled={!canRedo}>
            <span>Вернуть</span>
            <span className="btn__hint">
              <kbd>Ctrl</kbd>
              <kbd>Shift</kbd>
              <kbd>Z</kbd>
            </span>
          </button>
        </div>
      </section>

      <section className="tool-group">
        <h2 className="tool-group__title">Стол</h2>
        <div className="tool-group__body">
          <button type="button" className="btn" aria-pressed={orientation === 'horizontal'} onClick={() => setOrientation('horizontal')}>
            Горизонтально
          </button>
          <button type="button" className="btn" aria-pressed={orientation === 'vertical'} onClick={() => setOrientation('vertical')}>
            Вертикально
          </button>

          <div className="row">
            <span className="row__label">Сукно</span>
            <span className="row__control">
              {CLOTH_SWATCHES.map((c) => (
                <button key={c.id} type="button" className="swatch swatch--cloth" style={{ background: c.swatch }} aria-pressed={cloth === c.id} aria-label={c.label} title={c.label} onClick={() => setCloth(c.id)} />
              ))}
            </span>
          </div>

          {/* pool is played with one ball, 57.15 mm; there is nothing to choose */}
          {game === 'pyramid' && (
            <div className="row">
              <label className="row__label" htmlFor="ball-mm">
                Диаметр шара
              </label>
              <span className="row__control">
                <select id="ball-mm" className="select" value={ballMm} onChange={(e) => setBallMm(Number(e.target.value))}>
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

          <DensityPicker id="density-desktop" />

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
        </div>
      </section>
    </aside>
  )
}
