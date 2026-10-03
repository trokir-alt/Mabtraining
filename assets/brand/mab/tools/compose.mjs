/**
 * Step 2 of 2: the logo variants, from paths.json (tools/trace.mjs) plus the
 * balls and the bar built from their measurements.
 *   node tools/compose.mjs ..   (the package directory)
 */
import fs from 'node:fs'
const { letters, subtitle } = JSON.parse(fs.readFileSync('paths.json', 'utf8'))
const OUT = process.argv[2]
const BLUE = '#72D0F7'
const WHITE = '#FFFFFF'
// the pyramid, regularised from the measured centres: pitch 92.05, rows 82.25 apart, r 35.3
const R = 35.3, PX = 92.05, PY = 82.25, CX = 288.1, TOPY = 257.9
const balls = [
  [CX, TOPY],
  [CX - PX / 2, TOPY + PY], [CX + PX / 2, TOPY + PY],
  [CX - PX, TOPY + 2 * PY], [CX, TOPY + 2 * PY], [CX + PX, TOPY + 2 * PY],
]
const round1 = (d) => d.replace(/-?\d+\.\d+/g, (n) => (Math.round(parseFloat(n) * 10) / 10).toString())
const L = round1(letters), SUB = round1(subtitle)
/** colour: the brand's blue-and-white, or all one ink for a watermark */
const pyramid = (mono) =>
  balls.map(([x, y], i) => `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${R}" fill="${mono ? mono : i === 5 ? WHITE : BLUE}"/>`).join('')
const bar = (ink) => `<rect x="487" y="224" width="18" height="80" fill="${ink}"/><rect x="487" y="375" width="18" height="82" fill="${ink}"/>`
const word = (ink) => `<path d="${L}" fill="${ink}" fill-rule="evenodd"/>`
const line = (ink) => `<path d="${SUB}" fill="${ink}" fill-rule="evenodd"/>`
const svg = (w, h, vb, title, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${vb}" role="img"><title>${title}</title>${body}</svg>\n`

fs.mkdirSync(`${OUT}/logos`, { recursive: true })
fs.mkdirSync(`${OUT}/watermarks`, { recursive: true })
// full: mark, word and the academy's name under them
fs.writeFileSync(`${OUT}/logos/mab-full-white.svg`, svg(960, 352, '150 212 960 352', 'МАБ — Международная Академия Бильярда', pyramid() + bar(WHITE) + word(WHITE) + line(WHITE)))
// horizontal: mark and word, for the header
fs.writeFileSync(`${OUT}/logos/mab-horizontal-white.svg`, svg(956, 252, '152 214 956 252', 'МАБ — horizontal, white', pyramid() + bar(WHITE) + word(WHITE)))
// the sign: the pyramid alone, on a square
fs.writeFileSync(`${OUT}/logos/mab-sign.svg`, svg(270, 270, '153.1 205.2 270 270', 'МАБ — sign', pyramid()))
fs.writeFileSync(`${OUT}/logos/mab-sign-white.svg`, svg(270, 270, '153.1 205.2 270 270', 'МАБ — sign, white', pyramid(WHITE)))
// the watermark stamp: one white mark centred in the 206 x 42 box the grid is laid out for
const cw = 1098 - 160.7, ch = 457.7 - 222.6, s = (42 * 0.9) / ch
const ox = (206 - cw * s) / 2 - 160.7 * s, oy = (42 - ch * s) / 2 - 222.6 * s
fs.writeFileSync(
  `${OUT}/watermarks/mab-stamp-white.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" width="206" height="42" viewBox="0 0 206 42"><g transform="translate(${ox.toFixed(3)} ${oy.toFixed(3)}) scale(${s.toFixed(5)})">${pyramid(WHITE)}${bar(WHITE)}${word(WHITE)}</g></svg>\n`,
)
for (const f of ['logos/mab-full-white.svg', 'logos/mab-horizontal-white.svg', 'logos/mab-sign.svg', 'watermarks/mab-stamp-white.svg'])
  console.log(f, (fs.statSync(`${OUT}/${f}`).size / 1024).toFixed(1), 'KB')
