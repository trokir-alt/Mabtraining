/**
 * Properties of the selected object. Floats next to it on a desktop and sits
 * in a strip at the bottom of the screen on a phone; the CSS decides which.
 *
 * Only the controls that mean something for the selected type are shown - a
 * caption has no stroke width and a zone has no arrowhead.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { mmToCss, useView } from '../state/view'
import { FULLNESS_STEPS, STRIKE_SIZES, itemBounds } from '../model/item'
import { INK, STROKE_WIDTHS, TEXT_SIZES } from '../model/style'
import { gameOf, scaledPreset } from '../model/game'
import { PoolBallPicker } from './GameControls'
import { formatPower } from '../model/item'
import { formatBalls, formatGap, measureEnds, measureLayout } from '../model/measure'
import { useIsMobile } from './useMedia'

export function Properties() {
  const selectedId = useStore((s) => s.selectedId)
  const item = useStore((s) => s.scene.items.find((i) => i.id === s.selectedId))
  const ballMm = useStore((s) => s.scene.table.ballMm)
  const table = useStore((s) => s.scene.table)
  const items = useStore((s) => s.scene.items)
  const tool = useStore((s) => s.tool)
  const view = useView()
  const mobile = useIsMobile()
  /**
   * The panel's own width, measured. The clamp below used to assume 160 px,
   * which every panel was until the pool ball picker - sixteen balls in two
   * rows - and a ball near the right cushion then pushed half the picker off
   * the screen. Measured after each render, so any panel is kept inside.
   */
  const ref = useRef<HTMLDivElement>(null)
  const [panelW, setPanelW] = useState(160)
  // what the panel holds is decided by the item and the tool; nothing else
  // changes its width
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth
    if (w && Math.abs(w - panelW) > 1) setPanelW(w)
  }, [item, tool, panelW])

  const pos = useMemo(() => {
    if (!item || !view.layout) return null
    const b = itemBounds(item, ballMm, items)
    // anchor under the object's bounding box, in css px inside .stage-wrap
    const corners = [
      mmToCss(view, { x: b.x, y: b.y }),
      mmToCss(view, { x: b.x + b.w, y: b.y }),
      mmToCss(view, { x: b.x, y: b.y + b.h }),
      mmToCss(view, { x: b.x + b.w, y: b.y + b.h }),
    ]
    const ys = corners.map((c) => c.y)
    // on a phone: is the object in the lower half of the canvas?
    const mid = view.wrap.top + view.stageTop + view.layout.stageH / 2
    /**
     * Keep the panel inside the canvas area.
     *
     * Without the clamp it follows the object out of the stage: on a tablet
     * in portrait the table stands tall and narrow, an object near the left
     * cushion puts the panel at a negative offset, and it lands on top of the
     * toolbar. Measured on a 1024-wide screen: it covered «Вернуть» and
     * «Горизонтально», which then could not be pressed at all while anything
     * was selected.
     */
    const minLeft = view.wrap.left + 8
    const maxLeft = Math.max(minLeft, view.wrap.left + view.wrap.width - panelW - 8)
    const raw = Math.min(...corners.map((c) => c.x))
    return {
      left: Math.max(minLeft, Math.min(raw, maxLeft)),
      top: Math.max(...ys) + 12,
      low: (Math.min(...ys) + Math.max(...ys)) / 2 > mid,
    }
  }, [item, ballMm, items, view, panelW])

  if (!item || !selectedId || tool !== 'select') return null
  const st = useStore.getState()
  const t = item.type

  // a widget has no colour field: six ink swatches on it stamp a key the type
  // does not have, and the coach clicks red and nothing turns red
  const hasColor = t !== 'ball' && t !== 'strikePoint' && t !== 'power' && t !== 'ghostBall'
  const hasWidth = t === 'arrow' || t === 'line'
  const hasStyle = t === 'arrow' || t === 'line'
  const hasHead = t === 'arrow'
  const hasGhost = t === 'ghostTrail'
  const hasText = t === 'text'
  const hasZone = t === 'zone'
  const hasBall = t === 'ball'
  const hasStrike = t === 'strikePoint'
  const hasPower = t === 'power'
  const hasMeasure = t === 'measure'
  const ends = hasMeasure ? measureEnds(item, items) : null
  const ruler = ends ? measureLayout(ends[0], ends[1], ballMm) : null

  const color = 'color' in item ? item.color : null
  const pool = gameOf(table) === 'pool'
  // every preset is shown and matched as it comes out on THIS table
  const on = (referenceMm: number) => scaledPreset(referenceMm, table)

  return (
    <div
      ref={ref}
      className={mobile && pos?.low ? 'props props--top' : 'props'}
      role="toolbar"
      aria-label="Свойства объекта"
      style={pos ? { left: pos.left, top: pos.top } : undefined}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {hasColor && (
        <div className="props__row">
          {INK.map((c) => (
            <button
              key={c.id}
              type="button"
              className="swatch swatch--sm"
              style={{ background: c.value }}
              aria-pressed={color === c.value}
              aria-label={c.label}
              title={c.label}
              onClick={() => st.setInk(c.value)}
            />
          ))}
        </div>
      )}

      {hasBall && pool && (
        <div className="props__row">
          <PoolBallPicker item={item} />
        </div>
      )}

      {/* a numbered ball carries its number; only the cue ball can take a mark */}
      {hasBall && pool && item.kind === 'cue' && (
        <div className="props__row">
          <span className="props__label">Подпись</span>
          <input
            className="input input--sm"
            type="text"
            maxLength={2}
            placeholder="A"
            aria-label="Подпись на шаре"
            value={item.label ?? ''}
            onChange={(e) => st.updateItemLive(item.id, { label: e.target.value.trim() || undefined })}
            onBlur={() => st.beginHistory()}
          />
        </div>
      )}

      {hasBall && !pool && (
        <div className="props__row">
          <span className="seg">
            <button type="button" className="btn seg__btn" aria-pressed={item.kind === 'white'} onClick={() => st.updateItem(item.id, { kind: 'white' })}>
              Белый
            </button>
            <button type="button" className="btn seg__btn" aria-pressed={item.kind === 'cue'} onClick={() => st.updateItem(item.id, { kind: 'cue' })}>
              Биток
            </button>
          </span>
          <input
            className="input input--sm"
            type="text"
            maxLength={2}
            placeholder="№"
            aria-label="Подпись на шаре"
            value={item.label ?? ''}
            onChange={(e) => st.updateItemLive(item.id, { label: e.target.value.trim() || undefined })}
            onBlur={() => st.beginHistory()}
          />
        </div>
      )}

      {(hasWidth || hasStyle || hasHead) && (
        <div className="props__row">
          {hasWidth && (
            <span className="seg" role="group" aria-label="Толщина">
              {STROKE_WIDTHS.map((w) => (
                <button key={w} type="button" className="btn seg__btn" aria-pressed={'width' in item && item.width === on(w)} onClick={() => st.setWidth(w)} title={`${on(w)} мм`}>
                  <span className="stroke-sample" style={{ height: Math.max(2, w / 3) }} />
                </button>
              ))}
            </span>
          )}
          {hasStyle && (
            <span className="seg" role="group" aria-label="Стиль линии">
              <button type="button" className="btn seg__btn" aria-pressed={'style' in item && item.style === 'solid'} onClick={() => st.setStyle('solid')}>
                ━
              </button>
              <button type="button" className="btn seg__btn" aria-pressed={'style' in item && item.style === 'dashed'} onClick={() => st.setStyle('dashed')}>
                ╍
              </button>
            </span>
          )}
          {hasHead && (
            <span className="seg" role="group" aria-label="Наконечник">
              <button type="button" className="btn seg__btn" aria-pressed={item.head === 'end'} onClick={() => st.setHead('end')} title="В конце">
                →
              </button>
              <button type="button" className="btn seg__btn" aria-pressed={item.head === 'both'} onClick={() => st.setHead('both')} title="С обеих сторон">
                ↔
              </button>
              <button type="button" className="btn seg__btn" aria-pressed={item.head === 'none'} onClick={() => st.setHead('none')} title="Без наконечника">
                —
              </button>
            </span>
          )}
        </div>
      )}

      {hasGhost && (
        <div className="props__row">
          <span className="props__label">Шаров</span>
          <span className="seg" role="group" aria-label="Число шаров">
            <button type="button" className="btn seg__btn" onClick={() => st.adjustGhostCount(item.id, -1)} disabled={item.count <= 3} aria-label="Меньше">
              −
            </button>
            <span className="seg__value" aria-live="polite">
              {item.count}
            </span>
            <button type="button" className="btn seg__btn" onClick={() => st.adjustGhostCount(item.id, 1)} disabled={item.count >= 8} aria-label="Больше">
              +
            </button>
          </span>
          <label className="switch switch--inline">
            <span className="switch__label">Стрелка</span>
            <input type="checkbox" className="switch__input" checked={item.head} onChange={() => st.updateItem(item.id, { head: !item.head })} />
            <span className="switch__track">
              <span className="switch__knob" />
            </span>
          </label>
        </div>
      )}

      {hasZone && (
        <div className="props__row">
          <span className="seg" role="group" aria-label="Форма зоны">
            <button type="button" className="btn seg__btn" aria-pressed={item.shape === 'rect'} onClick={() => st.updateItem(item.id, { shape: 'rect' })}>
              Прямоугольник
            </button>
            <button type="button" className="btn seg__btn" aria-pressed={item.shape === 'ellipse'} onClick={() => st.updateItem(item.id, { shape: 'ellipse' })}>
              Эллипс
            </button>
          </span>
        </div>
      )}

      {hasText && (
        <div className="props__row">
          <span className="seg" role="group" aria-label="Размер текста">
            {TEXT_SIZES.map((sz, i) => (
              <button key={sz} type="button" className="btn seg__btn" aria-pressed={item.size === on(sz)} onClick={() => st.setTextSize(sz)} title={`${on(sz)} мм`}>
                {['S', 'M', 'L'][i]}
              </button>
            ))}
          </span>
          <button type="button" className="btn" onClick={() => useView.getState().setEditing(item.id)}>
            Изменить текст
          </button>
        </div>
      )}

      {hasStrike && (
        <div className="props__row">
          <span className="props__label">Размер</span>
          <span className="seg" role="group" aria-label="Размер шара">
            {STRIKE_SIZES.map((mm) => (
              <button key={mm} type="button" className="btn seg__btn" aria-pressed={item.sizeMm === on(mm)} onClick={() => st.setStrikeSize(item.id, on(mm))}>
                {on(mm)}
              </button>
            ))}
          </span>
          <button type="button" className="btn" onClick={() => st.resetDot(item.id)} disabled={item.dot.u === 0 && item.dot.v === 0}>
            Точку в центр
          </button>
        </div>
      )}

      {hasStrike && (
        <div className="props__row" aria-label="Второй шар">
          {!item.companion ? (
            <button type="button" className="btn" onClick={() => st.setCompanion(item.id, 'right')}>
              Прицельный шар
            </button>
          ) : (
            <>
              <span className="props__label">Какой частью</span>
              <span className="seg" role="group" aria-label="Полнота удара">
                {FULLNESS_STEPS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    className="btn seg__btn"
                    aria-pressed={Math.abs(item.companion!.fullness - f.value) < 0.02}
                    onClick={() => st.setFullness(item.id, f.value)}
                  >
                    {f.label}
                  </button>
                ))}
              </span>
              <span className="seg" role="group" aria-label="Сторона прицельного шара">
                <button type="button" className="btn seg__btn" aria-pressed={item.companion!.side === 'left'} onClick={() => st.setCompanion(item.id, 'left')}>
                  Слева
                </button>
                <button type="button" className="btn seg__btn" aria-pressed={item.companion!.side === 'right'} onClick={() => st.setCompanion(item.id, 'right')}>
                  Справа
                </button>
              </span>
              <button type="button" className="btn btn--danger" onClick={() => st.setCompanion(item.id, null)}>
                Убрать
              </button>
            </>
          )}
        </div>
      )}

      {hasPower && (
        <div className="props__row">
          <span className="props__label">Сила</span>
          <span className="seg" role="group" aria-label="Сила удара">
            <button type="button" className="btn seg__btn" onClick={() => st.adjustPower(item.id, -1)} disabled={item.value <= 0.5} aria-label="Слабее">
              −
            </button>
            <span className="seg__value" aria-live="polite">
              {formatPower(item.value)}
            </span>
            <button type="button" className="btn seg__btn" onClick={() => st.adjustPower(item.id, 1)} disabled={item.value >= 4.5} aria-label="Сильнее">
              +
            </button>
          </span>
        </div>
      )}

      {hasMeasure && ruler && (
        <div className="props__row">
          <span className="props__label" aria-live="polite" data-testid="measure-readout">
            {formatBalls(ruler.balls)} · {formatGap(ruler.gap, ballMm)}
          </span>
        </div>
      )}

      {hasMeasure && (
        <div className="props__row">
          <span className="seg" role="group" aria-label="Призраки">
            <button type="button" className="btn seg__btn" aria-pressed={!item.fill} onClick={() => st.updateItem(item.id, { fill: false })}>
              Контур
            </button>
            <button type="button" className="btn seg__btn" aria-pressed={item.fill === true} onClick={() => st.updateItem(item.id, { fill: true })}>
              Закрашенные
            </button>
          </span>
        </div>
      )}

      {hasMeasure && (
        <div className="props__row">
          <label className="switch switch--inline">
            <span className="switch__label">Подпись</span>
            <input type="checkbox" className="switch__input" checked={item.label} onChange={() => st.updateItem(item.id, { label: !item.label })} />
            <span className="switch__track">
              <span className="switch__knob" />
            </span>
          </label>
          <button type="button" className="btn" onClick={() => st.updateItem(item.id, { a: item.b, b: item.a })} title="Призраки встанут от другого шара">
            От другого шара
          </button>
        </div>
      )}

      {mobile && !hasMeasure && (
        <div className="props__row props__row--nudge" aria-label="Сдвиг на 5 мм">
          <button type="button" className="btn btn--icon" onClick={() => st.nudgeSelected(-5, 0)} aria-label="Влево 5 мм">←</button>
          <button type="button" className="btn btn--icon" onClick={() => st.nudgeSelected(0, -5)} aria-label="Вверх 5 мм">↑</button>
          <button type="button" className="btn btn--icon" onClick={() => st.nudgeSelected(0, 5)} aria-label="Вниз 5 мм">↓</button>
          <button type="button" className="btn btn--icon" onClick={() => st.nudgeSelected(5, 0)} aria-label="Вправо 5 мм">→</button>
          <span className="props__label">5 мм</span>
        </div>
      )}

      <div className="props__row">
        <button type="button" className="btn btn--icon" onClick={() => st.bringToFront(item.id)} title="На передний план" aria-label="На передний план">
          ⬆
        </button>
        <button type="button" className="btn btn--icon" onClick={() => st.sendToBack(item.id)} title="На задний план" aria-label="На задний план">
          ⬇
        </button>
        {!hasMeasure && (
          <button type="button" className="btn" onClick={() => st.duplicateSelected()} title="Ctrl+D">
            Дублировать
          </button>
        )}
        <button type="button" className="btn btn--danger" onClick={() => st.removeSelected()} title="Delete">
          Удалить
        </button>
      </div>
    </div>
  )
}
