/**
 * Colours, all drawn by code. Nothing is loaded from a CDN or an image file:
 * a tainted canvas would break `stage.toDataURL`, which is the whole point of
 * the app.
 *
 * The values are tuned for a photographic top-down look: a single soft light
 * from the upper left, matte varnished wood, napped cloth and cloth-covered
 * rubber cushions that sit a clear step below the wood and above the bed.
 */

import type { ClothColor } from './types'

export type ClothPalette = {
  /** felt gradient, light centre to darker edge */
  clothLight: string
  clothDark: string
  /** cushion top, a shade darker than the felt */
  cushion: string
  cushionShade: string
  /** vignette colour painted along the edges of the felt */
  vignette: string
}

export const CLOTH: Record<ClothColor, ClothPalette> = {
  blue: {
    clothLight: '#2A82C4',
    clothDark: '#1D6FA8',
    // the cushion band has to read as a clear step down from the felt
    cushion: '#104168',
    cushionShade: '#092C49',
    vignette: '#06263E',
  },
  green: {
    clothLight: '#2F8D59',
    clothDark: '#20713F',
    cushion: '#12452E',
    cushionShade: '#0A2D1E',
    vignette: '#052318',
  },
  // a tournament red, deep rather than bright: the step from felt to rubber
  // keeps the same ratio as blue and green, so the cushion still reads
  red: {
    clothLight: '#B7333C',
    clothDark: '#97242F',
    cushion: '#5C1520',
    cushionShade: '#3D0D15',
    vignette: '#2C080F',
  },
  // a cool steel grey; light enough that a black ball and the black 8 still
  // separate from it, dark enough that a white ball keeps its edge
  grey: {
    clothLight: '#7E8A94',
    clothDark: '#69747E',
    cushion: '#3E464E',
    cushionShade: '#2A3037',
    vignette: '#1B2025',
  },
}

/** the cloths offered in the settings, in the order they are shown */
export const CLOTH_SWATCHES: { id: ClothColor; label: string; swatch: string }[] = [
  { id: 'blue', label: 'Синее сукно', swatch: '#1D6FA8' },
  { id: 'green', label: 'Зелёное сукно', swatch: '#1F6B41' },
  { id: 'red', label: 'Красное сукно', swatch: '#A52A35' },
  { id: 'grey', label: 'Серое сукно', swatch: '#727D87' },
]

export const isCloth = (v: unknown): v is ClothColor => typeof v === 'string' && v in CLOTH

export const WOOD = {
  // spec section 5 names this range for the rail outright
  dark: '#5A2E19',
  mid: '#6B3820',
  light: '#7A4326',
  /** lighter frame sitting on top of the rail */
  frame: '#8A6040',
  frameHighlight: '#A0764F',
  edgeShadow: '#2A1810',
}

export const METAL = {
  light: '#F6DCA0',
  mid: '#D2A852',
  dark: '#8A6526',
}

export const MARKING = 'rgba(255,255,255,0.38)'
export const MARKING_SPOT = 'rgba(255,255,255,0.72)'
export const SIGHT = '#F4F0E7'
export const POCKET_THROAT = '#0A0705'

export const BALL = {
  white: { base: '#FFFFFF', shade: '#BFC3C7', rim: '#8E9498', text: '#22262A' },
  cue: { base: '#FFC65A', shade: '#E08A12', rim: '#A9630A', text: '#3A2400' },
  target: { base: '#FF6B5A', shade: '#C63A28', rim: '#8E2418', text: '#FFFFFF' },
} as const

/**
 * The pool set, in the colours every set is made in: 1-8 solid, 9-15 the same
 * seven colours again as stripes, the 8 black. Kept a touch deeper than the
 * printed swatches, because the body is lifted towards white under the lamp.
 */
export const POOL_COLOURS: Record<number, string> = {
  1: '#F2B705', // yellow
  2: '#1C4FA8', // blue
  3: '#D3242E', // red
  4: '#5B2A8E', // purple
  5: '#F0661A', // orange
  6: '#0D7C44', // green
  7: '#7E1D27', // maroon
  8: '#17181B', // black
}

/** colour and pattern of pool ball `n` (1..15), or null for anything else */
export function poolBall(n: number | undefined): { colour: string; stripe: boolean } | null {
  if (!n || !Number.isInteger(n) || n < 1 || n > 15) return null
  return n <= 8 ? { colour: POOL_COLOURS[n], stripe: false } : { colour: POOL_COLOURS[n - 8], stripe: true }
}

/** the ball the tool glyph and a generic object ball are drawn as on pool */
export const POOL_GENERIC = POOL_COLOURS[1]

export const SELECTION = '#FFD166'

/** app chrome, kept in sync with styles.css */
export const UI = {
  bg: '#16191D',
  panel: '#1F242A',
  panelEdge: '#2E353D',
  text: '#E8ECF1',
  textDim: '#9BA5B0',
  accent: '#F5A623',
}
