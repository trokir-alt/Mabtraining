/**
 * Help: a small «?» on every tool and one «Как пользоваться» for the basics.
 * The words are in helpText.ts.
 *
 * On a desktop the help opens as a card beside the tool panel; on a phone, as
 * a bottom sheet like the other panels there.
 */

import { useEffect } from 'react'
import type { Tool } from '../state/store'
import { HELP, useHelp, type Anchor, type HelpEntry } from './helpText'
import { Sheet } from './mobile/Sheet'
import { useIsMobile } from './useMedia'

const rectOf = (el: Element): Anchor => {
  const r = el.getBoundingClientRect()
  const panel = el.closest('.toolbar')?.getBoundingClientRect().right ?? 0
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, panel }
}

/** The small «?» in the corner of a tool button. Never switches the tool. */
export function HelpDot({ tool, label }: { tool: Tool; label: string }) {
  return (
    <button
      type="button"
      className="help-dot"
      aria-label={`Подсказка: ${label}`}
      title="Подсказка"
      onClick={(e) => {
        e.stopPropagation()
        useHelp.getState().show(tool, rectOf(e.currentTarget), label)
      }}
    >
      ?
    </button>
  )
}

/** «Как пользоваться»: the basics, in one place. */
export function HelpGeneralButton({ className = 'btn', after }: { className?: string; after?: () => void }) {
  return (
    <button
      type="button"
      className={className}
      onClick={(e) => {
        after?.()
        useHelp.getState().show('general', rectOf(e.currentTarget))
      }}
    >
      <span className="help-dot help-dot--inline" aria-hidden="true">
        ?
      </span>
      <span>Как пользоваться</span>
    </button>
  )
}

function HelpBody({ entry }: { entry: HelpEntry }) {
  return (
    <div className="help-body">
      <p className="help-body__intro">{entry.intro}</p>
      {entry.sections.map((s) => (
        <section key={s.head} className="help-body__section">
          <h3 className="help-body__head">{s.head}</h3>
          {s.text.map((t, i) => (
            <p key={i} className="help-body__text">
              {t}
            </p>
          ))}
        </section>
      ))}
    </div>
  )
}

const CARD_W = 340
const GAP = 10

/**
 * Where the card goes: past the tool panel, so the tools stay in sight, and
 * level with the button. For a button in the lower half the card stands on
 * the bottom of the window instead and grows upwards, so a long text is not
 * squeezed into the space under the button; either way it scrolls inside
 * rather than outgrowing the window.
 */
function cardStyle(a: Anchor): React.CSSProperties {
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = Math.max(a.right, a.panel) + GAP
  if (left + CARD_W > vw - 8) left = Math.max(8, a.left - GAP - CARD_W)
  if (a.top < vh / 2) {
    const top = Math.max(8, a.top - 8)
    return { width: CARD_W, left, top, maxHeight: vh - top - 8 }
  }
  return { width: CARD_W, left, bottom: 8, maxHeight: vh - 16 }
}

export function HelpPopup() {
  const open = useHelp((s) => s.open)
  const anchor = useHelp((s) => s.anchor)
  const shownTitle = useHelp((s) => s.title)
  const close = useHelp((s) => s.close)
  const mobile = useIsMobile()

  // Esc closes the help and nothing else: the canvas would otherwise also
  // take it as "drop the tool"
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, close])

  if (!open) return null
  const entry = HELP[open]
  const title = shownTitle ?? entry.title
  if (mobile || !anchor) {
    return (
      <Sheet title={title} open onClose={close}>
        <HelpBody entry={entry} />
      </Sheet>
    )
  }
  return (
    <div className="help-pop" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="help-pop__backdrop" aria-label="Закрыть подсказку" onClick={close} />
      <div className="help-pop__card" style={cardStyle(anchor)}>
        <div className="help-pop__head">
          <h2 className="help-pop__title">{title}</h2>
          <button type="button" className="btn btn--icon" onClick={close} aria-label="Закрыть">
            ✕
          </button>
        </div>
        <HelpBody entry={entry} />
      </div>
    </div>
  )
}
