/**
 * How wide a band a line can be picked up by, in screen pixels.
 *
 * A line is drawn a few millimetres wide, and the grab band used to be 60 mm
 * of table - about 10 px on a phone, where the table is a sixth of a pixel per
 * millimetre. A fingertip lands 5-10 px off the line it aims at, so an arrow
 * on a phone could hardly be selected, and so not deleted. The band is now
 * set in screen pixels: about a centimetre under a finger, 24 px for a mouse.
 */
export function lineHitPx(): number {
  const coarse =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(any-pointer: coarse)').matches
  return coarse ? 40 : 24
}
