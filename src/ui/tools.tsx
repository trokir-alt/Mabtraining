/**
 * The tool list, shared by the desktop panel and the phone dock. Glyphs are
 * inline vectors: an icon font from a CDN would taint the canvas export.
 */

import type { ReactNode } from 'react'
import type { Tool } from '../state/store'
import type { Game } from '../model/types'
import { POOL_GENERIC } from '../model/theme'

const glyph = (children: ReactNode) => (
  <svg className="glyph" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
    {children}
  </svg>
)

export const GLYPH = {
  cursor: glyph(<path d="M4 2.5 L13.5 9.2 L9.3 10 L11.4 14.4 L9.3 15.4 L7.2 11 L4 13.6 Z" fill="currentColor" />),
  white: glyph(<circle cx="9" cy="9" r="6.2" fill="#FFFFFF" stroke="rgba(0,0,0,.45)" strokeWidth="1" />),
  cue: glyph(<circle cx="9" cy="9" r="6.2" fill="#F5A623" stroke="rgba(0,0,0,.45)" strokeWidth="1" />),
  /** a numbered pool ball: the 1, yellow with its white disc */
  pool: glyph(
    <>
      <circle cx="9" cy="9" r="6.2" fill={POOL_GENERIC} stroke="rgba(0,0,0,.45)" strokeWidth="1" />
      <circle cx="9" cy="9" r="2.8" fill="#FFFFFF" />
    </>,
  ),
  arrow: glyph(
    <>
      <path d="M3 14 L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M8 4 H14 V10" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  ),
  ghost: glyph(
    <>
      <circle cx="4" cy="13" r="2.6" fill="currentColor" opacity=".9" />
      <circle cx="9" cy="9" r="2.6" fill="currentColor" opacity=".55" />
      <circle cx="14" cy="5" r="2.6" fill="currentColor" opacity=".25" />
    </>,
  ),
  rect: glyph(<rect x="3" y="4" width="12" height="10" rx="1.5" fill="currentColor" opacity=".35" stroke="currentColor" strokeWidth="1.5" />),
  ellipse: glyph(<ellipse cx="9" cy="9" rx="6.5" ry="5" fill="currentColor" opacity=".35" stroke="currentColor" strokeWidth="1.5" />),
  line: glyph(<path d="M3 14 L15 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 2.5" />),
  text: glyph(<path d="M4 4 H14 M9 4 V15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />),
  strike: glyph(
    <>
      <circle cx="9" cy="9" r="6.5" fill="#F5A623" stroke="rgba(0,0,0,.5)" strokeWidth="1" />
      <circle cx="9" cy="9" r="3.2" fill="none" stroke="rgba(0,0,0,.5)" strokeWidth="1" />
      <circle cx="11.2" cy="6.6" r="1.7" fill="#E5322D" stroke="#fff" strokeWidth=".7" />
    </>,
  ),
  power: glyph(
    <>
      <rect x="2" y="6" width="3" height="6" rx=".8" fill="#F5A623" />
      <rect x="6" y="6" width="3" height="6" rx=".8" fill="#F5A623" />
      <rect x="10" y="6" width="3" height="6" rx=".8" fill="none" stroke="currentColor" strokeWidth="1" />
      <rect x="14" y="6" width="2.5" height="6" rx=".8" fill="none" stroke="currentColor" strokeWidth="1" />
    </>,
  ),
  ghostBall: glyph(
    <>
      <circle cx="9" cy="9" r="6.2" fill="none" stroke="#F5A623" strokeWidth="1.6" />
      <ellipse cx="9" cy="9" rx="6.2" ry="2.6" fill="none" stroke="#F5A623" strokeWidth="1" opacity=".8" />
      <ellipse cx="9" cy="9" rx="2.6" ry="6.2" fill="none" stroke="#F5A623" strokeWidth="1" opacity=".8" />
    </>,
  ),
  /** two balls with a row of ghosts touching between them */
  measure: glyph(
    <>
      <circle cx="2.6" cy="9" r="2.1" fill="currentColor" />
      <circle cx="6.8" cy="9" r="1.8" fill="none" stroke="currentColor" strokeWidth=".9" />
      <circle cx="11" cy="9" r="1.8" fill="none" stroke="currentColor" strokeWidth=".9" />
      <circle cx="15.4" cy="9" r="2.1" fill="currentColor" />
      <path d="M2.6 13.6 H15.4 M2.6 12.6 V14.6 M15.4 12.6 V14.6" stroke="currentColor" strokeWidth=".9" strokeLinecap="round" />
    </>,
  ),
  undo: glyph(<path d="M7 5 L3 9 L7 13 M3 9 H11 A4 4 0 0 1 11 17 H9" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />),
  redo: glyph(<path d="M11 5 L15 9 L11 13 M15 9 H7 A4 4 0 0 0 7 17 H9" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />),
  share: glyph(<path d="M9 11 V3 M5.5 6.5 L9 3 L12.5 6.5 M4 10 V15 H14 V10" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />),
  more: glyph(<><circle cx="4" cy="9" r="1.6" fill="currentColor" /><circle cx="9" cy="9" r="1.6" fill="currentColor" /><circle cx="14" cy="9" r="1.6" fill="currentColor" /></>),
  library: glyph(
    <>
      <rect x="3" y="3.5" width="4" height="11" rx="1" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <rect x="8.5" y="3.5" width="4" height="11" rx="1" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M14.2 4.6 L16.2 14.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </>,
  ),
  fit: glyph(<path d="M3 7 V3 H7 M11 3 H15 V7 M15 11 V15 H11 M7 15 H3 V11" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />),
}

export const TOOLS: { id: Tool; label: string; short: string; icon: ReactNode }[] = [
  { id: 'select', label: 'Выбор', short: 'Выбор', icon: GLYPH.cursor },
  { id: 'ball-white', label: 'Белый шар', short: 'Шар', icon: GLYPH.white },
  { id: 'ball-cue', label: 'Биток', short: 'Биток', icon: GLYPH.cue },
  { id: 'arrow', label: 'Стрелка', short: 'Стрелка', icon: GLYPH.arrow },
  { id: 'ghost', label: 'Траектория', short: 'Траект.', icon: GLYPH.ghost },
  { id: 'line', label: 'Линия', short: 'Линия', icon: GLYPH.line },
  { id: 'zone-rect', label: 'Зона', short: 'Зона', icon: GLYPH.rect },
  { id: 'zone-ellipse', label: 'Эллипс', short: 'Эллипс', icon: GLYPH.ellipse },
  { id: 'text', label: 'Текст', short: 'Текст', icon: GLYPH.text },
  { id: 'strike', label: 'Точка на шаре', short: 'Точка', icon: GLYPH.strike },
  { id: 'power', label: 'Сила удара', short: 'Сила', icon: GLYPH.power },
  { id: 'ghost-ball', label: 'Шар-призрак', short: 'Призрак', icon: GLYPH.ghostBall },
  { id: 'measure', label: 'Расстояние в шарах', short: 'Расст.', icon: GLYPH.measure },
]

/**
 * The same tools on a pool table, where the two ball tools mean the other
 * pair: an object ball is a numbered one, and the cue ball is white.
 */
const POOL_BALL_TOOLS: Partial<Record<Tool, { label: string; short: string; icon: ReactNode }>> = {
  'ball-white': { label: 'Номерной шар', short: 'Шар', icon: GLYPH.pool },
  'ball-cue': { label: 'Биток', short: 'Биток', icon: GLYPH.white },
}

export function toolsFor(game: Game) {
  if (game !== 'pool') return TOOLS
  return TOOLS.map((t) => ({ ...t, ...(POOL_BALL_TOOLS[t.id] ?? {}) }))
}
