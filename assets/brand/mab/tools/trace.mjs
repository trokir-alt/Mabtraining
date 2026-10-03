/**
 * Step 1 of 2: trace «МАБ» and the academy's name out of source/mab-logo.png.
 *
 * Not part of the build. Run from assets/brand/mab with the source copied
 * next to it as logo-src.png:
 *   npm i --no-save potrace pngjs && node tools/trace.mjs   -> paths.json
 * then tools/compose.mjs writes the SVGs from paths.json.
 */
import fs from 'node:fs'
import { PNG } from 'pngjs'
import potrace from 'potrace'

const src = PNG.sync.read(fs.readFileSync('logo-src.png'))
const { width: W, height: H, data } = src
const alpha = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : data[(y * W + x) * 4 + 3] / 255)

/** crop a region, upscale K times with bilinear alpha, black ink on white */
function region(x0, y0, x1, y1, K, keep = () => true) {
  const w = (x1 - x0) * K, h = (y1 - y0) * K
  const out = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = x0 + (x + 0.5) / K - 0.5, fy = y0 + (y + 0.5) / K - 0.5
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy
    const a = (alpha(ix, iy) * (1 - tx) + alpha(ix + 1, iy) * tx) * (1 - ty) + (alpha(ix, iy + 1) * (1 - tx) + alpha(ix + 1, iy + 1) * tx) * ty
    const v = keep(fx, fy) ? Math.round(255 * (1 - a)) : 255
    const i = (y * w + x) * 4
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v
    out.data[i + 3] = 255
  }
  return PNG.sync.write(out)
}

const trace = (buf) =>
  new Promise((res, rej) =>
    potrace.trace(buf, { threshold: 128, turdSize: 8, optTolerance: 0.15, alphaMax: 1.0, color: '#FFFFFF', background: 'transparent' }, (err, svg) => (err ? rej(err) : res(svg))),
  )

/** absolute potrace path, mapped back from the upscaled crop to source px */
function remap(svg, x0, y0, K) {
  const d = /\sd="([^"]+)"/.exec(svg)[1]
  let k = 0
  return d.replace(/-?\d+(\.\d+)?/g, (n) => {
    const v = parseFloat(n)
    const r = k++ % 2 === 0 ? x0 + v / K : y0 + v / K
    return (Math.round(r * 100) / 100).toString()
  })
}

const K = 4
const letters = [570, 240, 1106, 444]
const subtitle = [154, 494, 1106, 558]
const out = {}
{
  const svg = await trace(region(...letters, K))
  if (/[a-z]/.test(/\sd="([^"]+)"/.exec(svg)[1].replace(/[eE]/g, ''))) throw new Error('relative commands in letters path')
  out.letters = remap(svg, letters[0], letters[1], K)
}
{
  const svg = await trace(region(...subtitle, K))
  if (/[a-z]/.test(/\sd="([^"]+)"/.exec(svg)[1].replace(/[eE]/g, ''))) throw new Error('relative commands in subtitle path')
  out.subtitle = remap(svg, subtitle[0], subtitle[1], K)
}
fs.writeFileSync('paths.json', JSON.stringify(out))
console.log('letters', out.letters.length, 'chars; subtitle', out.subtitle.length, 'chars')
console.log(out.letters.slice(0, 160))
