/**
 * The identity in the interface: the horizontal lockup where there is room for
 * it, the monogram alone where there is not.
 *
 * Both are the brand package's SVG, inlined as a `data:` URI - the same rule
 * the canvas follows, so there is one asset pipeline and no request to fail.
 */

import { LOGO_HORIZONTAL_SVG, SIGN_SVG } from '../brand/assets'
import { svgDataUri } from '../brand/svgImage'

const HORIZONTAL = svgDataUri(LOGO_HORIZONTAL_SVG)
const SIGN = svgDataUri(SIGN_SVG)

const NAME = 'МАБ — Международная Академия Бильярда'

/** the pyramid and «МАБ»; 956 x 252 in the package, so 244 wide is 64 tall */
export function BrandLockup() {
  return <img className="brand__lockup" src={HORIZONTAL} alt={NAME} width={244} height={64} />
}

/** the pyramid alone; the package asks for at least 32 px */
export function BrandSign({ size = 32 }: { size?: number }) {
  return <img className="brand__sign" src={SIGN} alt={NAME} width={size} height={size} />
}
