/**
 * The PNG app icons, rasterised from the brand package by a real browser.
 *
 * A home screen wants PNG; iOS ignores SVG touch icons entirely. Chromium is
 * the rasteriser because it is what draws the same SVG in the app.
 *
 *   node scripts/build-icons.mjs        (PW_CHROMIUM=... to use a local one)
 *
 * The plain icons put the pyramid on the dark tile edge to edge of a rounded
 * square; the maskable ones keep it inside the central 60% safe zone, since a
 * launcher may crop the tile to a circle.
 */

import fs from 'node:fs'
import { chromium } from 'playwright'

const tokens = JSON.parse(fs.readFileSync('assets/brand/mab/design-tokens.json', 'utf8'))
const sign = fs.readFileSync('assets/brand/mab/logos/mab-sign.svg', 'utf8')
const vb = /viewBox="([^"]+)"/.exec(sign)[1]
const shapes = sign.slice(sign.indexOf('</title>') + 8, sign.lastIndexOf('</svg>'))

/** a square icon: the tile, and the pyramid filling `share` of it */
const icon = (size, share, rounded) => {
  const inner = size * share
  const off = (size - inner) / 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" ${rounded ? `rx="${size * 0.2}"` : ''} fill="${tokens.colors.tile}"/>` +
    `<svg x="${off}" y="${off}" width="${inner}" height="${inner}" viewBox="${vb}">${shapes}</svg></svg>`
  )
}

const jobs = [
  // iOS rounds the corners itself and fills transparency with black
  ['icon-180.png', 180, 0.74, false],
  ['icon-192.png', 192, 0.74, true],
  ['icon-512.png', 512, 0.74, true],
  ['icon-192-maskable.png', 192, 0.58, false],
  ['icon-512-maskable.png', 512, 0.58, false],
]

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
const page = await browser.newPage({ deviceScaleFactor: 1 })
for (const [file, size, share, rounded] of jobs) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<html><body style="margin:0;background:transparent">${icon(size, share, rounded)}</body></html>`)
  await page.screenshot({ path: `public/brand/${file}`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
  console.log(`public/brand/${file}`)
}
await browser.close()
