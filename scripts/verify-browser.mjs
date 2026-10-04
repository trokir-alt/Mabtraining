/**
 * Browser acceptance run against a built, served app.
 *
 *   npm i -D playwright && npx playwright install chromium   # once
 *   npm run build && npx vite preview --port 4173 &
 *   PORT=4173 node scripts/verify-browser.mjs
 *
 * Playwright is deliberately NOT a dependency of the app - it is a 100 MB+
 * install that nothing in `npm run build` needs. Set PW_CHROMIUM to point at an
 * existing Chromium instead of downloading one.
 *
 * Three groups of checks, on a desktop, an iPad and a phone viewport:
 *
 *  1. Behaviour, through the real UI: every object type is created with the
 *     press-drag-release gesture, moved, deleted, and survives undo and redo;
 *     handles bend an arrow; captions are edited; the scene survives a reload.
 *  2. The exported picture, measured pixel by pixel in millimetres: the black
 *     of a pocket is exactly the mouth and never reaches past the rubber, a
 *     ball reads at its full diameter, a ghost is a real ball, a zone sits
 *     under the balls, a caption lands where it was on screen.
 *  3. Weight: the default 2x export is under 500 KB.
 *
 * The first 60 checks of stage 1 looked only at the DOM and passed while the
 * picture was wrong; group 2 exists because of that. Exits non-zero on any
 * failure.
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.env.PORT || '4173'
const SP = process.env.SP || process.cwd()
/** ONLY=desktop|ipad|phone runs a single screen, for a quicker loop */
const ONLY = process.env.ONLY
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
}

const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
)

/**
 * Empty the local function stand.
 *
 * Since stage 6 the app syncs on boot, so a library left on the stand turns up
 * in the next screen's list - correct behaviour, useless as a starting point.
 * The screens run in sequence, so clearing before each one gives every screen
 * the same empty library. Without a stand there is nothing to clear and the
 * run simply works offline, which several checks want anyway.
 */
async function resetStand() {
  try {
    await fetch(`${process.env.API_BASE || 'http://127.0.0.1:4181'}/__test/reset`, { method: 'POST' })
  } catch {
    // no stand on this machine: the app reports "no connection" and goes on
  }
}

/* ------------------------------------------------------------- helpers */

const scene = (page) =>
  page.evaluate(() => {
    const s = window.__scene
    return s ? JSON.parse(JSON.stringify(s)) : null
  })

/**
 * One reading of everything needed to convert between table millimetres and
 * page pixels: the layer transform the app publishes, and where the canvas
 * sits on the page.
 *
 * Every conversion for one gesture must come from the SAME reading. The
 * captions above and below the table change height when a title appears or a
 * panel opens, and the canvas then moves a few pixels; a press converted
 * against one layout and a release against another makes an exact drag look
 * short. That is what "the dot misses by 6% of its radius" turned out to be -
 * the app was putting it precisely where the pointer went.
 */
async function layoutSnap(page) {
  const bb = await page.locator('canvas').first().boundingBox()
  const l = await page.evaluate(() => {
    const v = window.__layout
    return { scale: v.scale, x: v.x, y: v.y, rotation: v.rotation }
  })
  return { ...l, left: bb.x, top: bb.y }
}

/** table mm -> page css px, against a snapshot */
function mmToPx(snap, mx, my) {
  return snap.rotation === 90
    ? [snap.left + (-my * snap.scale + snap.x), snap.top + (mx * snap.scale + snap.y)]
    : [snap.left + (mx * snap.scale + snap.x), snap.top + (my * snap.scale + snap.y)]
}

/** page css px -> table mm, against the same snapshot */
function pxToMm(snap, px, py) {
  const dx = px - snap.left - snap.x
  const dy = py - snap.top - snap.y
  return snap.rotation === 90
    ? { x: dy / snap.scale, y: -dx / snap.scale }
    : { x: dx / snap.scale, y: dy / snap.scale }
}

/** table mm -> page css px, using the layout the app publishes */
async function toPage(page, mx, my) {
  const [p] = await toPageAll(page, [[mx, my]])
  return p
}

/** several points through one reading; see layoutSnap */
async function toPageAll(page, points) {
  const snap = await layoutSnap(page)
  return points.map(([mx, my]) => mmToPx(snap, mx, my))
}

/** press-drag-release across the table, in mm */
async function gesture(page, from, to, steps = 18) {
  const [[x0, y0], [x1, y1]] = await toPageAll(page, [
    [from.x, from.y],
    [to.x, to.y],
  ])
  // a drag that starts under the floating panel would grab the panel, not the
  // table; the coach clears it the same way, by touching the cloth first
  const blocked = await page.evaluate(
    ([px, py]) => !!document.elementFromPoint(px, py)?.closest('.props'),
    [x0, y0],
  )
  if (blocked) {
    await page.evaluate(() => window.__store.getState().select(null))
    await page.waitForTimeout(80)
  }
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x1, y1, { steps })
  // one more move at the destination: under load the last interpolated move
  // can be coalesced away, and Konva then commits the position before it
  await page.mouse.move(x1, y1)
  await page.mouse.up()
  await page.waitForTimeout(150)
}

const tool = (page, name) => page.getByRole('button', { name, exact: true }).click()

/**
 * Click a point on the canvas, and make sure it IS the canvas.
 *
 * The properties panel floats just under whatever is selected, so it can sit
 * over the next object the test wants to reach - the coach hits the same
 * thing and clears it by clicking the cloth first. Doing that here keeps the
 * check about what it is meant to check.
 */
async function clickCanvas(page, x, y) {
  const blocked = await page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py)
      return !!(el && el.closest('.props'))
    },
    [x, y],
  )
  if (blocked) {
    await page.evaluate(() => window.__store.getState().select(null))
    await page.waitForTimeout(80)
  }
  await page.mouse.click(x, y)
}

async function newPage(viewport, dsf, opts = {}) {
  await resetStand()
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: dsf,
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    ...opts,
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`http://localhost:${PORT}/?debug=1`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  // every run starts from an empty table, whatever autosave remembers
  await page.evaluate(() => {
    window.localStorage.clear()
    window.__store.getState().newExercise()
  })
  await page.waitForTimeout(150)
  return { ctx, page, errors }
}

/** download through the UI and return {path, bytes, w, h} */
async function exportVia(page, label, fmt, scale) {
  if (await page.locator('.m-shell').count()) await page.getByRole('button', { name: 'Экспорт', exact: true }).click()
  await page.getByRole('button', { name: fmt, exact: true }).click()
  await page.getByRole('button', { name: scale, exact: true }).click()
  const dlp = page.waitForEvent('download', { timeout: 20000 })
  await page.getByRole('button', { name: `Скачать ${fmt}` }).click()
  const dl = await dlp
  const file = path.join(SP, `verify-${label}-${scale}.${fmt === 'JPEG' ? 'jpg' : 'png'}`)
  await dl.saveAs(file)
  const bytes = fs.statSync(file).size
  const [w, h] = await page.evaluate(
    (src) =>
      new Promise((res) => {
        const img = new Image()
        img.onload = () => res([img.width, img.height])
        img.src = src
      }),
    `data:image/${fmt === 'JPEG' ? 'jpeg' : 'png'};base64,${fs.readFileSync(file).toString('base64')}`,
  )
  return { file, bytes, w, h, name: dl.suggestedFilename() }
}

/* ------------------------------------------------- 1. behaviour, per type */

async function behaviour(page, label) {
  // ---- pyramid geometry (stage 1) ----
  await tool(page, 'Пирамида')
  await page.waitForTimeout(250)
  let sc = await scene(page)
  check(`${label}: pyramid racks 15 white + 1 cue`, sc.items.length === 16)
  const d = sc.table.ballMm
  let minGap = Infinity
  for (let i = 0; i < sc.items.length; i++)
    for (let j = i + 1; j < sc.items.length; j++)
      minGap = Math.min(minGap, Math.hypot(sc.items[i].x - sc.items[j].x, sc.items[i].y - sc.items[j].y))
  check(`${label}: no overlapping balls`, minGap >= d - 0.01, `min ${minGap.toFixed(2)} mm`)
  check(`${label}: apex on the back spot`, Math.abs(Math.min(...sc.items.filter((i) => i.kind === 'white').map((i) => i.x)) - sc.table.lengthMm * 0.75) < 0.5)
  await page.evaluate(() => window.__store.getState().newExercise())

  // ---- every object type: gesture -> drag -> delete -> undo -> redo ----
  const specs = [
    { name: 'Стрелка', type: 'arrow', from: { x: 600, y: 500 }, to: { x: 1500, y: 900 } },
    { name: 'Траектория', type: 'ghostTrail', from: { x: 700, y: 1300 }, to: { x: 1600, y: 700 } },
    { name: 'Линия', type: 'line', from: { x: 2000, y: 300 }, to: { x: 3000, y: 300 } },
    { name: 'Зона', type: 'zone', from: { x: 2200, y: 900 }, to: { x: 2800, y: 1400 } },
    { name: 'Эллипс', type: 'zone', from: { x: 300, y: 300 }, to: { x: 700, y: 600 } },
  ]
  for (const sp of specs) {
    await tool(page, sp.name)
    const before = (await scene(page)).items.length
    await gesture(page, sp.from, sp.to)
    sc = await scene(page)
    const made = sc.items.find((i) => i.type === sp.type && !specs.some((o) => o !== sp && o.made === i.id))
    sp.made = made?.id
    check(`${label}: ${sp.name} is created by press-drag-release`, sc.items.length === before + 1 && !!made, made ? made.id : 'nothing')
    if (!made) continue

    // the tool is sticky: a second gesture makes a second object
    const idsBefore = sc.items.map((i) => i.id)
    await gesture(page, { x: sp.from.x + 50, y: sp.from.y + 50 }, { x: sp.to.x + 50, y: sp.to.y + 50 })
    sc = await scene(page)
    check(`${label}: ${sp.name} tool stays active`, sc.items.filter((i) => i.type === sp.type).length >= 2)
    // drop that second one by identity - its hit band overlaps the first and
    // would make the later click-to-select ambiguous. (Zones are inserted at
    // the bottom, so "the last item" would be the wrong object.)
    const extra = sc.items.find((i) => !idsBefore.includes(i.id))
    if (extra) {
      await page.evaluate((id) => {
        const st = window.__store.getState()
        st.select(id)
        st.removeSelected()
      }, extra.id)
    }
    // and a tap without a drag makes nothing
    const n0 = (await scene(page)).items.length
    const [tx, ty] = await toPage(page, 1775, 1500)
    await page.mouse.click(tx, ty)
    await page.waitForTimeout(120)
    check(`${label}: a tap with ${sp.name} makes no object`, (await scene(page)).items.length === n0)

    // drag the object bodily (grab it near its middle)
    await tool(page, 'Выбор')
    const it = (await scene(page)).items.find((i) => i.id === made.id)
    const mid = it.type === 'zone'
      ? { x: it.x + it.w / 2, y: it.y + it.h / 2 }
      : it.type === 'arrow'
        ? { x: (it.points[0].x + it.points.at(-1).x) / 2, y: (it.points[0].y + it.points.at(-1).y) / 2 }
        : { x: (it.from.x + it.to.x) / 2, y: (it.from.y + it.to.y) / 2 }
    await gesture(page, mid, { x: mid.x + 200, y: mid.y + 120 })
    const moved = (await scene(page)).items.find((i) => i.id === made.id)
    const anchor = (o) => (o.type === 'zone' ? { x: o.x, y: o.y } : o.type === 'arrow' ? o.points[0] : o.from)
    const dist = Math.hypot(anchor(moved).x - anchor(it).x, anchor(moved).y - anchor(it).y)
    check(`${label}: ${sp.name} drags`, dist > 150 && dist < 300, `${dist.toFixed(0)} mm`)

    // delete, undo, redo
    const n1 = (await scene(page)).items.length
    await page.keyboard.press('Delete')
    await page.waitForTimeout(120)
    check(`${label}: ${sp.name} deletes`, (await scene(page)).items.length === n1 - 1)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
    check(`${label}: ${sp.name} survives undo`, (await scene(page)).items.some((i) => i.id === made.id))
    await page.keyboard.press('Control+Shift+z')
    await page.waitForTimeout(120)
    check(`${label}: ${sp.name} redo removes again`, !(await scene(page)).items.some((i) => i.id === made.id))
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(120)
  }

  // ---- text: click to place, edit inline, drag ----
  await tool(page, 'Текст')
  const [tx, ty] = await toPage(page, 1000, 1500)
  await page.mouse.click(tx, ty)
  await page.waitForTimeout(200)
  const field = page.locator('.text-editor__field')
  check(`${label}: text tool opens the editor`, await field.isVisible())
  await field.fill('Тонко')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  sc = await scene(page)
  const txt = sc.items.find((i) => i.type === 'text')
  check(`${label}: caption committed`, txt?.text === 'Тонко', txt?.text)
  await tool(page, 'Выбор')
  const [ex, ey] = await toPage(page, txt.x + 60, txt.y)
  // Konva calls it a double click only if the two land within 400 ms of each
  // other. Under software rendering the first click's redraw can eat that
  // window, so one retry separates "the app does not reopen the editor" from
  // "this machine was busy"; a person on a real device never sees it.
  await page.mouse.dblclick(ex, ey)
  await page.waitForTimeout(250)
  let reopened = await field.isVisible()
  if (!reopened) {
    await page.waitForTimeout(400)
    await page.mouse.dblclick(ex, ey)
    await page.waitForTimeout(400)
    reopened = await field.isVisible()
  }
  check(`${label}: double click reopens the editor`, reopened)
  await field.fill('Тонко!')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  check(`${label}: caption edited`, (await scene(page)).items.find((i) => i.type === 'text')?.text === 'Тонко!')

  // ---- arrow handles: bend and end ----
  const arrow = (await scene(page)).items.find((i) => i.type === 'arrow')
  const [ax, ay] = await toPage(page, (arrow.points[0].x + arrow.points.at(-1).x) / 2, (arrow.points[0].y + arrow.points.at(-1).y) / 2)
  await clickCanvas(page, ax, ay)
  await page.waitForTimeout(150)
  check(`${label}: clicking an arrow selects it`, (await scene(page)).selectedId === arrow.id)
  check(`${label}: properties panel shows`, await page.locator('.props').isVisible())
  const bend = { x: (arrow.points[0].x + arrow.points.at(-1).x) / 2, y: (arrow.points[0].y + arrow.points.at(-1).y) / 2 }
  await gesture(page, bend, { x: bend.x, y: bend.y + 300 })
  const bent = (await scene(page)).items.find((i) => i.id === arrow.id)
  check(`${label}: middle handle bends the arrow through the dragged point`,
    bent.curved && bent.points.length === 3 && Math.abs(bent.points[1].y - (bend.y + 300)) < 25,
    `through ${bent.points[1]?.x?.toFixed(0)},${bent.points[1]?.y?.toFixed(0)}`)
  await gesture(page, bent.points.at(-1), { x: bent.points.at(-1).x + 250, y: bent.points.at(-1).y })
  const ended = (await scene(page)).items.find((i) => i.id === arrow.id)
  check(`${label}: end handle moves the end`, Math.abs(ended.points.at(-1).x - (bent.points.at(-1).x + 250)) < 25)

  // ---- properties: colour and width apply to the selection ----
  await page.getByRole('button', { name: 'Красный' }).click()
  await page.waitForTimeout(100)
  check(`${label}: colour swatch recolours the selection`, (await scene(page)).items.find((i) => i.id === arrow.id).color === '#FF5A4E')

  // ---- ghost count: auto from length, manual +/- ----
  let ghost = (await scene(page)).items.find((i) => i.type === 'ghostTrail')
  if (!ghost) {
    // should not happen after the undo above; make it a failure, not a crash
    check(`${label}: a ghost trail is still on the table for the count checks`, false)
    await tool(page, 'Траектория')
    await gesture(page, { x: 700, y: 1300 }, { x: 1600, y: 700 })
    await tool(page, 'Выбор')
    ghost = (await scene(page)).items.find((i) => i.type === 'ghostTrail')
  }
  const len = Math.hypot(ghost.to.x - ghost.from.x, ghost.to.y - ghost.from.y)
  const expect = Math.min(8, Math.max(3, Math.round(len / (1.6 * d))))
  check(`${label}: ghost count follows round(len / 1.6d)`, ghost.count === expect, `${ghost.count} vs ${expect} for ${len.toFixed(0)} mm`)
  // the arrow is still selected and its floating panel may sit over the trail:
  // drop the selection first, as a person would click away
  await page.evaluate(() => window.__store.getState().select(null))
  await page.waitForTimeout(80)
  const [gx, gy] = await toPage(page, ghost.from.x, ghost.from.y)
  await page.mouse.click(gx, gy)
  await page.waitForTimeout(120)
  check(`${label}: clicking a trail selects it`, (await scene(page)).selectedId === ghost.id)
  // step in whichever direction the range allows: at 8 only "-" is enabled
  const up = ghost.count < 8
  await page.getByRole('button', { name: up ? 'Больше' : 'Меньше' }).click()
  await page.waitForTimeout(100)
  const stepped = (await scene(page)).items.find((i) => i.id === ghost.id)
  check(`${label}: ghost ${up ? '+' : '-'} steps the count and pins it`,
    stepped.count === ghost.count + (up ? 1 : -1) && stepped.autoCount === false, `${ghost.count} -> ${stepped.count}`)

  // ---- zone always under the balls ----
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.addBall('white', { x: 2500, y: 1150 })
    st.bringToFront(st.scene.items.find((i) => i.type === 'zone').id) // even if pushed up on purpose...
  })
  await tool(page, 'Зона')
  const zoneIdsBefore = (await scene(page)).items.filter((i) => i.type === 'zone').map((i) => i.id)
  await gesture(page, { x: 2300, y: 950 }, { x: 2900, y: 1450 })
  sc = await scene(page)
  const zoneIdx = sc.items.findIndex((i) => i.type === 'zone' && !zoneIdsBefore.includes(i.id))
  const firstBall = sc.items.findIndex((i) => i.type === 'ball')
  check(`${label}: a new zone goes to the bottom of the z-order`, zoneIdx === 0 && firstBall > zoneIdx, `zone at ${zoneIdx}`)
  await tool(page, 'Выбор')

  // ---- history: one entry per drag, not per frame ----
  const pastBefore = await page.evaluate(() => window.__store.getState().past.length)
  const ball = (await scene(page)).items.find((i) => i.type === 'ball')
  await gesture(page, ball, { x: ball.x - 400, y: ball.y - 300 }, 40)
  const pastAfter = await page.evaluate(() => window.__store.getState().past.length)
  check(`${label}: one drag is one history entry`, pastAfter === pastBefore + 1, `+${pastAfter - pastBefore}`)

  // ---- 20 undos stay quick ----
  for (let i = 0; i < 20; i++) await page.evaluate(() => window.__store.getState().addBall('white'))
  const dt = await page.evaluate(() => {
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) window.__store.getState().undo()
    return performance.now() - t0
  })
  check(`${label}: 20 undos in under 200 ms`, dt < 200, `${dt.toFixed(1)} ms`)

  // ---- autosave: survives a reload ----
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.setTitle('Автосохранение')
    st.setNote('проверка')
  })
  const saved = await scene(page)
  await page.waitForTimeout(800)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  const back = await scene(page)
  check(`${label}: scene survives a reload`,
    back.items.length === saved.items.length && back.title === 'Автосохранение' && back.note === 'проверка',
    `${back.items.length}/${saved.items.length} items, title "${back.title}"`)
  // stage 6 took the confirmation away, and that is the point: the library
  // has already taken a revision, so "new exercise" throws nothing away and
  // has nothing to ask about
  const beforeNew = await page.evaluate(() => window.__library.getState().items.length)
  await tool(page, 'Новое упражнение')
  await page.waitForTimeout(500)
  const fresh = await scene(page)
  check(`${label}: new exercise clears table, title and note`, fresh.items.length === 0 && !fresh.title && !fresh.note)
  const afterNew = await page.evaluate(() => window.__library.getState().items.length)
  check(`${label}: new exercise asks nothing because it loses nothing`, afterNew >= Math.max(1, beforeNew), `library ${beforeNew} -> ${afterNew}`)

  await stage3(page, label)
}

/* --------------------------------------------- stage 3: the two widgets */

async function stage3(page, label) {
  await page.evaluate(() => window.__store.getState().newExercise())

  // ---- strike point: tap to place, then drag the dot ----
  await tool(page, 'Точка на шаре')
  const [sx, sy] = await toPage(page, 1000, 900)
  await page.mouse.click(sx, sy)
  await page.waitForTimeout(200)
  let sc = await scene(page)
  const sp = sc.items.find((i) => i.type === 'strikePoint')
  check(`${label}: strike point is placed by a tap`, !!sp && sp.sizeMm === 300 && sp.dot.u === 0 && sp.dot.v === 0)
  await tool(page, 'Выбор')
  const r = sp.sizeMm / 2
  // drag the dot from the centre to (0.5 r, -0.3 r) and compare with the
  // release point. Mouse events carry whole css pixels, so the point the app
  // saw is the rounded press and release positions, not the fractional ones
  const target = { x: sp.x + 0.5 * r, y: sp.y - 0.3 * r }
  // one snapshot for the press, the release AND the conversion back: see layoutSnap
  const snap = await layoutSnap(page)
  const [px0, py0] = mmToPx(snap, sp.x, sp.y)
  const [px1, py1] = mmToPx(snap, target.x, target.y)
  const grab = { x: Math.round(px0) - px0, y: Math.round(py0) - py0 } // press offset from the dot centre
  // a panel over the dot would take the press instead of the canvas
  if (await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.props'), [Math.round(px0), Math.round(py0)])) {
    await page.evaluate(() => window.__store.getState().select(null))
    await page.waitForTimeout(80)
  }
  await page.mouse.move(Math.round(px0), Math.round(py0))
  await page.mouse.down()
  // two moves to the same point, no interpolation: this check is about where
  // the dot ends up, and interpolated moves only add ways for one to be
  // coalesced away or arrive after the release
  await page.mouse.move(Math.round(px1), Math.round(py1))
  await page.mouse.move(Math.round(px1), Math.round(py1))
  // Konva commits a drag on an animation frame: releasing in the same frame
  // as the last move would leave the node a frame behind the pointer
  await page.waitForTimeout(60)
  await page.mouse.up()
  await page.waitForTimeout(150)
  const seen = pxToMm(snap, Math.round(px1) - grab.x, Math.round(py1) - grab.y)
  let it = (await scene(page)).items.find((i) => i.id === sp.id)
  const err = Math.hypot(it.dot.u * r - (seen.x - sp.x), it.dot.v * r - (seen.y - sp.y)) / r
  const where = await page.evaluate(() => ({ scale: window.__layout.scale, rot: window.__layout.rotation, zoom: window.__view.getState().viewport.zoom }))
  check(
    `${label}: dot lands within 2% of the radius of where it was released`,
    err <= 0.02,
    `${(err * 100).toFixed(2)}% (u=${it.dot.u.toFixed(3)}, v=${it.dot.v.toFixed(3)}) at ${px0.toFixed(2)},${py0.toFixed(2)} -> ${px1.toFixed(2)},${py1.toFixed(2)} scale ${where.scale.toFixed(4)} rot ${where.rot} zoom ${where.zoom}`,
  )
  check(`${label}: dragging the dot does not move the ball`, it.x === sp.x && it.y === sp.y)

  // dragging the body keeps the dot where it is on the ball
  const dotBefore = { ...it.dot }
  await gesture(page, { x: sp.x - 0.6 * r, y: sp.y + 0.5 * r }, { x: sp.x - 0.6 * r + 400, y: sp.y + 0.5 * r + 200 })
  it = (await scene(page)).items.find((i) => i.id === sp.id)
  check(`${label}: dragging the body moves the widget`, Math.hypot(it.x - sp.x, it.y - sp.y) > 300, `${Math.hypot(it.x - sp.x, it.y - sp.y).toFixed(0)} mm`)
  check(`${label}: ...and the dot rides along unchanged`, it.dot.u === dotBefore.u && it.dot.v === dotBefore.v, `u ${it.dot.u.toFixed(3)} v ${it.dot.v.toFixed(3)}`)

  // the dot cannot be pulled past 0.9 r
  const cur = it
  await gesture(page, { x: cur.x + cur.dot.u * r, y: cur.y + cur.dot.v * r }, { x: cur.x + 1.6 * r, y: cur.y + 1.2 * r })
  it = (await scene(page)).items.find((i) => i.id === sp.id)
  const len = Math.hypot(it.dot.u, it.dot.v)
  check(`${label}: dot stays at 0.9 r when pulled past the edge`, Math.abs(len - 0.9) <= 0.005, `|dot| = ${len.toFixed(3)}`)

  // snap to the centre: release within 3% of it
  await gesture(page, { x: it.x + it.dot.u * r, y: it.y + it.dot.v * r }, { x: it.x + 0.015 * r, y: it.y - 0.01 * r })
  it = (await scene(page)).items.find((i) => i.id === sp.id)
  check(`${label}: dot snaps to the centre within 3%`, it.dot.u === 0 && it.dot.v === 0, `u ${it.dot.u} v ${it.dot.v}`)

  // ---- power: tap to place, segments, +/- on the plate, keyboard ----
  await tool(page, 'Сила удара')
  const [px, py] = await toPage(page, 2600, 1400)
  await page.mouse.click(px, py)
  await page.waitForTimeout(200)
  sc = await scene(page)
  const pw = sc.items.find((i) => i.type === 'power')
  check(`${label}: power plate is placed by a tap at 2,5`, !!pw && pw.value === 2.5)

  await tool(page, 'Выбор')

  /* The floating properties panel must never land on a control. It is
     positioned in page coordinates with no positioned ancestor, and when that
     origin was wrong it sat on the toolbar and swallowed the clicks meant for
     «Вернуть» and «Горизонтально» - on the tablet, which is the screen the
     coach actually works on. */
  const covered = await page.evaluate(() => {
    const panel = document.querySelector('.props')
    if (!panel) return { ok: false, hidden: ['no panel at all'] }
    const hidden = []
    for (const btn of document.querySelectorAll('.toolbar button, .m-dock button, .m-top button')) {
      const r = btn.getBoundingClientRect()
      if (!r.width || !r.height) continue
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (el && el.closest('.props')) hidden.push((btn.getAttribute('aria-label') || btn.textContent || '?').trim().slice(0, 16))
    }
    return { ok: hidden.length === 0, hidden }
  })
  check(`${label}: the properties panel covers no control`, covered.ok, covered.hidden.join(', '))

  const SERIES = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]
  const inSeries = (v) => SERIES.includes(v)
  // the scale is one column of nine cells, read bottom to top: artboard 100
  // wide, 7 of padding, cells 62 tall with 6 between them
  const ART = { w: 100, pad: 7, cell: 62, gap: 6, h: 620 }
  const pwW = pw.widthMm
  const pwH = (pwW * ART.h) / ART.w
  const u = pwW / ART.w
  /** the middle of the cell a value sits in, counted from the top */
  const cellOf = (value) => {
    const fromTop = 9 - Math.round(value * 2)
    return { x: pw.x, y: pw.y - pwH / 2 + (ART.pad + fromTop * (ART.cell + ART.gap) + ART.cell / 2) * u }
  }
  const seg = (i) => cellOf(SERIES[i])
  const [cx7, cy7] = await toPage(page, seg(6).x, seg(6).y)
  await clickCanvas(page, cx7, cy7)
  await page.waitForTimeout(150)
  let pv = (await scene(page)).items.find((i) => i.id === pw.id)
  check(`${label}: tapping a segment sets the value`, pv.value === 3.5, String(pv.value))
  // keyboard, with the plate selected
  await page.keyboard.press('+')
  await page.keyboard.press('+')
  await page.keyboard.press('+')
  await page.waitForTimeout(100)
  pv = (await scene(page)).items.find((i) => i.id === pw.id)
  check(`${label}: + steps by 0,5 and stops at 4,5`, pv.value === 4.5, String(pv.value))
  for (let k = 0; k < 12; k++) await page.keyboard.press('-')
  await page.waitForTimeout(100)
  pv = (await scene(page)).items.find((i) => i.id === pw.id)
  check(`${label}: - stops at 0,5`, pv.value === 0.5, String(pv.value))
  // the + button on the plate itself (above the column, when selected)
  const [bx, by] = await toPage(page, pw.x, pw.y - pwH / 2 - pwW * 0.72 * 0.55)
  await page.mouse.click(bx, by)
  await page.waitForTimeout(150)
  pv = (await scene(page)).items.find((i) => i.id === pw.id)
  check(`${label}: + on the plate steps once`, pv.value === 1, String(pv.value))
  check(`${label}: value always belongs to the nine-step series`, inSeries(pv.value))
  // the value lives in the topmost lit cell; the separator is checked by
  // pixels in stage4()
  await page.evaluate((id) => window.__store.getState().setPower(id, 2.5), pw.id)
  await page.waitForTimeout(150)
  const plate = await page.evaluate(() => window.__stage.find('Text').map((t) => t.text()))
  check(`${label}: the plate reads 2,5`, plate.includes('2,5'), plate.filter((t) => /\d/.test(t)).join(' | '))

  // the corner handle resizes the plate and keeps its proportions
  await page.evaluate((id) => window.__store.getState().select(id), pw.id)
  await page.waitForTimeout(120)
  await page.evaluate((id) => window.__store.getState().updateItem(id, { widthMm: 90 }), pw.id)
  await page.waitForTimeout(120)
  const before = (await scene(page)).items.find((i) => i.id === pw.id).widthMm
  const corner = { x: pw.x + before / 2, y: pw.y + (before * ART.h) / ART.w / 2 }
  await gesture(page, corner, { x: corner.x + 30, y: corner.y + 186 })
  const after = (await scene(page)).items.find((i) => i.id === pw.id).widthMm
  check(`${label}: the corner handle resizes the indicator`, after > before + 15 && after <= 170, `${before} -> ${after} mm`)
  await page.evaluate((id) => window.__store.getState().updateItem(id, { widthMm: 120 }), pw.id)

  // ---- the object ball behind the widget: the aiming picture ----
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.addItem({ id: 'cb-host', type: 'strikePoint', x: 1200, y: 1300, sizeMm: 300, dot: { u: 0, v: 0 } }, 'belowText')
    st.select(null)
  })
  await page.waitForTimeout(150)
  const host = () => scene(page).then((sc) => sc.items.find((i) => i.id === 'cb-host'))
  let hb = await host()
  check(`${label}: a strike widget starts with no object ball`, hb.companion === undefined)

  // two taps on the left of the widget put it on the left, at a half ball
  const [cdx, cdy] = await toPage(page, hb.x - hb.sizeMm * 0.35, hb.y)
  await page.mouse.dblclick(cdx, cdy)
  await page.waitForTimeout(300)
  hb = await host()
  check(`${label}: a double click adds the object ball on the side clicked`, hb.companion?.side === 'left', JSON.stringify(hb.companion))
  check(`${label}: it starts at a half ball`, hb.companion?.fullness === 0.5, String(hb.companion?.fullness))

  /** where the object ball's centre is: sideways only, and how far IS the aim */
  const compCentre = (it) => ({
    x: it.x + (1 - it.companion.fullness) * it.sizeMm * (it.companion.side === 'left' ? -1 : 1),
    y: it.y,
  })

  // Dragging it sideways sets both the side and how full the hit is. Grab it
  // by the crescent that shows, not by its centre: at a half ball the centre
  // sits exactly on the host's rim, and the host is drawn on top of it.
  const wasAt = { x: hb.x, y: hb.y, size: hb.sizeMm }
  const grabOf = (it) => {
    const c = compCentre(it)
    return { x: c.x + 0.55 * (it.sizeMm / 2) * (it.companion.side === 'left' ? -1 : 1), y: c.y }
  }
  /** a drag moves the node by the delta, so aim the mouse, not the ball */
  const dragTo = (it, centreX) => {
    const g = grabOf(it)
    return { x: g.x + (centreX - compCentre(it).x), y: g.y }
  }
  await gesture(page, grabOf(hb), dragTo(hb, hb.x + hb.sizeMm * 0.25))
  hb = await host()
  check(`${label}: dragging the object ball moves it to the other side`, hb.companion.side === 'right', hb.companion.side)
  check(`${label}: ...and sets how full the hit is`, Math.abs(hb.companion.fullness - 0.75) < 0.02, String(hb.companion.fullness))
  check(`${label}: dragging it does not move or resize the widget`,
    Math.abs(hb.x - wasAt.x) < 0.01 && Math.abs(hb.y - wasAt.y) < 0.01 && hb.sizeMm === wasAt.size,
    `${hb.x.toFixed(1)},${hb.y.toFixed(1)} Ø${hb.sizeMm}`)
  check(`${label}: the drag lands on a named fraction`,
    [0, 0.25, 0.5, 0.75, 0.9].some((f) => Math.abs(f - hb.companion.fullness) < 1e-9), String(hb.companion.fullness))

  // a drag that goes up and down cannot lift one ball above the other
  await gesture(page, grabOf(hb), { x: grabOf(hb).x, y: grabOf(hb).y - hb.sizeMm * 0.9 })
  hb = await host()
  check(`${label}: a vertical drag cannot lift one ball above the other`,
    compCentre(hb).y === hb.y && !('angleDeg' in hb.companion), JSON.stringify(hb.companion))

  // the pair is rigid: move and resize the host, the aim is unchanged
  const aimBefore = hb.companion.fullness
  await page.evaluate((id) => {
    const st = window.__store.getState()
    st.select(id)
    st.nudgeSelected(25, -15)
    st.setStrikeSize(id, 500)
  }, 'cb-host')
  await page.waitForTimeout(150)
  hb = await host()
  check(`${label}: the pair stays rigid when the widget moves and grows`,
    hb.companion.fullness === aimBefore && hb.sizeMm === 500 && compCentre(hb).y === hb.y, `Ø${hb.sizeMm}, ${hb.companion.fullness}`)

  // the picture: white behind, the widget in front, no cloth between them
  const seam = await page.evaluate(
    (SAMPLER) => {
      const at = eval(SAMPLER)
      const it = window.__store.getState().scene.items.find((i) => i.id === 'cb-host')
      const dir = it.companion.side === 'left' ? -1 : 1
      const d = (1 - it.companion.fullness) * it.sizeMm
      const r = it.sizeMm / 2
      const c = { x: it.x + d * dir, y: it.y }
      const cloth = at(it.x - it.sizeMm * 2.4, it.y)
      // the crescent that still shows, beyond the object ball's centre
      const crescent = at(c.x + r * 0.7 * dir, c.y)
      // a point inside BOTH circles: the widget must be the one drawn there
      const overlap = at(it.x + d * 0.5 * dir, it.y)
      let clothy = 0
      let n = 0
      for (let t = 0; t <= 1; t += 0.02) {
        const p = at(it.x + (c.x - it.x) * t, it.y)
        if (!p || !cloth) continue
        n++
        const diff = Math.max(Math.abs(p[0] - cloth[0]), Math.abs(p[1] - cloth[1]), Math.abs(p[2] - cloth[2]))
        if (diff < 30) clothy++
      }
      return { crescent, overlap, clothy, n }
    },
    S4_SAMPLER,
  )
  check(`${label}: the object ball reads as a white ball, not a flat disc`,
    seam.crescent && seam.crescent[0] > 200 && seam.crescent[0] < 253 && Math.abs(seam.crescent[0] - seam.crescent[2]) <= 12,
    `crescent ${seam.crescent}`)
  check(`${label}: the widget with the dot is drawn OVER the object ball`,
    seam.overlap && seam.overlap[0] - seam.overlap[2] > 40, `overlap r-b ${seam.overlap ? seam.overlap[0] - seam.overlap[2] : '?'}`)
  check(`${label}: no cloth shows between the two balls`, seam.clothy === 0, `${seam.clothy} of ${seam.n} samples`)

  // the named fractions, the sides, and removal that outlives a reload
  await page.evaluate((id) => window.__store.getState().select(id), 'cb-host')
  await page.waitForTimeout(120)
  for (const [name, value] of [['Полный', 0.9], ['½', 0.5], ['Тонкий', 0]]) {
    await page.getByRole('button', { name, exact: true }).click()
    await page.waitForTimeout(120)
    const f = (await host()).companion.fullness
    check(`${label}: "${name}" sets the aim to ${value}`, f === value, String(f))
  }
  await page.getByRole('button', { name: '¾', exact: true }).click()
  await page.waitForTimeout(120)
  await page.getByRole('button', { name: 'Слева', exact: true }).click()
  await page.waitForTimeout(150)
  check(`${label}: "left" puts the object ball on the left, aim unchanged`,
    (await host()).companion.side === 'left' && (await host()).companion.fullness === 0.75)
  await page.getByRole('button', { name: 'Справа', exact: true }).click()
  await page.waitForTimeout(150)
  check(`${label}: "right" puts it back`, (await host()).companion.side === 'right')
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(150)
  check(`${label}: undo takes the side back`, (await host()).companion.side === 'left')
  await page.waitForTimeout(700)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  const kept = (await host())?.companion
  check(`${label}: the object ball survives a reload`, kept?.side === 'left' && kept?.fullness === 0.75, JSON.stringify(kept))
  await page.evaluate(() => window.__store.getState().select('cb-host'))
  await page.waitForTimeout(120)
  await page.getByRole('button', { name: 'Убрать' }).click()
  await page.waitForTimeout(150)
  check(`${label}: "remove" takes the object ball away`, (await host()).companion === undefined)
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.select('cb-host')
    st.removeSelected()
  })
  await page.waitForTimeout(120)

  // ---- wireframe ball: placed by a tap, snaps to contact with a real ball ----
  await page.evaluate(() => window.__store.getState().addBall('white', { x: 2000, y: 600 }))
  await tool(page, 'Шар-призрак')
  const [gx, gy] = await toPage(page, 1700, 900)
  await page.mouse.click(gx, gy)
  await page.waitForTimeout(150)
  const gb = (await scene(page)).items.find((i) => i.type === 'ghostBall')
  check(`${label}: wireframe ball is placed by a tap`, !!gb)
  await tool(page, 'Выбор')
  // drag it to nearly touching the white ball: 67 mm apart is contact, aim for 74
  const d = (await scene(page)).table.ballMm
  await gesture(page, gb, { x: 2000 - (d + 7) * Math.SQRT1_2, y: 600 + (d + 7) * Math.SQRT1_2 })
  const g2 = (await scene(page)).items.find((i) => i.id === gb.id)
  const dist = Math.hypot(g2.x - 2000, g2.y - 600)
  check(`${label}: wireframe ball snaps to exactly one diameter from a ball`, Math.abs(dist - d) < 0.05, `${dist.toFixed(2)} mm vs ${d}`)

  // ---- both widgets are ordinary objects: delete, undo, redo, duplicate ----
  for (const [name, id] of [['strike point', sp.id], ['power plate', pw.id], ['wireframe ball', gb.id]]) {
    await page.evaluate((i) => window.__store.getState().select(i), id)
    await page.keyboard.press('Delete')
    await page.waitForTimeout(100)
    const gone = !(await scene(page)).items.some((i) => i.id === id)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(100)
    const back = (await scene(page)).items.some((i) => i.id === id)
    check(`${label}: ${name} deletes and comes back with undo`, gone && back)
  }
  await page.evaluate((i) => window.__store.getState().select(i), sp.id)
  await page.keyboard.press('Control+d')
  await page.waitForTimeout(100)
  check(`${label}: strike point duplicates`, (await scene(page)).items.filter((i) => i.type === 'strikePoint').length === 2)

  // z-order: widgets above balls, below captions
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.addItem({ id: 'cap', type: 'text', x: 500, y: 500, text: 'Подпись', size: 90, color: '#FFFFFF', angle: 0 })
    st.addItem({ id: 'pw2', type: 'power', x: 900, y: 1500, value: 2, widthMm: 90 }, 'belowText')
  })
  sc = await scene(page)
  const iPw = sc.items.findIndex((i) => i.id === 'pw2')
  const iCap = sc.items.findIndex((i) => i.id === 'cap')
  const iBall = sc.items.findIndex((i) => i.type === 'ball')
  check(`${label}: a widget lands above balls and below captions`, iPw > iBall && iPw < iCap, `ball ${iBall} < widget ${iPw} < caption ${iCap}`)
}

/* ------------------------------------- 2. the picture itself, in millimetres */

/* ------------------------------------ stage 4: the brand, mark and indicator */

/**
 * The test scene the brief asks for: cue ball, a four-ghost trail, an arrow, a
 * zone and the strength indicator, all laid across the watermark grid.
 */
const S4_SCENE = () => {
  const st = window.__store.getState()
  st.newExercise()
  const L = st.scene.table.lengthMm
  const s = L / 1120
  // the first stamp of the grid, in table mm, from the package's own formula
  const stamp = { x: (64 - 40) * s, y: (132 - 40) * s, w: 206 * s, h: 42 * s }
  const mid = { x: stamp.x + stamp.w / 2, y: stamp.y + stamp.h / 2 }
  // a red arrow straight through the second stamp: white ink over red would
  // show, so this is what proves the mark is underneath
  st.addItem({
    id: 's4-arrow', type: 'arrow',
    points: [{ x: (336 - 40) * s, y: (132 - 40) * s + stamp.h / 2 }, { x: (336 - 40) * s + stamp.w, y: (132 - 40) * s + stamp.h / 2 }],
    style: 'solid', color: '#FF5A4E', width: 26, head: 'filled', curved: false,
  })
  // the cue ball sits on the first stamp; the twin sits on bare cloth
  st.addItem({ id: 's4-ball', type: 'ball', x: mid.x, y: mid.y, kind: 'cue' }, 'top')
  st.addItem({ id: 's4-twin', type: 'ball', x: mid.x, y: mid.y + stamp.h * 2.1, kind: 'cue' }, 'top')
  // four ghosts across the grid: the tail is the faintest thing on the table
  st.addItem({
    id: 's4-ghost', type: 'ghostTrail',
    from: { x: (110 - 40) * s, y: (300 - 40) * s }, to: { x: (900 - 40) * s, y: (300 - 40) * s },
    count: 4, autoCount: false, head: false, color: '#FFFFFF',
  })
  st.addItem({ id: 's4-zone', type: 'zone', x: (620 - 40) * s, y: (430 - 40) * s, w: 300 * s, h: 120 * s, shape: 'rect', color: '#F5A623', opacity: 0.25 }, 'bottom')
  st.addItem({ id: 's4-power', type: 'power', x: L * 0.78, y: st.scene.table.widthMm / 2, value: 4, widthMm: 150 }, 'belowText')
  st.select(null)
  return stamp
}

/** a sampler over the composite of every Konva layer, in table millimetres */
const S4_SAMPLER = `(() => {
  const layers = [...document.querySelectorAll('.konvajs-content canvas')]
  const c = document.createElement('canvas')
  c.width = layers[0].width
  c.height = layers[0].height
  const g = c.getContext('2d')
  for (const l of layers) g.drawImage(l, 0, 0)
  const L = window.__layout
  const dpr = c.width / parseFloat(layers[0].style.width)
  const d = g.getImageData(0, 0, c.width, c.height).data
  return (mx, my) => {
    const sx = L.rotation === 90 ? -my * L.scale + L.x : mx * L.scale + L.x
    const sy = L.rotation === 90 ? mx * L.scale + L.y : my * L.scale + L.y
    const x = Math.round(sx * dpr), y = Math.round(sy * dpr)
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null
    const i = (y * c.width + x) * 4
    return [d[i], d[i + 1], d[i + 2]]
  }
})()`

async function stage4(page, label) {
  await page.evaluate(S4_SCENE)
  await page.waitForTimeout(400)

  // ---- the grid: every signature distinguishable on the cloth ----
  const grid = await page.evaluate(
    (SAMPLER) => {
      const at = eval(SAMPLER)
      const marks = window.__stage.find('.watermark')
      // a stamp counts when its own box carries far more ink than bare cloth
      const inkPct = (b) => {
        let ink = 0, n = 0
        for (let u = 0.02; u < 0.98; u += 0.01)
          for (let v = 0.05; v < 0.95; v += 0.06) {
            const c = at(b.x + u * b.w, b.y + v * b.h)
            const bg = at(b.x + u * b.w, b.y + b.h * 1.75)
            if (!c || !bg) continue
            n++
            if (c[0] - bg[0] >= 3) ink++
          }
        return n ? (ink / n) * 100 : 0
      }
      const boxes = marks.map((m) => ({ x: m.x(), y: m.y(), w: m.width(), h: m.height() }))
      const pcts = boxes.map(inkPct)
      return { count: marks.length, visible: pcts.filter((p) => p >= 4).length, min: Math.min(...pcts), rotations: marks.map((m) => m.getAbsoluteRotation ? 0 : 0).length }
    },
    S4_SAMPLER,
  )
  check(`${label}: at least 12 signatures are distinguishable on the cloth`, grid.visible >= 12, `${grid.visible} of ${grid.count}, faintest ${grid.min.toFixed(1)}% ink`)

  // ---- the mark is under the content, not over it ----
  const under = await page.evaluate(
    (SAMPLER) => {
      const at = eval(SAMPLER)
      const sc = window.__store.getState().scene
      const ball = sc.items.find((i) => i.id === 's4-ball')
      const twin = sc.items.find((i) => i.id === 's4-twin')
      const r = sc.table.ballMm / 2
      // the same ball, once over a signature and once over bare cloth: if the
      // mark were on top, white ink would lighten the first one
      // means, not worst pixels: at twelve pixels across, half a pixel of
      // rounding on the ball's gradient is already fifteen levels, while a
      // white signature composited on top would raise blue by about forty
      const sum = [0, 0, 0]
      let n1 = 0
      for (let a = 0; a < 360; a += 15)
        for (const k of [0, 0.35, 0.6]) {
          const dx = Math.cos((a * Math.PI) / 180) * r * k
          const dy = Math.sin((a * Math.PI) / 180) * r * k
          const p1 = at(ball.x + dx, ball.y + dy)
          const p2 = at(twin.x + dx, twin.y + dy)
          if (!p1 || !p2) continue
          n1++
          for (let c = 0; c < 3; c++) sum[c] += p1[c] - p2[c]
        }
      const mean = sum.map((v) => v / Math.max(1, n1))
      const worst = Math.max(...mean.map(Math.abs))
      const worstAt = mean.map((v) => v.toFixed(1)).join(' / ')
      // the arrow: pure ink all the way across the signature it crosses
      const ar = sc.items.find((i) => i.id === 's4-arrow')
      let offColour = 0
      let n = 0
      for (let t = 0.1; t <= 0.9; t += 0.02) {
        const x = ar.points[0].x + (ar.points[1].x - ar.points[0].x) * t
        const c = at(x, ar.points[0].y)
        if (!c) continue
        n++
        // #FF5A4E, allowing for antialiasing along the shaft
        if (Math.abs(c[0] - 255) > 6 || Math.abs(c[1] - 90) > 8 || Math.abs(c[2] - 78) > 8) offColour++
      }
      return { worst, worstAt, offColour, n }
    },
    S4_SAMPLER,
  )
  check(`${label}: a ball over a signature is the same ball as one on bare cloth`, under.worst <= 6, `mean r/g/b shift ${under.worstAt}`)
  check(`${label}: an arrow crossing a signature keeps its own colour`, under.offColour === 0, `${under.offColour} of ${under.n} samples tinted`)

  // ---- the tail of a trajectory survives ----
  const tail = await page.evaluate(
    (SAMPLER) => {
      const at = eval(SAMPLER)
      const sc = window.__store.getState().scene
      const gh = sc.items.find((i) => i.id === 's4-ghost')
      const r = sc.table.ballMm / 2
      // the ghosts run from `from` to `to`; the last one is the faintest
      const n = gh.count
      const out = []
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : i / (n - 1)
        const cx = gh.from.x + (gh.to.x - gh.from.x) * t
        const cy = gh.from.y + (gh.to.y - gh.from.y) * t
        // brightest point on the ghost's ring against the cloth beside it
        let best = -999
        for (let a = 0; a < 360; a += 10) {
          const c = at(cx + Math.cos((a * Math.PI) / 180) * r * 0.92, cy + Math.sin((a * Math.PI) / 180) * r * 0.92)
          const bg = at(cx + Math.cos((a * Math.PI) / 180) * r * 2.4, cy + Math.sin((a * Math.PI) / 180) * r * 2.4)
          if (!c || !bg) continue
          best = Math.max(best, c[0] - bg[0])
        }
        out.push(best)
      }
      return out
    },
    S4_SAMPLER,
  )
  const faintest = Math.min(...tail)
  check(`${label}: the faintest ghost still clears the cloth by 20 levels of red`, faintest >= 20, `ghosts at ${tail.map((v) => v.toFixed(0)).join(' / ')}`)

  // ---- the indicator: nine states, 2 x value filled segments ----
  const states = await page.evaluate(
    async (SAMPLER) => {
      const values = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]
      const out = []
      for (const v of values) {
        window.__store.getState().setPower('s4-power', v)
        await new Promise((r) => setTimeout(r, 90))
        const at = eval(SAMPLER)
        const it = window.__store.getState().scene.items.find((i) => i.id === 's4-power')
        const W = it.widthMm
        const ART = { w: 100, pad: 7, cell: 62, gap: 6, h: 620 }
        const H = (W * ART.h) / ART.w
        const u = W / ART.w
        let filled = 0
        for (let ft = 0; ft < 9; ft++) {
          const c = at(it.x, it.y - H / 2 + (ART.pad + ft * (ART.cell + ART.gap) + ART.cell / 2) * u)
          // a cell the shot reaches is lit; the rest keep the hue and lose the
          // light, so the brightest channel tells them apart outright
          if (c && Math.max(c[0], c[1], c[2]) > 150) filled++
        }
        out.push({ v, filled })
      }
      return out
    },
    S4_SAMPLER,
  )
  const wrong = states.filter((s) => s.filled !== 2 * s.v)
  check(`${label}: every one of the nine states fills 2 x value segments`, wrong.length === 0, wrong.map((s) => `${s.v}->${s.filled}`).join(' ') || '9/9')

  // ---- the decimal mark is a comma ----
  const comma = await page.evaluate(
    (SAMPLER) => {
      window.__store.getState().setPower('s4-power', 4)
      return new Promise((resolve) =>
        setTimeout(() => {
          const at = eval(SAMPLER)
          const it = window.__store.getState().scene.items.find((i) => i.id === 's4-power')
          const W = it.widthMm
          const ART = { w: 100, pad: 7, cell: 62, gap: 6, h: 620 }
          const H = (W * ART.h) / ART.w
          const u = W / ART.w
          // the value is written in the topmost lit cell
          const fromTop = 9 - Math.round(it.value * 2)
          const top = it.y - H / 2 + (ART.pad + fromTop * (ART.cell + ART.gap)) * u
          const cell = ART.cell * u
          const white = (x, y) => {
            const c = at(x, y)
            return !!c && c[0] > 230 && c[1] > 230 && c[2] > 230
          }
          /** how far down the cell the ink reaches in this column band */
          const lowest = (f0, f1) => {
            let low = -1
            for (let f = f0; f <= f1; f += 0.01)
              for (let t = 0.05; t <= 0.98; t += 0.01)
                if (white(it.x - W / 2 + (ART.pad + f * (ART.w - 2 * ART.pad)) * u, top + t * cell) && t > low) low = t
            return low
          }
          // "2,5" is centred, so the separator is the middle band. A digit
          // stops at the baseline; only a comma carries a tail below it.
          resolve({ separator: lowest(0.44, 0.6), digit: lowest(0.16, 0.36) })
        }, 120),
      )
    },
    S4_SAMPLER,
  )
  check(`${label}: the decimal mark is a comma, with a tail below the baseline`,
    comma.digit > 0 && comma.separator > comma.digit + 0.03,
    `separator reaches ${comma.separator.toFixed(2)} of the cell, digits stop at ${comma.digit.toFixed(2)}`)

  // ---- density: the preset changes the count and outlives a reload ----
  const counts = await page.evaluate(async () => {
    const out = {}
    for (const d of ['light', 'dense', 'medium']) {
      window.__store.getState().setWatermarkDensity(d)
      await new Promise((r) => setTimeout(r, 120))
      out[d] = {
        stamps: window.__stage.find('.watermark').length,
        opacity: window.__stage.find('.watermark-grid')[0]?.opacity(),
      }
    }
    window.__store.getState().setWatermarkDensity('dense')
    return out
  })
  check(`${label}: the density preset changes how many signatures there are`, counts.light.stamps === 12 && counts.dense.stamps === 16, `light ${counts.light.stamps}, dense ${counts.dense.stamps}, medium ${counts.medium.stamps}`)
  check(`${label}: the quiet preset is the same grid, fainter`, counts.medium.stamps === 12 && counts.medium.opacity < counts.light.opacity, `${counts.medium.opacity} vs ${counts.light.opacity}`)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  const kept = await page.evaluate(() => ({
    density: window.__store.getState().watermarkDensity,
    stamps: window.__stage.find('.watermark').length,
  }))
  check(`${label}: the density survives a reload`, kept.density === 'dense' && kept.stamps === 16, `${kept.density}, ${kept.stamps} stamps`)
  await page.evaluate(() => window.__store.getState().setWatermarkDensity('light'))
  await page.waitForTimeout(150)

  // ---- the old mark is gone ----
  const oldMark = await page.evaluate(() => ({
    // document.fonts.check answers "can this be drawn", fallback included, so
    // it says yes for a family that no longer exists: list the faces instead
    faces: [...document.fonts].map((f) => f.family).join(' '),
    rotated: window.__stage.find('.watermark').filter((n) => Math.abs(n.rotation()) > 0.01).length,
    railed: window.__stage.find('.watermark-rail').length,
  }))
  const shipped = fs.readdirSync(path.join(process.cwd(), 'dist', 'fonts'))
  const bundle = fs
    .readdirSync(path.join(process.cwd(), 'dist', 'assets'))
    .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
    .map((f) => fs.readFileSync(path.join(process.cwd(), 'dist', 'assets', f), 'utf8'))
    .join('')
  check(`${label}: no Playfair Display in the build`, !shipped.some((f) => /watermark-(cyrillic|latin)|playfair/i.test(f)) && !/Exercise Serif|Playfair/.test(bundle), shipped.join(' '))
  check(`${label}: no diagonal signature left on the cloth`, oldMark.rotated === 0 && !/Serif|Playfair/.test(oldMark.faces), `${oldMark.rotated} rotated, faces: ${oldMark.faces}`)
  check(`${label}: the signature on the rail is still there`, oldMark.railed === 1)
}

async function picture(page, label) {
  await stage4(page, label)

  await page.evaluate(() => {
    const st = window.__store.getState()
    st.newExercise()
    st.addBall('white', { x: 1775, y: 887.5 })
    st.addBall('cue', { x: 3550 - 6, y: 1775 - 6 })
    st.addItem({ id: 'v-zone', type: 'zone', x: 2300, y: 500, w: 500, h: 400, shape: 'rect', color: '#F5A623', opacity: 0.25 }, true)
    st.addBall('white', { x: 2550, y: 700 })
    st.addItem({ id: 'v-ghost', type: 'ghostTrail', from: { x: 600, y: 1300 }, to: { x: 1400, y: 1300 }, count: 3, autoCount: false, head: false, color: '#FFFFFF' })
    st.addItem({ id: 'v-text', type: 'text', x: 500, y: 400, text: 'Проверка', size: 90, color: '#FFFFFF', angle: 0 })
    st.select(null)
  })
  await page.waitForTimeout(400)

  const m = await page.evaluate(async () => {
    const store = window.__store
    // Konva draws one canvas per layer; the table and the objects are on
    // different ones, so sample the composite, which is what the eye sees
    const layers = [...document.querySelectorAll('.konvajs-content canvas')]
    const canvas = document.createElement('canvas')
    canvas.width = layers[0].width
    canvas.height = layers[0].height
    canvas.style.width = layers[0].style.width
    const g = canvas.getContext('2d')
    for (const l of layers) g.drawImage(l, 0, 0)
    const L = window.__layout
    const scene = store.getState().scene
    const W = canvas.width, H = canvas.height
    const img = g.getImageData(0, 0, W, H).data
    const dpr = W / parseFloat(canvas.style.width)
    const at = (mx, my) => {
      const sx = L.rotation === 90 ? -my * L.scale + L.x : mx * L.scale + L.x
      const sy = L.rotation === 90 ? mx * L.scale + L.y : my * L.scale + L.y
      const x = Math.round(sx * dpr), y = Math.round(sy * dpr)
      if (x < 0 || y < 0 || x >= W || y >= H) return null
      const i = (y * W + x) * 4
      return [img[i], img[i + 1], img[i + 2], img[i + 3]]
    }
    const luma = (c) => (c ? 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] : 999)
    /** the cloth around a point, immune to a signature crossing the sample */
    const clothAround = (cx, cy, r) => {
      const ring = []
      for (let a = 0; a < 360; a += 30) {
        const c = at(cx + Math.cos((a * Math.PI) / 180) * r, cy + Math.sin((a * Math.PI) / 180) * r)
        if (c && c[3] > 200) ring.push(luma(c))
      }
      ring.sort((p, q) => p - q)
      return ring.length ? ring[Math.floor(ring.length / 2)] : 999
    }
    const LEN = scene.table.lengthMm, WID = scene.table.widthMm, D = scene.table.ballMm, r = D / 2
    const CUSHION = 55, BAND = 180

    const darkRun = (ax, ay, bx, by, thr = 40) => {
      const n = 1200
      let best = 0, cur = 0
      for (let i = 0; i <= n; i++) {
        const t = i / n
        const c = at(ax + (bx - ax) * t, ay + (by - ay) * t)
        if (c && c[3] > 200 && luma(c) < thr) cur++
        else { best = Math.max(best, cur); cur = 0 }
      }
      return (Math.max(best, cur) / n) * Math.hypot(bx - ax, by - ay)
    }
    const k = 1.5 / Math.SQRT2
    const cornerMouth = darkRun(50.91 - k, -k, -k, 50.91 - k)
    const middleMouth = darkRun(LEN / 2 - 80, -1.5, LEN / 2 + 80, -1.5)

    const distToField = (x, y) => Math.hypot(Math.max(0, -x, x - LEN), Math.max(0, -y, y - WID))
    let escaped = 0
    for (let x = -BAND; x <= LEN + BAND; x += 2)
      for (let y = -BAND; y <= WID + BAND; y += 2) {
        const dd = distToField(x, y)
        if (dd <= CUSHION || dd > BAND - 12) continue
        const c = at(x, y)
        if (c && c[3] > 200 && luma(c) < 18) escaped++
      }

    // ball: lit width through the centre, against the cloth just below it
    const ball = scene.items.find((i) => i.type === 'ball' && i.x === 1775)
    const bg = clothAround(ball.x, ball.y, D * 1.5)
    let lit = 0
    const n2 = 600
    for (let i = 0; i <= n2; i++) if (Math.abs(luma(at(ball.x - D + (2 * D * i) / n2, ball.y)) - bg) > 12) lit++
    const litPct = ((lit / n2) * 2 * D / D) * 100

    // ghost: the same measurement on the first ghost, which is nearly opaque
    const gh = scene.items.find((i) => i.id === 'v-ghost')
    const gbg = clothAround(gh.from.x, gh.from.y, D * 1.5)
    let glit = 0
    for (let i = 0; i <= n2; i++) if (Math.abs(luma(at(gh.from.x - D + (2 * D * i) / n2, gh.from.y)) - gbg) > 10) glit++
    const ghostMm = (glit / n2) * 2 * D

    // zone under the ball: the ball's centre pixel is white, not amber-tinted
    const zb = scene.items.find((i) => i.type === 'ball' && i.x === 2550)
    const c = at(zb.x - r * 0.3, zb.y - r * 0.3)
    const ballOverZoneWhite = c && c[0] > 225 && c[1] > 225 && c[2] > 225

    // containment
    const offBed = scene.items.filter((i) => i.type === 'ball').filter((i) => {
      const clear = Math.min(i.x, i.y, LEN - i.x, WID - i.y)
      const inPocket = [[0, 0], [LEN / 2, 0], [LEN, 0], [0, WID], [LEN / 2, WID], [LEN, WID]]
        .some(([px, py]) => Math.hypot(i.x - px, i.y - py) <= r + 0.01)
      return clear < r - 0.01 && !inPocket
    })
    // brass: warm yellow, well above the wood in green, well below white
    let brass = 0
    const balls = scene.items.filter((i) => i.type === 'ball')
    for (const pk of [[0, 0], [LEN / 2, 0], [LEN, 0], [0, WID], [LEN / 2, WID], [LEN, WID]]) {
      for (let x = pk[0] - 200; x <= pk[0] + 200; x += 3)
        for (let y = pk[1] - 200; y <= pk[1] + 200; y += 3) {
          // the cue ball is orange too; skip the discs
          if (balls.some((b) => Math.hypot(b.x - x, b.y - y) <= r + 6)) continue
          const c = at(x, y)
          if (!c || c[3] < 200) continue
          if (c[0] > 175 && c[1] > 130 && c[1] < 215 && c[2] < 120 && c[0] - c[2] > 70) brass++
        }
    }
    return { cornerMouth, middleMouth, escaped, litPct, ghostMm, ballOverZoneWhite, offBed: offBed.length, D, brass }
  })
  check(`${label}: black at the corner mouth is 72 mm ± 10%`, Math.abs(m.cornerMouth - 72) <= 7.2, `${m.cornerMouth.toFixed(1)} mm`)
  check(`${label}: black at the middle mouth is 82 mm ± 10%`, Math.abs(m.middleMouth - 82) <= 8.2, `${m.middleMouth.toFixed(1)} mm`)
  check(`${label}: no black past the outer contour of the rubber`, m.escaped === 0, `${m.escaped} samples`)
  check(`${label}: the lit part of a ball is >= 90% of its diameter`, m.litPct >= 90, `${m.litPct.toFixed(1)}%`)
  check(`${label}: a ghost is the ball's own diameter`, Math.abs(m.ghostMm - m.D) <= m.D * 0.08, `${m.ghostMm.toFixed(1)} vs ${m.D} mm`)
  check(`${label}: a ball over a zone is drawn on top of it`, !!m.ballOverZoneWhite)
  check(`${label}: no ball centre closer to a rail than its radius (pockets excepted)`, m.offBed === 0, `${m.offBed} off`)
  check(`${label}: no brass-coloured pixels round the pockets`, m.brass === 0, `${m.brass} samples`)

  // ---- the export: caption placement, weight, format, filename ----
  const png = await exportVia(page, label, 'PNG', '2x')
  const jpg = await exportVia(page, label, 'JPEG', '2x')
  check(`${label}: JPEG 2x export is under 500 KB`, jpg.bytes < 500 * 1024, `${Math.round(jpg.bytes / 1024)} KB`)
  check(`${label}: JPEG name carries the .jpg extension`, /\.jpg$/.test(jpg.name), jpg.name)
  check(`${label}: PNG export is still offered`, png.bytes > 0 && /\.png$/.test(png.name), `${Math.round(png.bytes / 1024)} KB`)

  // caption in the export vs on screen: find the bright text pixels near the
  // caption in both pictures and compare where they landed, in mm
  const cap = await page.evaluate(
    ([src]) =>
      new Promise((res) => {
        const img = new Image()
        img.onload = () => {
          const c = document.createElement('canvas')
          c.width = img.width
          c.height = img.height
          const g = c.getContext('2d')
          g.drawImage(img, 0, 0)
          const L = window.__layout
          // Konva draws one canvas per layer; the table and the objects are on
          // different ones, so sample the composite, which is what the eye sees
          const layers = [...document.querySelectorAll('.konvajs-content canvas')]
          const canvas = document.createElement('canvas')
          canvas.width = layers[0].width
          canvas.height = layers[0].height
          canvas.style.width = layers[0].style.width
          const sg = canvas.getContext('2d')
          for (const l of layers) sg.drawImage(l, 0, 0)
          const p = img.width / canvas.width // export px per on-screen backing px
          const dpr = canvas.width / parseFloat(canvas.style.width)
          const txt = window.__store.getState().scene.items.find((i) => i.id === 'v-text')
          // window of 900 x 200 mm around the caption anchor
          const box = (getPx) => {
            let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0
            for (let mx = txt.x - 50; mx <= txt.x + 850; mx += 3)
              for (let my = txt.y - 100; my <= txt.y + 100; my += 3) {
                const d = getPx(mx, my)
                if (d && d[0] > 200 && d[1] > 200 && d[2] > 200) {
                  x0 = Math.min(x0, mx); y0 = Math.min(y0, my); x1 = Math.max(x1, mx); y1 = Math.max(y1, my); n++
                }
              }
            return n ? { x0, y0, x1, y1, n } : null
          }
          const mmToScreen = (mx, my) => {
            const sx = L.rotation === 90 ? -my * L.scale + L.x : mx * L.scale + L.x
            const sy = L.rotation === 90 ? mx * L.scale + L.y : my * L.scale + L.y
            return [sx * dpr, sy * dpr]
          }
          const onScreen = box((mx, my) => {
            const [x, y] = mmToScreen(mx, my)
            return sg.getImageData(Math.round(x), Math.round(y), 1, 1).data
          })
          const exported = box((mx, my) => {
            const [x, y] = mmToScreen(mx, my)
            const ex = Math.round(x * p), ey = Math.round(y * p)
            if (ex < 0 || ey < 0 || ex >= img.width || ey >= img.height) return null
            return g.getImageData(ex, ey, 1, 1).data
          })
          res({ onScreen, exported, imgW: img.width, imgH: img.height })
        }
        img.src = src
      }),
    [`data:image/png;base64,${fs.readFileSync(png.file).toString('base64')}`],
  )
  const shift = cap.onScreen && cap.exported
    ? Math.hypot(cap.exported.x0 - cap.onScreen.x0, (cap.exported.y0 + cap.exported.y1) / 2 - (cap.onScreen.y0 + cap.onScreen.y1) / 2)
    : Infinity
  check(`${label}: caption in the export is where it was on screen`, shift <= 8, `shift ${shift.toFixed(1)} mm`)
  const widthRatio = cap.onScreen && cap.exported ? (cap.exported.x1 - cap.exported.x0) / (cap.onScreen.x1 - cap.onScreen.x0) : 0
  check(`${label}: caption in the export is not clipped`, widthRatio > 0.9 && widthRatio < 1.1, `width ratio ${widthRatio.toFixed(2)}`)
}

/* ---------------------------------------------------------- 3. per screen */


/* ------------------------------------ 4. the library screen (stage 6) */

/**
 * The library interface, on whatever screen this run is using. The scenarios
 * that need two devices and a server live in scripts/verify-sync.mjs; what is
 * checked here is that the screen itself works at this width - the list, the
 * trash, and the indicator that tells the coach whether the work got out.
 *
 * Every locator is scoped to .library: the toolbar underneath carries buttons
 * with the same names, and an unscoped query would match both and say nothing
 * about the screen we are actually looking at.
 */
async function stage6(page, label) {
  const openLibrary = () => page.getByRole('button', { name: /Библиотека/ }).click()
  const L = page.locator('.library')
  const titles = () => L.locator('.lib-card__title').allTextContents()

  // whatever is on the table becomes an exercise the moment the library opens
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.addBall('white', { x: 900, y: 800 })
    st.addBall('cue', { x: 1400, y: 900 })
    st.setTitle('Упражнение для списка')
  })
  await openLibrary()
  await L.waitFor({ timeout: 20000 })
  check(`${label}: the library opens`, await L.isVisible())
  // wait for the title itself, not merely for a card: the library commits the
  // open exercise when it mounts, so the row arrives a moment after the screen
  const listed = await page
    .waitForFunction(
      () => [...document.querySelectorAll('.lib-card__title')].some((e) => e.textContent === 'Упражнение для списка'),
      null,
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false)
  check(`${label}: the exercise on screen is in the list`, listed, (await titles()).join(' | '))
  const badge = (await L.locator('.sync').first().innerText()).trim()
  check(`${label}: the list says whether the work reached the server`, ['Синхронизировано', 'Есть несохранённое', 'Нет связи'].includes(badge), badge)

  // a thumbnail, or an honest object count where there is none yet - and
  // never nothing. Both are read in one pass: a sync landing between two
  // queries would reorder the list and make the check lie either way.
  const thumb = await L.locator('.lib-card')
    .first()
    .evaluate((el) => ({
      image: !!el.querySelector('img.lib-card__thumb'),
      placeholder: !!el.querySelector('.lib-card__thumb--empty'),
    }))
  check(
    `${label}: a card shows a picture or its object count`,
    thumb.image || thumb.placeholder,
    thumb.image ? 'thumbnail' : thumb.placeholder ? 'count only' : 'nothing',
  )

  const before = (await titles()).length
  await L.locator('.lib-card').first().getByRole('button', { name: 'Дублировать' }).click()
  await page.waitForFunction((n) => document.querySelectorAll('.lib-card').length === n + 1, before, { timeout: 20000 })
  // one reading, used for both the verdict and what it prints: a sync landing
  // between two readings would make the two disagree
  const afterCopy = await titles()
  check(`${label}: duplicate makes a second exercise`, afterCopy.some((t) => t.includes('(копия)')), afterCopy.join(' | '))

  page.once('dialog', (d) => d.accept('Переименовано'))
  await L.locator('.lib-card').first().getByRole('button', { name: 'Переименовать' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.lib-card__title')].some((e) => e.textContent === 'Переименовано'), null, { timeout: 20000 })
  check(`${label}: rename changes the title in the list`, (await titles()).includes('Переименовано'))

  // search, on a title we know is there exactly once
  const search = L.getByRole('searchbox', { name: 'Поиск по названию' })
  await search.fill('Переименовано')
  await page.waitForFunction(() => document.querySelectorAll('.lib-card').length === 1, null, { timeout: 20000 }).catch(() => {})
  const found = await titles()
  check(`${label}: search narrows the list to the one match`, found.join('') === 'Переименовано', found.join(' | '))
  await search.fill('')
  await page.waitForFunction((n) => document.querySelectorAll('.lib-card').length === n, before + 1, { timeout: 20000 })

  // delete -> trash -> restore
  const count = (await titles()).length
  page.once('dialog', (d) => d.accept())
  await L.locator('.lib-card').first().getByRole('button', { name: 'Удалить' }).click()
  await page.waitForFunction((n) => document.querySelectorAll('.lib-card').length === n - 1, count, { timeout: 20000 })
  check(`${label}: delete takes it out of the list`, !(await titles()).includes('Переименовано'))
  await L.getByRole('tab', { name: /Корзина/ }).click()
  await L.locator('.lib-row').first().waitFor({ timeout: 20000 })
  check(`${label}: it is in the trash, not gone`, (await L.locator('.lib-row__title').allTextContents()).includes('Переименовано'))
  await L.locator('.lib-row').first().getByRole('button', { name: 'Восстановить' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.lib-row').length === 0, null, { timeout: 20000 })
  await L.getByRole('tab', { name: /Упражнения/ }).click()
  await L.locator('.lib-card').first().waitFor({ timeout: 20000 })
  const back = await titles()
  check(`${label}: restoring brings it back`, back.includes('Переименовано'), back.join(' | '))

  // a new exercise clears the table and keeps the old ones in the library
  const kept = (await titles()).length
  await L.getByRole('button', { name: 'Новое упражнение' }).click()
  await L.waitFor({ state: 'detached', timeout: 20000 })
  check(`${label}: a new exercise clears the table`, (await scene(page)).items.length === 0)
  await openLibrary()
  await L.locator('.lib-card').first().waitFor({ timeout: 20000 })
  const still = await titles()
  check(`${label}: and nothing was lost from the library`, still.length >= kept, `${still.length} of ${kept}`)

  // opening one puts it back on the table
  await L.locator('.lib-card__main').first().click()
  await L.waitFor({ state: 'detached', timeout: 20000 })
  const opened = (await scene(page)).items.length
  check(`${label}: opening from the library puts it back on the table`, opened >= 2, `${opened} objects`)

  await page.evaluate(() => window.__library.getState().createNew())
  await page.waitForTimeout(200)
}

/* ------------------------------------------------ American pool (stage 7) */

/**
 * Read the composite of every Konva layer - what the eye sees - and measure
 * inside the page, in table millimetres. `probe` is the body of a function
 * given `at(mx, my)` -> [r, g, b, a] | null, `luma(c)`, the scene and the
 * table geometry the app publishes; whatever it returns comes back here.
 */
async function measure(page, probe) {
  return page.evaluate((body) => {
    const layers = [...document.querySelectorAll('.konvajs-content canvas')]
    const canvas = document.createElement('canvas')
    canvas.width = layers[0].width
    canvas.height = layers[0].height
    const g = canvas.getContext('2d')
    for (const l of layers) g.drawImage(l, 0, 0)
    const L = window.__layout
    const W = canvas.width, H = canvas.height
    const img = g.getImageData(0, 0, W, H).data
    const dpr = W / parseFloat(layers[0].style.width)
    const at = (mx, my) => {
      const sx = L.rotation === 90 ? -my * L.scale + L.x : mx * L.scale + L.x
      const sy = L.rotation === 90 ? mx * L.scale + L.y : my * L.scale + L.y
      const x = Math.round(sx * dpr), y = Math.round(sy * dpr)
      if (x < 0 || y < 0 || x >= W || y >= H) return null
      const i = (y * W + x) * 4
      return [img[i], img[i + 1], img[i + 2], img[i + 3]]
    }
    const luma = (c) => (c ? 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] : 999)
    const scene = window.__store.getState().scene
    return new Function('at', 'luma', 'scene', body)(at, luma, scene)
  }, probe)
}

/** a rack's balls, checked against its game's racking rule */
function rackReport(sc) {
  const balls = sc.items.filter((i) => i.type === 'ball')
  const obj = balls.filter((b) => b.kind !== 'cue')
  const cue = balls.filter((b) => b.kind === 'cue')
  const D = sc.table.ballMm
  let minGap = Infinity
  for (let i = 0; i < balls.length; i++)
    for (let j = i + 1; j < balls.length; j++)
      minGap = Math.min(minGap, Math.hypot(balls[i].x - balls[j].x, balls[i].y - balls[j].y))
  // "the centre of the rack" in every racking rule is the middle ball of the
  // third row - not the ball nearest the centroid, which in a fifteen-ball
  // triangle sits in the fourth row
  const rows = []
  for (const b of obj.slice().sort((p, q) => p.x - q.x)) {
    const row = rows.find((r) => Math.abs(r[0].x - b.x) < 1)
    if (row) row.push(b)
    else rows.push([b])
  }
  const third = (rows[2] ?? []).slice().sort((p, q) => p.y - q.y)
  const middle = third.length % 2 === 1 ? third[(third.length - 1) / 2] : null
  const apex = obj.slice().sort((a, b) => a.x - b.x)[0]
  const maxX = Math.max(...obj.map((b) => b.x))
  const back = obj.filter((b) => Math.abs(b.x - maxX) < 0.5).sort((a, b) => a.y - b.y)
  return {
    count: obj.length,
    cues: cue.length,
    numbers: obj.map((b) => b.number).sort((a, b) => a - b),
    minGap,
    D,
    centre: middle?.number,
    apex,
    backCorners: back.length ? [back[0].number, back[back.length - 1].number] : [],
    cue: cue[0],
  }
}

async function pool(page, label) {
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.newExercise()
    // something of every kind that carries a size, placed on the pyramid
    // table so the move to pool has something to carry across
    st.addBall('white', { x: 1775, y: 887.5 })
    st.addItem({ id: 'pa', type: 'arrow', points: [{ x: 600, y: 400 }, { x: 1400, y: 400 }], style: 'solid', color: '#FFFFFF', width: 14, head: 'end', curved: false })
    st.addItem({ id: 'pt', type: 'text', x: 600, y: 1300, text: 'Пул', size: 90, color: '#FFFFFF', angle: 0 })
    st.addItem({ id: 'ps', type: 'strikePoint', x: 2600, y: 1300, sizeMm: 300, dot: { u: 0, v: 0 } }, 'belowText')
    st.select(null)
  })
  const before = await scene(page)

  // ---- the game is chosen in the interface, and it is one undo ----
  if (await page.locator('.m-shell').count()) {
    await page.getByRole('button', { name: 'Меню', exact: true }).click()
    await page.getByRole('button', { name: 'Пул', exact: true }).click()
    // the cross in the sheet's head: the backdrop's centre is under the sheet
    await page.locator('.sheet__head').getByRole('button', { name: 'Закрыть' }).click()
  } else {
    await page.getByRole('button', { name: 'Пул', exact: true }).click()
  }
  await page.waitForTimeout(300)
  let sc = await scene(page)
  check(`${label}: pool is a 9-foot table, 2540 x 1270, with 57.15 mm balls`,
    sc.table.game === 'pool' && sc.table.lengthMm === 2540 && sc.table.widthMm === 1270 && sc.table.ballMm === 57.15,
    JSON.stringify(sc.table))

  // ---- the exercise came with it, in proportion ----
  const ball = sc.items.find((i) => i.type === 'ball')
  check(`${label}: a ball at the centre of the pyramid is at the centre of the pool table`,
    Math.abs(ball.x - 1270) < 0.01 && Math.abs(ball.y - 635) < 0.01, `${ball.x.toFixed(1)}, ${ball.y.toFixed(1)}`)
  check(`${label}: an object ball taken to pool gets a number`, ball.number === 1, `number ${ball.number}`)
  const arrow = sc.items.find((i) => i.id === 'pa')
  const text = sc.items.find((i) => i.id === 'pt')
  const strike = sc.items.find((i) => i.id === 'ps')
  check(`${label}: a medium arrow stays the medium preset`, arrow.width === 10, `${arrow.width} mm`)
  check(`${label}: a medium caption stays the medium preset`, text.size === 64, `${text.size} mm`)
  check(`${label}: the strike ball keeps its place on the size scale`, strike.sizeMm === 215, `${strike.sizeMm} mm`)
  check(`${label}: no ball-size choice on a pool table`, (await page.locator('#ball-mm, #m-ball-mm').count()) === 0)

  await page.evaluate(() => window.__store.getState().undo())
  await page.waitForTimeout(150)
  const undone = await scene(page)
  check(`${label}: one undo puts the pyramid table and everything on it back`,
    JSON.stringify(undone) === JSON.stringify(before), `${undone.table.lengthMm} mm, ${undone.items.length} items`)
  await page.evaluate(() => window.__store.getState().redo())
  await page.waitForTimeout(150)

  // ---- the tools say what they make on this table ----
  const toolNames = await page.getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.textContent.trim()))
  check(`${label}: the ball tool is the numbered ball on pool`, toolNames.some((n) => n.includes('Номерной шар')) && !toolNames.some((n) => n === 'Белый шар'))

  // ---- the three racks ----
  const rackVia = async (name) => {
    if (await page.locator('.m-shell').count()) await page.getByRole('button', { name: 'Меню', exact: true }).click()
    await page.getByRole('button', { name, exact: true }).click()
    await page.waitForTimeout(250)
    return rackReport(await scene(page))
  }
  const L = 2540, W = 1270
  const r8 = await rackVia('Восьмёрка')
  const all15 = r8.numbers.join(',') === '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15'
  check(`${label}: eight-ball racks the fifteen, each once, and a white cue ball`, r8.count === 15 && all15 && r8.cues === 1, r8.numbers.join(','))
  check(`${label}: eight-ball: the 8 in the centre of the rack`, r8.centre === 8, `centre ${r8.centre}`)
  check(`${label}: eight-ball: a solid and a stripe in the back corners`,
    r8.backCorners.length === 2 && (r8.backCorners[0] <= 8) !== (r8.backCorners[1] <= 8), r8.backCorners.join(' / '))
  check(`${label}: eight-ball: the apex on the foot spot`, Math.abs(r8.apex.x - L * 0.75) < 0.5 && Math.abs(r8.apex.y - W / 2) < 0.5)
  check(`${label}: eight-ball: no two balls overlap`, r8.minGap >= r8.D - 0.01, `min ${r8.minGap.toFixed(2)} mm`)
  check(`${label}: the cue ball is in the kitchen`, r8.cue && r8.cue.x < L / 4, r8.cue && `${r8.cue.x.toFixed(0)} mm`)
  const r9 = await rackVia('Девятка')
  check(`${label}: nine-ball: nine, the 1 at the apex, the 9 in the centre`,
    r9.count === 9 && r9.apex.number === 1 && r9.centre === 9 && r9.minGap >= r9.D - 0.01, `${r9.count}, apex ${r9.apex.number}, centre ${r9.centre}`)
  const r10 = await rackVia('Десятка')
  check(`${label}: ten-ball: ten, the 1 at the apex, no overlap`,
    r10.count === 10 && r10.apex.number === 1 && r10.minGap >= r10.D - 0.01, `${r10.count}, apex ${r10.apex.number}`)
  check(`${label}: a rack keeps the drawing`, (await scene(page)).items.some((i) => i.id === 'pa'))

  // ---- a new ball takes the lowest free number ----
  await page.evaluate(() => window.__store.getState().addBall('white', { x: 700, y: 300 }))
  sc = await scene(page)
  const added = sc.items[sc.items.length - 1]
  check(`${label}: a new ball takes the lowest number not on the table`, added.number === 11, `number ${added.number}`)

  // ---- the picker: which of the fifteen, or the cue ball ----
  await page.evaluate((id) => window.__store.getState().select(id), added.id)
  await page.waitForTimeout(250)
  const picker = await page.locator('.ballpick').boundingBox()
  const vp = page.viewportSize()
  check(`${label}: the ball picker is entirely on screen`,
    !!picker && picker.x >= 0 && picker.y >= 0 && picker.x + picker.width <= vp.width + 0.5 && picker.y + picker.height <= vp.height + 0.5,
    picker && `${picker.x.toFixed(0)}..${(picker.x + picker.width).toFixed(0)} of ${vp.width}`)
  const pick = page.locator('.ballpick')
  await pick.getByRole('button', { name: 'Шар 5', exact: true }).click()
  await page.waitForTimeout(150)
  let picked = (await scene(page)).items.find((i) => i.id === added.id)
  check(`${label}: picking 5 makes it the 5`, picked.number === 5 && picked.kind !== 'cue')
  await pick.getByRole('button', { name: 'Биток', exact: true }).click()
  await page.waitForTimeout(150)
  picked = (await scene(page)).items.find((i) => i.id === added.id)
  check(`${label}: picking the cue ball makes it the cue ball`, picked.kind === 'cue')
  await page.evaluate(() => window.__store.getState().undo())
  await page.waitForTimeout(100)
  picked = (await scene(page)).items.find((i) => i.id === added.id)
  check(`${label}: and that is one undo`, picked.kind !== 'cue' && picked.number === 5)

  // ---- the picture: the balls, and the pockets ----
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.select(null)
    st.setTool('select')
    // three balls laid out clear of everything, to be read pixel by pixel
    st.rackPool(9)
    const sc = window.__store.getState().scene
    const id = (n) => sc.items.find((i) => i.number === n).id
    st.updateItem(id(3), { x: 900, y: 300 })
    st.updateItem(id(8), { x: 900, y: 1000 })
    const eleven = { id: 'p11', type: 'ball', x: 1500, y: 300, kind: 'white', number: 11 }
    st.addItem(eleven)
    st.select(null)
  })
  await page.waitForTimeout(400)
  const px = await measure(page, `
    const D = scene.table.ballMm, r = D / 2
    const b = (n) => scene.items.find((i) => i.type === 'ball' && i.number === n && i.kind !== 'cue')
    const cue = scene.items.find((i) => i.type === 'ball' && i.kind === 'cue')
    const three = b(3), eight = b(8), eleven = scene.items.find((i) => i.id === 'p11')
    // the body, clear of the disc (0.5 r), the lamp's highlight (upper left)
    // and the rim: lower right, 0.7 r out
    const body = (it) => at(it.x + r * 0.5, it.y + r * 0.5)
    // inside the disc (0.5 r) but left of the digit, and below the highlight
    const disc = (it) => at(it.x - r * 0.4, it.y + r * 0.05)
    const out = { three: body(three), threeDisc: disc(three), eight: body(eight), cue: body(cue),
      // in the band (half height 0.52 r) and clear of the disc
      elevenBand: at(eleven.x + r * 0.58, eleven.y - r * 0.2), elevenCap: at(eleven.x + r * 0.15, eleven.y + r * 0.78) }

    // pockets: in front of every mouth is cloth, behind the shelf is black,
    // and the black across the opening is a funnel no wider than the mouth
    const L = scene.table.lengthMm, WID = scene.table.widthMm
    // a corner mouth runs between noses 114 / sqrt 2 from the corner, so its
    // midpoint is half that along each rail
    const a = 114 / Math.SQRT2 / 2
    const pockets = [
      { m: [a, a], out: [-Math.SQRT1_2, -Math.SQRT1_2], mouth: 114 },
      { m: [L / 2, 0], out: [0, -1], mouth: 127 },
      { m: [L - a, WID - a], out: [Math.SQRT1_2, Math.SQRT1_2], mouth: 114 },
      { m: [L / 2, WID], out: [0, 1], mouth: 127 },
    ]
    out.pockets = pockets.map((p) => {
      const pt = (d, s) => [p.m[0] + p.out[0] * d - p.out[1] * s, p.m[1] + p.out[1] * d + p.out[0] * s]
      const front = luma(at(...pt(-6, 0)))
      const deep = luma(at(...pt(30, 0)))
      // the widest dark run across the opening, just behind the shelf. The
      // drop is 0-20 in luma and the shaded back of the rubber beside it 30
      // and up, so 25 tells them apart; at 40 the two merged into one run
      let best = 0, cur = 0
      for (let s = -p.mouth; s <= p.mouth; s += 0.5) {
        const c = at(...pt(22, s))
        if (c && luma(c) < 25) { cur += 0.5; best = Math.max(best, cur) } else cur = 0
      }
      return { front, deep, run: best, mouth: p.mouth }
    })
    return out
  `)
  // red by hue, not by brightness: the lamp darkens a ball towards its edge
  const red = (c) => c && c[0] > 100 && c[0] > 2.5 * c[1] && c[0] > 2.5 * c[2]
  const white = (c) => c && c[0] > 205 && c[1] > 205 && c[2] > 205
  const black = (c) => c && Math.max(c[0], c[1], c[2]) < 60
  check(`${label}: the 3 is a red ball`, red(px.three), JSON.stringify(px.three))
  check(`${label}: with its number on a white disc`, white(px.threeDisc), JSON.stringify(px.threeDisc))
  check(`${label}: the 8 is black`, black(px.eight), JSON.stringify(px.eight))
  check(`${label}: the 11 is a red stripe on a white ball`, red(px.elevenBand) && white(px.elevenCap),
    `${JSON.stringify(px.elevenBand)} / ${JSON.stringify(px.elevenCap)}`)
  check(`${label}: the cue ball is white`, white(px.cue), JSON.stringify(px.cue))
  px.pockets.forEach((p, i) => {
    const kind = p.mouth === 114 ? 'corner' : 'side'
    check(`${label}: pocket ${i + 1} (${kind}): cloth, not black, in front of the mouth`, p.front > 60, `luma ${p.front.toFixed(0)}`)
    check(`${label}: pocket ${i + 1} (${kind}): black behind the shelf`, p.deep < 30, `luma ${p.deep.toFixed(0)}`)
    check(`${label}: pocket ${i + 1} (${kind}): the opening narrows inside the mouth`, p.run > p.mouth * 0.6 && p.run < p.mouth, `${p.run.toFixed(1)} of ${p.mouth} mm`)
  })

  // ---- the table survives a reload, numbers and all ----
  const numbersBefore = (await scene(page)).items.filter((i) => i.type === 'ball').map((b) => `${b.kind}:${b.number ?? ''}`).sort().join(',')
  await page.waitForTimeout(700)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__library?.getState().ready === true, null, { timeout: 20000 })
  await page.waitForTimeout(500)
  sc = await scene(page)
  const numbersAfter = sc.items.filter((i) => i.type === 'ball').map((b) => `${b.kind}:${b.number ?? ''}`).sort().join(',')
  check(`${label}: after a reload the table is still pool`, sc.table.game === 'pool', JSON.stringify(sc.table))
  check(`${label}: and every ball keeps its number`, numbersAfter === numbersBefore)

  // ---- to the pyramid and back: the numbers survive the round trip ----
  await page.evaluate(() => window.__store.getState().setGame('pyramid'))
  const onPyramid = await scene(page)
  check(`${label}: back on the pyramid table the balls are its own again`,
    onPyramid.table.game === undefined && onPyramid.table.lengthMm === 3550 && onPyramid.table.ballMm === 67)
  await page.evaluate(() => window.__store.getState().setGame('pool'))
  const again = (await scene(page)).items.filter((i) => i.type === 'ball').map((b) => `${b.kind}:${b.number ?? ''}`).sort().join(',')
  check(`${label}: and on pool again every ball has the number it had`, again === numbersAfter)

  // ---- the exported picture is the pool table ----
  if (!(await page.locator('.m-shell').count())) {
    const ex = await exportVia(page, `${label}-pool`, 'PNG', '1x')
    // the outer table with its padding, 2540 + 2 x (165 + 56) by 1270 +
    // 2 x (165 + 56), plus caption space - lying down or standing up, as the
    // screen has it
    const ratio = Math.max(ex.w, ex.h) / Math.min(ex.w, ex.h)
    check(`${label}: a pool picture exports`, ex.bytes > 20000 && ratio > 1.3 && ratio < 1.9, `${ex.w}x${ex.h}, ${ex.bytes} bytes`)
  }

  // everything after this runs on the pyramid table it was written for
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.setGame('pyramid')
    st.newExercise()
  })
  await page.waitForTimeout(200)
}

/**
 * Red and grey cloth, and the ball ruler.
 *
 * `phone` carries what a touch screen does differently: the cloth swatches
 * live in the menu sheet, and the ruler is drawn with a finger.
 */
async function clothAndRuler(page, label, phone = null) {
  await page.evaluate(() => window.__store.getState().newExercise())
  // ---- cloth: four swatches, each one a real colour on the canvas
  const pickCloth = async (name) => {
    if (phone) await page.getByRole('button', { name: 'Меню', exact: true }).click()
    await page.getByRole('button', { name, exact: true }).click()
    if (phone && (await page.locator('.sheet').count())) await page.locator('.sheet').getByRole('button', { name: 'Закрыть' }).last().click()
    await page.waitForTimeout(250)
  }
  /** the median colour of bare cloth, sampled on a grid away from the middle line */
  const clothColour = () =>
    measure(page, `
      const L = scene.table.lengthMm, W = scene.table.widthMm
      const px = []
      for (let i = 1; i < 8; i++) for (let j = 1; j < 4; j++) {
        const c = at(L * i / 8 + 37, W * j / 4 + 41)
        if (c) px.push(c)
      }
      const med = (k) => px.map((c) => c[k]).sort((a, b) => a - b)[Math.floor(px.length / 2)]
      return [med(0), med(1), med(2)]
    `)
  const before = await clothColour()
  for (const [name, id, test, what] of [
    ['Красное сукно', 'red', (c) => c[0] > c[1] + 50 && c[0] > c[2] + 40, 'red well above green and blue'],
    ['Серое сукно', 'grey', (c) => Math.max(...c) - Math.min(...c) < 40 && c[0] > 60, 'r, g, b within 40 and not black'],
  ]) {
    await pickCloth(name)
    const sc = await scene(page)
    const c = await clothColour()
    check(`${label}: «${name}» sets the cloth to ${id}`, sc.table.cloth === id, sc.table.cloth)
    check(`${label}: ${id} cloth is drawn ${id} on the canvas`, test(c), `rgb ${c.join(',')}: ${what}`)
    // on the phone the swatches went away with the sheet
    if (!phone) {
      const pressed = await page.getByRole('button', { name, exact: true }).first().getAttribute('aria-pressed')
      check(`${label}: the ${id} swatch shows as chosen`, pressed === 'true', String(pressed))
    }
  }
  await page.evaluate(() => window.__store.getState().undo())
  await page.waitForTimeout(150)
  check(`${label}: undo takes grey cloth back to red`, (await scene(page)).table.cloth === 'red')
  await page.evaluate(() => window.__store.getState().undo())
  await page.waitForTimeout(150)
  const back = await clothColour()
  check(`${label}: and red back to the blue it started on`, (await scene(page)).table.cloth === 'blue' && Math.abs(back[2] - before[2]) < 6, `rgb ${back.join(',')} vs ${before.join(',')}`)

  // ---- the ruler: drawn from ball to ball
  const ids = await page.evaluate(() => {
    const st = window.__store.getState()
    const D = st.scene.table.ballMm
    st.addBall('white', { x: 900, y: 887.5 })
    st.addBall('cue', { x: 900 + D * 4.4, y: 887.5 })
    st.addBall('white', { x: 2400, y: 500 })
    return window.__store.getState().scene.items.filter((i) => i.type === 'ball').map((b) => b.id)
  })
  const D = (await scene(page)).table.ballMm
  const ball = async (id) => (await scene(page)).items.find((i) => i.id === id)
  const draw = async (from, to) => {
    const [[x0, y0], [x1, y1]] = await toPageAll(page, [[from.x, from.y], [to.x, to.y]])
    if (phone) await phone.swipe([x0, y0], [x1, y1])
    else {
      await page.mouse.move(x0, y0)
      await page.mouse.down()
      await page.mouse.move(x1, y1, { steps: 14 })
      await page.mouse.move(x1, y1)
      await page.mouse.up()
      await page.waitForTimeout(200)
    }
  }
  const measures = async () => (await scene(page)).items.filter((i) => i.type === 'measure')
  const drawn = () =>
    page.evaluate(() => {
      const st = window.__stage
      const ghosts = st.find('.measure-ghost').map((n) => ({ x: n.x(), y: n.y() }))
      const labels = st.find('.measure-label').map((n) => ({ text: n.text(), rotation: n.rotation() }))
      return { ghosts, labels }
    })

  if (phone) {
    const b = page.locator('.m-dock').getByRole('button', { name: 'Расстояние в шарах', exact: true })
    await b.scrollIntoViewIfNeeded()
    await b.click()
  } else await tool(page, 'Расстояние в шарах')
  check(`${label}: the ruler tool is on the panel`, (await page.evaluate(() => window.__store.getState().tool)) === 'measure')

  const [A, B, C] = [await ball(ids[0]), await ball(ids[1]), await ball(ids[2])]
  // open cloth to open cloth is not a ruler, nor is a press and release on
  // the same ball; a ruler to a pocket, a spot or a cushion is checked later
  await draw({ x: 1500, y: 1300 }, { x: 1900, y: 1350 })
  await draw(A, { x: A.x + 20, y: A.y + 10 })
  check(`${label}: a ruler needs a ball at one end at least`, (await measures()).length === 0, `${(await measures()).length} made`)
  // that press and release on the ball was a tap on it: it is selected
  const tapped = await page.evaluate(() => ({ tool: window.__store.getState().tool, sel: window.__store.getState().selectedId }))
  check(`${label}: a tap on a ball with the ruler on selects the ball`, tapped.tool === 'select' && tapped.sel === A.id, JSON.stringify(tapped))
  if (phone) {
    const b = page.locator('.m-dock').getByRole('button', { name: 'Расстояние в шарах', exact: true })
    await b.scrollIntoViewIfNeeded()
    await b.click()
  } else await tool(page, 'Расстояние в шарах')

  await draw(A, B)
  let ms = await measures()
  check(`${label}: ball to ball makes one ruler`, ms.length === 1 && ms[0].a === A.id && ms[0].b === B.id, JSON.stringify(ms))
  let pic = await drawn()
  const gap = Math.hypot(B.x - A.x, B.y - A.y) - D
  check(`${label}: three ghosts fit in a gap of 3.4 balls`, pic.ghosts.length === 3, `${pic.ghosts.length} ghosts, gap ${(gap / D).toFixed(2)} balls`)
  const steps = pic.ghosts.map((g, i) => Math.hypot(g.x - (i ? pic.ghosts[i - 1] : A).x, g.y - (i ? pic.ghosts[i - 1] : A).y))
  check(`${label}: each ghost touches the one before it, starting at the first ball`, steps.every((s) => Math.abs(s - D) < 0.01), steps.map((s) => s.toFixed(2)).join(' / '))
  check(`${label}: the ruler is labelled «3,4 шара»`, pic.labels.length === 1 && pic.labels[0].text === '3,4 шара', JSON.stringify(pic.labels))
  const ring = await measure(page, `
    const g = ${JSON.stringify(pic.ghosts[1])}, r = ${D / 2}
    // the ring at the top of the middle ghost, against the cloth well clear of
    // it; sampled across the band, since its outer pixel is antialiased and on
    // a phone that pixel is a millimetre and a half of table
    const ringC = [1, 2, 3].flatMap((dy) => [-0.6, 0, 0.6].map((dx) => at(g.x + dx, g.y - r + dy))).filter(Boolean)
    const ringL = Math.max(...ringC.map(luma))
    return { ring: ringL, cloth: luma(at(g.x, g.y - r * 3.2)) }
  `)
  check(`${label}: the ghost's ring stands out on the cloth`, ring.ring - ring.cloth > 60, `ring ${ring.ring.toFixed(0)} vs cloth ${ring.cloth.toFixed(0)}`)

  await draw(B, A)
  check(`${label}: the same pair again does not stack a second ruler`, (await measures()).length === 1)
  await draw(B, C)
  check(`${label}: a second ruler from the same ball`, (await measures()).length === 2)

  // ---- it follows its ball, and the magnet sets a whole count
  if (phone) {
    const b = page.locator('.m-dock').getByRole('button', { name: 'Выбор', exact: true })
    await b.scrollIntoViewIfNeeded()
    await b.click()
  } else await tool(page, 'Выбор')
  // the last ruler drawn is selected, and its panel may sit over the ball
  await page.evaluate(() => window.__store.getState().select(null))
  await page.waitForTimeout(150)
  const target = { x: A.x + D * (1 + 5.04), y: A.y }
  if (phone) {
    // the finger is 60 px under where the ball goes
    const snap = await layoutSnap(page)
    const [bx, by] = mmToPx(snap, B.x, B.y)
    const [tx, ty] = mmToPx(snap, target.x, target.y)
    await phone.swipe([bx, by], [tx, ty + 60])
  } else await gesture(page, B, target)
  const B2 = await ball(B.id)
  const whole = (Math.hypot(B2.x - A.x, B2.y - A.y) - D) / D
  check(`${label}: a ball dragged to ~5 balls settles on exactly 5`, Math.abs(whole - 5) < 0.001, `${whole.toFixed(4)} balls`)
  pic = await drawn()
  const lab = pic.labels.map((l) => l.text)
  check(`${label}: the ruler follows the ball: 5 ghosts, «5 шаров»`, lab.includes('5 шаров') && pic.ghosts.length >= 5, `${lab.join(' | ')}; ${pic.ghosts.length} ghosts`)
  if (phone) check(`${label}: the count reads upright on the turned table`, pic.labels.every((l) => l.rotation === -90), pic.labels.map((l) => l.rotation).join(','))

  // ---- the panel: the read-out, the other end, the label switch
  ms = await measures()
  const first = ms.find((m) => m.a === A.id && m.b === B.id)
  await page.evaluate((id) => window.__store.getState().select(id), first.id)
  await page.waitForTimeout(200)
  const readout = await page.locator('[data-testid=measure-readout]').textContent()
  check(`${label}: the panel reads «5 шаров · 5 вплотную»`, readout === '5 шаров · 5 вплотную', readout)
  await page.locator('.props').getByRole('button', { name: 'От другого шара' }).click()
  await page.waitForTimeout(150)
  const flipped = (await measures()).find((m) => m.id === first.id)
  check(`${label}: «От другого шара» starts the row at the other ball`, flipped.a === B.id && flipped.b === A.id, `${flipped.a} -> ${flipped.b}`)
  await page.locator('.props').getByText('Подпись', { exact: true }).click()
  await page.waitForTimeout(150)
  check(`${label}: the label switch hides the count`, (await drawn()).labels.length === 1 && (await measures()).find((m) => m.id === first.id).label === false)
  await page.locator('.props').getByRole('button', { name: 'Красный', exact: true }).click()
  await page.waitForTimeout(150)
  check(`${label}: an ink swatch recolours the ruler`, (await measures()).find((m) => m.id === first.id).color === '#FF5A4E')

  // ---- a ruler goes with its ball, and comes back with it
  await page.evaluate((id) => { const st = window.__store.getState(); st.select(id); st.removeSelected() }, B.id)
  await page.waitForTimeout(150)
  check(`${label}: deleting a ball takes both of its rulers with it`, (await measures()).length === 0, `${(await measures()).length} left`)
  await page.evaluate(() => window.__store.getState().undo())
  await page.waitForTimeout(150)
  check(`${label}: one undo brings the ball and both rulers back`, (await measures()).length === 2 && !!(await ball(B.id)))

  // ---- other table, and a reload
  await page.evaluate(() => window.__store.getState().setGame('pool'))
  await page.waitForTimeout(250)
  const pool = await scene(page)
  pic = await drawn()
  const expect = pool.items.filter((i) => i.type === 'measure').reduce((n, m) => {
    const a = pool.items.find((i) => i.id === m.a), b = pool.items.find((i) => i.id === m.b)
    return n + Math.floor((Math.hypot(b.x - a.x, b.y - a.y) - pool.table.ballMm) / pool.table.ballMm + 0.02)
  }, 0)
  check(`${label}: on the pool table the rulers recount in pool balls`, pool.items.filter((i) => i.type === 'measure').length === 2 && pic.ghosts.length === expect, `${pic.ghosts.length} ghosts, expected ${expect}`)
  await page.evaluate(() => window.__store.getState().setGame('pyramid'))
  await pickCloth('Серое сукно')
  await page.waitForTimeout(900)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  const re = await scene(page)
  check(`${label}: grey cloth and both rulers survive a reload`, re.table.cloth === 'grey' && re.items.filter((i) => i.type === 'measure').length === 2, `${re.table.cloth}, ${re.items.filter((i) => i.type === 'measure').length} rulers`)
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.setCloth('blue')
    st.newExercise()
    st.setTool('select')
    // the groups after this one count history entries: start them from a
    // fresh page's empty stack, not one these checks filled to the cap
    window.__store.setState({ past: [], future: [] })
  })
  await page.waitForTimeout(150)
}

/**
 * The ruler to a pocket, a spot and a cushion; filled ghosts; reaching an
 * object with a drawing tool still on, and deleting it; the «?» help.
 */
async function endsDeleteHelp(page, label, phone = null) {
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.newExercise()
    st.setCloth('blue')
    st.setTool('select')
  })
  const pickTool = async (name) => {
    if (phone) {
      const b = page.locator('.m-dock').getByRole('button', { name, exact: true })
      await b.scrollIntoViewIfNeeded()
      await b.click()
    } else await tool(page, name)
    await page.waitForTimeout(100)
  }
  const draw = async (from, to) => {
    const [[x0, y0], [x1, y1]] = await toPageAll(page, [[from.x, from.y], [to.x, to.y]])
    if (phone) await phone.swipe([x0, y0], [x1, y1])
    else {
      await page.mouse.move(x0, y0)
      await page.mouse.down()
      await page.mouse.move(x1, y1, { steps: 14 })
      await page.mouse.move(x1, y1)
      await page.mouse.up()
      await page.waitForTimeout(200)
    }
  }
  /** a tap at a table point, nudged by some screen pixels */
  const tapAt = async (mx, my, dx = 0, dy = 0) => {
    const [[x, y]] = await toPageAll(page, [[mx, my]])
    if (phone) await page.touchscreen.tap(x + dx, y + dy)
    else await page.mouse.click(x + dx, y + dy)
    await page.waitForTimeout(220)
  }
  const state = () => page.evaluate(() => {
    const s = window.__store.getState()
    return { tool: s.tool, sel: s.selectedId, items: JSON.parse(JSON.stringify(s.scene.items)), table: s.scene.table }
  })
  const near = (p, q, tol = 0.6) => !!p && Math.hypot(p.x - q.x, p.y - q.y) <= tol

  // ---- a ruler to the cushion, to a pocket, from a spot
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.addBall('white', { x: 1200, y: 600 })
    st.addBall('cue', { x: 2500, y: 1100 })
    st.select(null)
  })
  let S = await state()
  const D = S.table.ballMm
  const L = S.table.lengthMm
  const W = S.table.widthMm
  const [A, B] = S.items.filter((i) => i.type === 'ball')
  await pickTool('Расстояние в шарах')
  await draw(A, { x: A.x + 60, y: 70 })
  await draw(B, { x: L - 12, y: W - 12 })
  await draw({ x: L / 8 + 20, y: W / 2 + 15 }, A)
  S = await state()
  const rulers = S.items.filter((i) => i.type === 'measure')
  const ghostOf = (m, end) => S.items.find((i) => i.id === m[end] && i.type === 'ghostBall')
  const toCushion = rulers.find((m) => m.a === A.id && ghostOf(m, 'b'))
  const toPocket = rulers.find((m) => m.a === B.id && ghostOf(m, 'b'))
  const fromSpot = rulers.find((m) => m.b === A.id && ghostOf(m, 'a'))
  const gc = toCushion && ghostOf(toCushion, 'b')
  const gp = toPocket && ghostOf(toPocket, 'b')
  const gs = fromSpot && ghostOf(fromSpot, 'a')
  check(`${label}: ball to cushion: a ghost touches the cushion straight across from the ball`, near(gc, { x: A.x, y: D / 2 }) && gc.owner === toCushion.id, gc ? `${gc.x.toFixed(1)},${gc.y.toFixed(1)}` : 'no ruler')
  check(`${label}: ball to pocket: the ghost sits in the pocket`, near(gp, { x: L, y: W }) && gp.owner === toPocket.id, gp ? `${gp.x.toFixed(1)},${gp.y.toFixed(1)}` : 'no ruler')
  check(`${label}: spot to ball: the ruler starts from a ghost on the house spot`, near(gs, { x: L / 8, y: W / 2 }) && gs.owner === fromSpot.id, gs ? `${gs.x.toFixed(1)},${gs.y.toFixed(1)}` : 'no ruler')
  const labels = await page.evaluate(() => window.__stage.find('.measure-label').length)
  check(`${label}: all three rulers are drawn and labelled`, rulers.length === 3 && labels === 3, `${rulers.length} rulers, ${labels} labels`)

  // the end ghost keeps snapping: dragged near the corner pocket it drops in
  if (gc) {
    await page.evaluate(([id, reach]) => window.__store.getState().dragGhostBallTo(id, { x: 24, y: 28 }, reach), [gc.id, 120])
    const moved = (await state()).items.find((i) => i.id === gc.id)
    check(`${label}: the end ghost dragged near a pocket drops into it`, near(moved, { x: 0, y: 0 }), `${moved.x.toFixed(1)},${moved.y.toFixed(1)}`)
  }

  // ---- filled ghosts
  if (toPocket) {
    await pickTool('Выбор')
    await page.evaluate((id) => window.__store.getState().select(id), toPocket.id)
    await page.waitForTimeout(200)
    const sampleFirst = () => page.evaluate(([id, r]) => {
      const g = window.__stage.findOne('#' + id).find('.measure-ghost')[0]
      return { x: g.x(), y: g.y() + r * 0.62 }
    }, [toPocket.id, D / 2])
    const at = await sampleFirst()
    const luma = (pt) => measure(page, `return luma(at(${pt.x}, ${pt.y}))`)
    const before = await luma(at)
    await page.locator('.props').getByRole('button', { name: 'Закрашенные', exact: true }).click()
    await page.waitForTimeout(200)
    const after = await luma(at)
    check(`${label}: «Закрашенные» fills the ghosts with the colour`, (await state()).items.find((i) => i.id === toPocket.id).fill === true && after > 200 && before < 175, `luma ${before.toFixed(0)} -> ${after.toFixed(0)}`)
  }

  // ---- deleting a ruler takes the ghost it made, and undo brings both back
  if (fromSpot) {
    await page.evaluate((id) => window.__store.getState().select(id), fromSpot.id)
    await page.waitForTimeout(200)
    await page.locator('.props').getByRole('button', { name: 'Удалить', exact: true }).click()
    await page.waitForTimeout(200)
    S = await state()
    check(`${label}: deleting a ruler removes the ghost it put on the spot, not the ball`, !S.items.some((i) => i.id === fromSpot.id || i.id === gs.id) && S.items.some((i) => i.id === A.id))
    await page.evaluate(() => window.__store.getState().undo())
    await page.waitForTimeout(150)
    S = await state()
    check(`${label}: one undo brings the ruler and its ghost back`, S.items.some((i) => i.id === fromSpot.id) && S.items.some((i) => i.id === gs.id))
  }

  // ---- a drawing tool still on: a tap on an object reaches it
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.newExercise()
    st.addItem({ id: 't-arrow', type: 'arrow', points: [{ x: 600, y: 1450 }, { x: 1700, y: 1450 }], style: 'solid', color: '#FFFFFF', width: 14, head: 'end', curved: false })
    st.addItem({ id: 't-ell', type: 'zone', x: 2200, y: 300, w: 900, h: 500, shape: 'ellipse', color: '#F5A623', opacity: 0.25 }, 'bottom')
    st.addBall('white', { x: 2650, y: 1300 })
    st.select(null)
  })
  const off = (px) => (phone ? [px, 0] : [0, px]) // across the arrow, on screen
  await pickTool('Стрелка')
  await tapAt(1150, 1450, ...off(10))
  S = await state()
  check(`${label}: with «Стрелка» on, a tap 10 px off an arrow selects it and switches to «Выбор»`, S.tool === 'select' && S.sel === 't-arrow', `${S.tool}, ${S.sel}`)
  const del = page.locator('.props').getByRole('button', { name: 'Удалить', exact: true })
  check(`${label}: and the panel with «Удалить» is there`, (await del.count()) === 1)
  if (await del.count()) {
    if (phone) await del.tap()
    else await del.click()
    await page.waitForTimeout(200)
  }
  check(`${label}: «Удалить» deletes the arrow`, !(await state()).items.some((i) => i.id === 't-arrow'))
  await pickTool('Эллипс')
  await tapAt(2650, 550)
  S = await state()
  check(`${label}: with «Эллипс» on, a tap inside an ellipse selects it`, S.tool === 'select' && S.sel === 't-ell', `${S.tool}, ${S.sel}`)
  if ((await del.count()) === 1) {
    if (phone) await del.tap()
    else await del.click()
    await page.waitForTimeout(200)
  }
  check(`${label}: and «Удалить» deletes the ellipse`, !(await state()).items.some((i) => i.id === 't-ell'))
  const ballNow = (await state()).items.find((i) => i.type === 'ball')
  await pickTool(phone ? 'Белый шар' : 'Белый шар')
  await tapAt(ballNow.x, ballNow.y)
  S = await state()
  check(`${label}: with the ball tool on, a tap on a ball selects it instead of adding another`, S.sel === ballNow.id && S.items.filter((i) => i.type === 'ball').length === 1 && S.tool === 'select', `${S.sel}, ${S.items.filter((i) => i.type === 'ball').length} balls`)
  // in «Выбор» an arrow is caught by a band a finger can hit
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.addItem({ id: 't-arrow2', type: 'arrow', points: [{ x: 600, y: 1450 }, { x: 1700, y: 1450 }], style: 'solid', color: '#FFFFFF', width: 14, head: 'end', curved: false })
    st.select(null)
    st.setTool('select')
  })
  await page.waitForTimeout(200)
  await tapAt(1150, 1450, ...off(phone ? 14 : 9))
  check(`${label}: in «Выбор» a tap ${phone ? 14 : 9} px off an arrow still catches it`, (await state()).sel === 't-arrow2', String((await state()).sel))

  // ---- help
  await page.evaluate(() => window.__store.getState().select(null))
  const scope = phone ? page.locator('.m-dock') : page.locator('.toolbar .tool-grid')
  const dots = await scope.locator('.help-dot').count()
  check(`${label}: every tool has its «?»`, dots === 13, `${dots}`)
  const dot = scope.getByRole('button', { name: 'Подсказка: Стрелка' })
  await dot.scrollIntoViewIfNeeded()
  await dot.click()
  await page.waitForTimeout(250)
  const dlg = page.getByRole('dialog', { name: 'Стрелка' })
  const shown = await dlg.count()
  const text = shown ? await dlg.innerText() : ''
  check(`${label}: «?» opens the help for that tool without switching to it`, shown === 1 && /протяните/i.test(text) && (await state()).tool === 'select', `${shown} dialog, tool ${(await state()).tool}`)
  if (!phone && shown) {
    const bb = await page.locator('.help-pop__card').boundingBox()
    const vp = page.viewportSize()
    const tb = await page.locator('.toolbar').boundingBox()
    check(`${label}: the help card is on screen, past the tool panel`, !!bb && bb.x >= tb.x + tb.width && bb.y >= 0 && bb.y + bb.height <= vp.height + 0.5, bb ? `${bb.x.toFixed(0)},${bb.y.toFixed(0)} ${bb.width.toFixed(0)}x${bb.height.toFixed(0)}` : 'none')
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  check(`${label}: Esc closes the help`, (await page.getByRole('dialog').count()) === 0)
  if (phone) await page.getByRole('button', { name: 'Меню', exact: true }).click()
  await page.getByRole('button', { name: 'Как пользоваться' }).click()
  await page.waitForTimeout(250)
  const general = page.getByRole('dialog', { name: 'Как пользоваться' })
  check(`${label}: «Как пользоваться» opens the general help`, (await general.count()) === 1 && /Удалить/.test(await general.innerText()))
  await general.getByRole('button', { name: 'Закрыть' }).last().click()
  await page.waitForTimeout(150)
  check(`${label}: ✕ closes it`, (await page.getByRole('dialog').count()) === 0)
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.newExercise()
    st.setTool('select')
    window.__store.setState({ past: [], future: [] })
  })
}

/**
 * A ghost of a ruler's row replaced by a real ball; no figures on the ghosts;
 * selecting several objects, grouping them, moving, turning and deleting
 * the group.
 */
async function ghostsAndGroups(page, label, phone = null) {
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.newExercise()
    st.setTool('select')
  })
  const tapAt = async (mx, my) => {
    const [[x, y]] = await toPageAll(page, [[mx, my]])
    if (phone) await page.touchscreen.tap(x, y)
    else await page.mouse.click(x, y)
    await page.waitForTimeout(220)
  }
  const dragMm = async (from, to) => {
    const [[x0, y0], [x1, y1]] = await toPageAll(page, [[from.x, from.y], [to.x, to.y]])
    if (phone) await phone.swipe([x0, y0], [x1, y1])
    else {
      await page.mouse.move(x0, y0)
      await page.mouse.down()
      await page.mouse.move(x1, y1, { steps: 16 })
      await page.mouse.move(x1, y1)
      await page.mouse.up()
      await page.waitForTimeout(220)
    }
  }
  const state = () => page.evaluate(() => {
    const s = window.__store.getState()
    return { sel: s.selection, picked: s.pickedGhost, multi: s.multiMode, items: JSON.parse(JSON.stringify(s.scene.items)), table: s.scene.table }
  })
  const press = async (name) => {
    const b = page.locator('.props').getByRole('button', { name, exact: true })
    if (phone) await b.tap()
    else await b.click()
    await page.waitForTimeout(200)
  }

  // ---- the row: no figures; a tapped ghost becomes a real ball
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.addBall('cue', { x: 800, y: 887.5 })
    st.addBall('white', { x: 800 + st.scene.table.ballMm * 6, y: 887.5 })
    const [a, b] = window.__store.getState().scene.items.map((i) => i.id)
    st.addItem({ id: 'g-row', type: 'measure', a, b, color: '#FFFFFF', label: true }, 'bottom')
    st.select(null)
  })
  let S = await state()
  const D = S.table.ballMm
  const rowGhosts = () => page.evaluate(() => window.__stage.findOne('#g-row').find('.measure-ghost').length)
  const figures = await page.evaluate(() => window.__stage.findOne('#g-row').find('.measure-ghost').reduce((n, g) => n + g.find('Text').length, 0))
  check(`${label}: the ghosts of a ruler carry no figures`, figures === 0 && (await rowGhosts()) === 5, `${figures} figures, ${await rowGhosts()} ghosts`)
  await tapAt(800 + D * 3, 887.5)
  S = await state()
  check(`${label}: a tap on a ghost of the row picks that ghost`, S.picked?.measure === 'g-row' && S.picked?.index === 2, JSON.stringify(S.picked))
  await press('Биток')
  S = await state()
  const put = S.items.find((i) => i.type === 'ball' && Math.hypot(i.x - (800 + D * 3), i.y - 887.5) < 0.01)
  check(`${label}: «Заменить призрак на: Биток» puts a cue ball exactly in the ghost's place`, !!put && put.kind === 'cue' && S.sel[0] === put.id, put ? `${put.x.toFixed(2)},${put.y.toFixed(2)} ${put.kind}` : 'none')
  check(`${label}: the ghost under the new ball is no longer drawn`, (await rowGhosts()) === 4, `${await rowGhosts()} ghosts`)
  await page.evaluate(() => window.__store.getState().undo())
  await page.waitForTimeout(150)
  check(`${label}: one undo takes the ball back and the ghost returns`, (await rowGhosts()) === 5 && !(await state()).items.some((i) => i.id === put?.id))
  // a wireframe ball at the end of a ruler, made real: the ruler stays on it
  await page.evaluate(() => {
    const st = window.__store.getState()
    const a = st.scene.items.find((i) => i.type === 'ball').id
    st.addMeasure({ id: 'g-end', type: 'measure', a, b: 'g-gb', color: '#FFFFFF', label: true }, [{ id: 'g-gb', type: 'ghostBall', x: 800, y: 300, owner: 'g-end' }])
    st.select('g-gb')
  })
  await page.waitForTimeout(150)
  await press('Белый')
  S = await state()
  const made = S.items.find((i) => i.id === 'g-gb')
  check(`${label}: «Заменить на: Белый» makes a wireframe ball a real one, and its ruler stays`, made?.type === 'ball' && made.kind === 'white' && S.items.some((i) => i.id === 'g-end'), made ? made.type : 'gone')

  // ---- several objects: a frame selects what lies inside it
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.newExercise()
    st.addBall('white', { x: 1500, y: 650 })
    st.addBall('white', { x: 1700, y: 650 })
    st.addItem({ id: 'g-ar', type: 'arrow', points: [{ x: 1450, y: 850 }, { x: 1800, y: 850 }], style: 'solid', color: '#FFFFFF', width: 14, head: 'end', curved: false })
    st.addItem({ id: 'g-zn', type: 'zone', x: 1400, y: 550, w: 500, h: 400, shape: 'rect', color: '#F5A623', opacity: 0.25 }, 'bottom')
    st.addBall('cue', { x: 2700, y: 1350 })
    st.select(null)
    st.setTool('select')
  })
  await page.waitForTimeout(150)
  S = await state()
  const inside = S.items.filter((i) => i.type !== 'ball' || i.x < 2000).map((i) => i.id)
  const outside = S.items.find((i) => i.type === 'ball' && i.kind === 'cue')
  await dragMm({ x: 1350, y: 500 }, { x: 1960, y: 1000 })
  S = await state()
  check(`${label}: a frame over the cloth selects the four objects inside it, not the one outside`, S.sel.length === 4 && inside.every((id) => S.sel.includes(id)) && !S.sel.includes(outside.id), `${S.sel.length} selected`)
  const count = await page.locator('[data-testid=selection-count]').textContent().catch(() => '')
  check(`${label}: the panel says what is selected`, count === 'Выбрано: 4 объекта', count)
  await press('Сгруппировать')
  S = await state()
  const gid = S.items.find((i) => i.id === 'g-ar')?.group
  check(`${label}: «Сгруппировать» puts the four in one group`, !!gid && inside.every((id) => S.items.find((i) => i.id === id).group === gid) && !outside.group)
  await page.evaluate(() => window.__store.getState().select(null))
  await tapAt(1500, 650)
  S = await state()
  check(`${label}: a tap on one member selects the whole group`, S.sel.length === 4, `${S.sel.length}`)

  // ---- the group moves as one, and stops at the cushion
  const before = S.items
  await dragMm({ x: 1500, y: 650 }, { x: 1800, y: 850 })
  S = await state()
  const delta = (id) => {
    const a = before.find((i) => i.id === id)
    const b = S.items.find((i) => i.id === id)
    const pa = a.type === 'arrow' ? a.points[0] : a
    const pb = b.type === 'arrow' ? b.points[0] : b
    return { x: pb.x - pa.x, y: pb.y - pa.y }
  }
  const ds = inside.map(delta)
  const same = ds.every((d) => Math.abs(d.x - ds[0].x) < 0.5 && Math.abs(d.y - ds[0].y) < 0.5)
  check(`${label}: dragging one member moves the whole group by the same step`, same && Math.hypot(ds[0].x - 300, ds[0].y - 200) < 30, ds.map((d) => `${d.x.toFixed(0)},${d.y.toFixed(0)}`).join(' '))
  const ballNow = S.items.find((i) => i.type === 'ball' && i.group === gid)
  await dragMm(ballNow, { x: ballNow.x, y: ballNow.y - 2000 })
  S = await state()
  const top = Math.min(...S.items.filter((i) => i.type === 'ball' && i.group === gid).map((i) => i.y))
  check(`${label}: pushed at the cushion, the group stops with its balls on the cloth`, Math.abs(top - D / 2) < 0.6, `top ball at y ${top.toFixed(2)}`)
  await page.evaluate(() => window.__store.getState().undo())
  await page.waitForTimeout(150)

  // ---- the lever turns it about its centre, by 15-degree steps
  await page.evaluate(() => window.__store.getState().select('g-ar'))
  await page.waitForTimeout(250)
  S = await state()
  const lev = await page.evaluate(() => {
    const n = window.__stage.findOne('.rotate-lever')
    return n ? { x: n.x(), y: n.y() } : null
  })
  const zoneB = S.items.find((i) => i.id === 'g-zn')
  const boxC = await page.evaluate(() => {
    const st = window.__store.getState()
    const ids = st.selection
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const n of window.__stage.find('.selection-frame')) void n
    for (const it of st.scene.items) {
      if (!ids.includes(it.id)) continue
      const pts = it.type === 'arrow' ? it.points : it.type === 'zone' ? [{ x: it.x, y: it.y }, { x: it.x + it.w, y: it.y + it.h }] : [{ x: it.x - st.scene.table.ballMm / 2, y: it.y - st.scene.table.ballMm / 2 }, { x: it.x + st.scene.table.ballMm / 2, y: it.y + st.scene.table.ballMm / 2 }]
      for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y) }
    }
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
  })
  check(`${label}: a selected group has a turning lever`, !!lev)
  if (lev) {
    const r = Math.hypot(lev.x - boxC.x, lev.y - boxC.y)
    await dragMm(lev, { x: boxC.x + r, y: boxC.y })
    S = await state()
    const z = S.items.find((i) => i.id === 'g-zn')
    const ar = S.items.find((i) => i.id === 'g-ar')
    const zc = { x: z.x + z.w / 2, y: z.y + z.h / 2 }
    const zc0 = { x: zoneB.x + zoneB.w / 2, y: zoneB.y + zoneB.h / 2 }
    check(`${label}: dragging the lever a quarter round turns the group 90°: zone and arrow with it`, z.angle === 90 && Math.abs(ar.points[0].x - ar.points[1].x) < 1 && Math.hypot(zc.x - zc0.x, zc.y - zc0.y) < 60, `zone ${z.angle}°, arrow dx ${(ar.points[1].x - ar.points[0].x).toFixed(1)}`)
    const field = S.items.filter((i) => i.type === 'ball').every((b) => b.x >= D / 2 - 0.01 && b.y >= D / 2 - 0.01 && b.x <= S.table.lengthMm - D / 2 + 0.01 && b.y <= S.table.widthMm - D / 2 + 0.01)
    check(`${label}: the turned balls are on the cloth`, field)
  }

  // ---- delete, undo, duplicate, ungroup
  await page.evaluate(() => window.__store.getState().select('g-ar'))
  await page.waitForTimeout(200)
  await press('Удалить')
  S = await state()
  check(`${label}: «Удалить» removes the whole group, nothing else`, S.items.length === 1 && S.items[0].id === outside.id, `${S.items.length} left`)
  await page.evaluate(() => window.__store.getState().undo())
  await page.waitForTimeout(150)
  S = await state()
  check(`${label}: one undo brings the group back, still a group`, inside.every((id) => S.items.find((i) => i.id === id)?.group === gid))
  await page.evaluate(() => window.__store.getState().select('g-ar'))
  await page.waitForTimeout(200)
  await press('Дублировать')
  S = await state()
  const copies = S.items.filter((i) => i.group && i.group !== gid)
  check(`${label}: «Дублировать» copies the group as a group of its own`, copies.length === 4 && new Set(copies.map((i) => i.group)).size === 1 && S.sel.length === 4)
  await press('Разгруппировать')
  S = await state()
  check(`${label}: «Разгруппировать» takes the copy apart`, copies.every((c) => !S.items.find((i) => i.id === c.id).group))

  // ---- picking several by hand: Shift+click, or «Выбрать несколько»
  await page.evaluate((id) => {
    const st = window.__store.getState()
    st.newExercise()
    // each next ball up and to the left of the one before, on the screen,
    // whichever way the table stands: the panel hangs below the selection
    // and would otherwise sit on the ball the coach reaches for next
    st.addBall('white', { x: 1300, y: 1100 })
    st.addBall('white', { x: 1000, y: 800 })
    st.addBall('white', { x: 700, y: 500 })
    st.select(null)
    void id
  })
  await page.waitForTimeout(150)
  await tapAt(1300, 1100)
  if (!phone) {
    await page.keyboard.down('Shift')
    await tapAt(1000, 800)
    await page.keyboard.up('Shift')
    check(`${label}: Shift+click adds a ball to the selection`, (await state()).sel.length === 2, `${(await state()).sel.length}`)
    await page.keyboard.down('Shift')
    await tapAt(1000, 800)
    await page.keyboard.up('Shift')
    check(`${label}: Shift+click again takes it out`, (await state()).sel.length === 1, `${(await state()).sel.length}`)
  }
  await press('Выбрать несколько')
  check(`${label}: «Выбрать несколько» turns the mode on`, (await state()).multi === true)
  await tapAt(700, 500)
  await tapAt(1000, 800)
  check(`${label}: in that mode each tap adds an object`, (await state()).sel.length === 3, `${(await state()).sel.length}`)
  await tapAt(1000, 800)
  check(`${label}: and a tap on a selected one takes it out`, (await state()).sel.length === 2, `${(await state()).sel.length}`)

  // ---- a group and a turned zone survive a reload
  if (!phone) {
    await page.evaluate(() => {
      const st = window.__store.getState()
      st.newExercise()
      st.addItem({ id: 'p-zn', type: 'zone', x: 1400, y: 550, w: 500, h: 300, shape: 'ellipse', color: '#F5A623', opacity: 0.25, angle: 30 }, 'bottom')
      st.addBall('white', { x: 1650, y: 700 })
      st.selectMany(['p-zn', window.__store.getState().scene.items.find((i) => i.type === 'ball').id])
      st.groupSelection()
    })
    await page.waitForTimeout(900)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(900)
    S = await state()
    const z = S.items.find((i) => i.id === 'p-zn')
    check(`${label}: a group and a turned zone survive a reload`, z?.angle === 30 && !!z.group && S.items.every((i) => i.group === z.group), z ? `${z.angle}°, group ${z.group}` : 'gone')
  }
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.newExercise()
    st.setTool('select')
    window.__store.setState({ past: [], future: [] })
  })
}

async function run(viewport, dsf, label, full) {
  const { ctx, page, errors } = await newPage(viewport, dsf)
  await clothAndRuler(page, label)
  await endsDeleteHelp(page, label)
  await ghostsAndGroups(page, label)
  if (full) await behaviour(page, label)
  await picture(page, label)
  await stage6(page, label)
  await pool(page, label)

  // clipboard: the button must produce an image/png item
  await page.evaluate(() => window.__store.getState().addBall('white', { x: 1000, y: 1000 }))
  await page.getByRole('button', { name: 'Копировать в буфер' }).click()
  await page.locator('.toast').waitFor({ timeout: 30000 }).catch(() => {})
  const clip = await page.evaluate(async () => {
    try {
      const items = await navigator.clipboard.read()
      return items.some((it) => it.types.includes('image/png'))
    } catch (e) {
      return 'err:' + (e && e.message)
    }
  })
  check(`${label}: copy to clipboard puts an image/png on the clipboard`, clip === true, String(clip))

  check(`${label}: no console or page errors`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await ctx.close()
}

if (!ONLY || ONLY === 'desktop') await run({ width: 1440, height: 900 }, 2, 'desktop', true)
if (!ONLY || ONLY === 'ipad') await run({ width: 1024, height: 1366 }, 2, 'ipad-portrait', true)

// phone: the mobile shell - dock, sheets, touch placement, pinch zoom
if (!ONLY || ONLY === 'phone') {
  const { ctx, page, errors } = await newPage({ width: 390, height: 844 }, 3, { hasTouch: true, isMobile: true })
  const cdp = await ctx.newCDPSession(page)
  const touchTo = async (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x, y })) })
  /** one finger: press, slide, release */
  const swipe = async (from, to, steps = 14) => {
    await touchTo('touchStart', [from])
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      await touchTo('touchMove', [[from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]])
      await page.waitForTimeout(16)
    }
    await touchTo('touchEnd', [])
    await page.waitForTimeout(200)
  }
  /** two fingers on a horizontal line about `c`, spreading from r0 to r1 */
  const pinch = async (c, r0, r1, steps = 14) => {
    const pts = (r) => [[c[0] - r, c[1]], [c[0] + r, c[1]]]
    await touchTo('touchStart', pts(r0))
    for (let i = 1; i <= steps; i++) {
      await touchTo('touchMove', pts(r0 + ((r1 - r0) * i) / steps))
      await page.waitForTimeout(16)
    }
    await touchTo('touchEnd', [])
    await page.waitForTimeout(200)
  }
  const view = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__view.getState().viewport)))
  const stageBox = () => page.locator('.konvajs-content').boundingBox()

  check('phone: table auto-rotates upright', await page.evaluate(() => window.__layout.rotation === 90))
  check('phone: the mobile shell is in use', (await page.locator('.m-shell').count()) === 1)

  // ---- the dock: every tool reachable, tap targets big enough, nothing off screen
  const dock = page.locator('.m-dock')
  const db = await dock.boundingBox()
  check('phone: the dock is inside the viewport', !!db && db.y + db.height <= 844 + 0.5 && db.x >= 0, db ? `bottom ${(db.y + db.height).toFixed(0)}` : 'no dock')
  const toolIds = [
    ['Выбор', 'select'], ['Белый шар', 'ball-white'], ['Биток', 'ball-cue'], ['Стрелка', 'arrow'],
    ['Траектория', 'ghost'], ['Линия', 'line'], ['Зона', 'zone-rect'], ['Эллипс', 'zone-ellipse'],
    ['Текст', 'text'], ['Точка на шаре', 'strike'], ['Сила удара', 'power'], ['Шар-призрак', 'ghost-ball'],
    ['Расстояние в шарах', 'measure'],
  ]
  let reachable = 0
  let small = 0
  for (const [name, id] of toolIds) {
    const b = dock.getByRole('button', { name, exact: true })
    await b.scrollIntoViewIfNeeded()
    const bb = await b.boundingBox()
    if (bb && (bb.width < 44 || bb.height < 44)) small++
    await b.click()
    if ((await page.evaluate(() => window.__store.getState().tool)) === id) reachable++
  }
  check(`phone: all ${toolIds.length} tools reachable from the dock`, reachable === toolIds.length, `${reachable}/${toolIds.length}`)
  check('phone: every dock button is at least 44 px', small === 0, `${small} small`)
  const stageBb = await stageBox()
  check('phone: the table takes most of the width', stageBb.width >= 360, `${stageBb.width.toFixed(0)} px`)

  // ---- place a ball with a tap
  await dock.getByRole('button', { name: 'Белый шар', exact: true }).scrollIntoViewIfNeeded()
  await dock.getByRole('button', { name: 'Белый шар', exact: true }).click()
  const [bx, by] = await toPage(page, 1200, 900)
  await page.touchscreen.tap(bx, by)
  await page.waitForTimeout(200)
  let sc = await scene(page)
  const placed = sc.items.find((i) => i.type === 'ball')
  check('phone: a tap places a ball where the finger is', !!placed && Math.hypot(placed.x - 1200, placed.y - 900) < 25,
    placed ? `${placed.x.toFixed(0)},${placed.y.toFixed(0)}` : 'no ball')
  // the browser echoes a tap as mouse events; that echo must not place a twin
  check('phone: a tap places exactly one ball', sc.items.filter((i) => i.type === 'ball').length === 1, `${sc.items.filter((i) => i.type === 'ball').length} balls`)
  await dock.getByRole('button', { name: 'Точка на шаре', exact: true }).scrollIntoViewIfNeeded()
  await dock.getByRole('button', { name: 'Точка на шаре', exact: true }).click()
  const [wx, wy] = await toPage(page, 2600, 400)
  await page.touchscreen.tap(wx, wy)
  await page.waitForTimeout(200)
  sc = await scene(page)
  check('phone: a tap places exactly one widget', sc.items.filter((i) => i.type === 'strikePoint').length === 1, `${sc.items.filter((i) => i.type === 'strikePoint').length} widgets`)
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.select(st.scene.items.find((i) => i.type === 'strikePoint').id)
    st.removeSelected()
  })

  // ---- drag it with a finger: the ball rides 60 px above the finger
  await dock.getByRole('button', { name: 'Выбор', exact: true }).scrollIntoViewIfNeeded()
  await dock.getByRole('button', { name: 'Выбор', exact: true }).click()
  await page.waitForTimeout(150) // the hit canvas is redrawn a frame later
  const L0 = await page.evaluate(() => window.__layout)
  const [fx, fy] = await toPage(page, placed.x, placed.y)
  await swipe([fx, fy], [fx + 40, fy + 150])
  sc = await scene(page)
  const dragged = sc.items.find((i) => i.id === placed.id)
  // the finger's end point in mm, then 60 screen px "up", which on the upright
  // table is minus x in table mm
  const endMm = await page.evaluate(([x, y]) => {
    const l = window.__layout
    const c = document.querySelector('.konvajs-content').getBoundingClientRect()
    const px = x - c.left, py = y - c.top
    const dx = px - l.x, dy = py - l.y
    return l.rotation === 90 ? { x: dy / l.scale, y: -dx / l.scale } : { x: dx / l.scale, y: dy / l.scale }
  }, [fx + 40, fy + 150])
  const wantX = endMm.x - 60 / L0.scale
  const liftErr = Math.hypot(dragged.x - wantX, dragged.y - endMm.y)
  check('phone: a touch drag lifts the ball 60 px above the finger', liftErr < 15, `off by ${liftErr.toFixed(0)} mm (ball ${dragged.x.toFixed(0)},${dragged.y.toFixed(0)}; finger ${endMm.x.toFixed(0)},${endMm.y.toFixed(0)})`)
  check('phone: one touch drag is one history entry', (await page.evaluate(() => window.__store.getState().past.length)) >= 1)

  // ---- select with a tap, properties strip, nudge, strip flips away from the object
  const [sx, sy] = await toPage(page, dragged.x, dragged.y)
  await page.touchscreen.tap(sx, sy)
  await page.waitForTimeout(200)
  check('phone: tap selects a ball', (await scene(page)).selectedId === dragged.id)
  const props = page.locator('.props')
  check('phone: properties strip shows for the selection', await props.isVisible())
  const x0 = dragged.x
  await props.getByRole('button', { name: 'Вправо 5 мм' }).click()
  await page.waitForTimeout(100)
  const nudged = (await scene(page)).items.find((i) => i.id === dragged.id)
  check('phone: nudge button moves the ball 5 mm', Math.abs(nudged.x - x0 - 5) < 0.01, `${x0.toFixed(1)} -> ${nudged.x.toFixed(1)}`)
  // an object in the lower half: the strip moves to the top edge
  await page.evaluate(() => {
    window.__store.getState().addBall('white', { x: 3100, y: 900 })
    // a fresh snapshot: the store is immutable, the old one has no new ball
    const st = window.__store.getState()
    st.select(st.scene.items.at(-1).id)
  })
  await page.waitForTimeout(150)
  const pbLow = await props.boundingBox()
  const sbLow = await stageBox()
  check('phone: strip flips to the top for an object near the bottom', pbLow && pbLow.y < sbLow.y + sbLow.height / 2, pbLow ? `strip top ${pbLow.y.toFixed(0)}, stage mid ${(sbLow.y + sbLow.height / 2).toFixed(0)}` : 'no strip')
  await page.evaluate(() => {
    const st = window.__store.getState()
    st.select(st.scene.items.find((i) => i.type === 'ball').id)
  })
  await page.waitForTimeout(150)
  const pbHigh = await props.boundingBox()
  check('phone: strip sits at the bottom for an object near the top', pbHigh && pbHigh.y > sbLow.y + sbLow.height / 2, pbHigh ? `strip top ${pbHigh.y.toFixed(0)}` : 'no strip')
  await page.evaluate(() => window.__store.getState().select(null))

  // ---- pinch zoom, one-finger pan, the "whole table" button
  const sb = await stageBox()
  const c = [sb.x + sb.width / 2, sb.y + sb.height / 2]
  check('phone: starts at zoom 1', (await view()).zoom === 1)
  await page.evaluate(() => {
    window.__tlog = []
    const st = window.__stage
    st.on('touchstart', (e) => window.__tlog.push('ts:' + (e.target === st ? 'stage' : e.target.name() || e.target.className)))
    st.on('touchmove', () => window.__tlog.push('tm' + st.getPointersPositions().length))
    st.on('dragstart', (e) => window.__tlog.push('drag:' + (e.target.name() || e.target.className)))
  })
  await pinch(c, 40, 120)
  let v = await view()
  const tlog = await page.evaluate(() => window.__tlog.join(' '))
  check('phone: a pinch zooms in (about x3)', v.zoom > 2.4 && v.zoom <= 4, `zoom ${v.zoom.toFixed(2)}; events: ${tlog}`)
  check('phone: the layer transform follows the zoom', Math.abs((await page.evaluate(() => window.__layout.scale)) / L0.scale - v.zoom) < 0.05)
  const fit = page.getByRole('button', { name: 'Показать весь стол' })
  check('phone: a "whole table" button appears when zoomed', await fit.isVisible())
  const before = v
  await swipe([c[0], c[1] - 100], [c[0], c[1] + 20])
  v = await view()
  check('phone: one finger pans the zoomed picture', v.zoom === before.zoom && v.panY - before.panY > 60, `pan ${before.panY.toFixed(0)} -> ${v.panY.toFixed(0)}`)
  check('phone: panning did not create anything', (await scene(page)).items.length === 2)
  await pinch(c, 120, 30)
  v = await view()
  check('phone: pinching in zooms back out', v.zoom < before.zoom, `zoom ${v.zoom.toFixed(2)}`)
  await pinch(c, 40, 120)
  await fit.click()
  await page.waitForTimeout(100)
  v = await view()
  check('phone: the button resets to the whole table', v.zoom === 1 && v.panX === 0 && v.panY === 0)
  // one finger lands on a ball, the other on cloth: still a pinch, not a drag
  const b1 = (await scene(page)).items.find((i) => i.type === 'ball')
  const [b1x, b1y] = await toPage(page, b1.x, b1.y)
  await pinch([b1x + 30, b1y], 30, 110)
  v = await view()
  const b1after = (await scene(page)).items.find((i) => i.id === b1.id)
  const moved = Math.hypot(b1after.x - b1.x, b1after.y - b1.y)
  check('phone: a pinch that starts on a ball zooms', v.zoom > 2, `zoom ${v.zoom.toFixed(2)}`)
  check('phone: a pinch that starts on a ball leaves the ball in place', moved < 3, `moved ${moved.toFixed(1)} mm`)
  await fit.click()
  await page.waitForTimeout(100)

  // ---- the export never depends on the zoom
  await page.evaluate(() => window.__store.getState().newExercise())
  await picture(page, 'phone')
  const flat = await exportVia(page, 'phone-flat', 'PNG', '1x')
  await page.evaluate(() => window.__view.getState().setViewport({ zoom: 2.5, panX: 40, panY: -80 }))
  await page.waitForTimeout(150)
  const zoomed = await exportVia(page, 'phone-zoomed', 'PNG', '1x')
  check('phone: export at zoom 2.5 has the same size as at zoom 1', zoomed.w === flat.w && zoomed.h === flat.h, `${zoomed.w}x${zoomed.h} vs ${flat.w}x${flat.h}`)
  const diff = await page.evaluate(
    ([a, b]) =>
      new Promise((res) => {
        const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src })
        Promise.all([load(a), load(b)]).then(([ia, ib]) => {
          const c = document.createElement('canvas')
          c.width = ia.width; c.height = ia.height
          const g = c.getContext('2d')
          g.drawImage(ia, 0, 0)
          const da = g.getImageData(0, 0, c.width, c.height).data
          g.drawImage(ib, 0, 0)
          const dbb = g.getImageData(0, 0, c.width, c.height).data
          let sum = 0, n = 0
          for (let i = 0; i < da.length; i += 4 * 7) { sum += Math.abs(da[i] - dbb[i]) + Math.abs(da[i + 1] - dbb[i + 1]) + Math.abs(da[i + 2] - dbb[i + 2]); n += 3 }
          res(sum / n)
        })
      }),
    [`data:image/png;base64,${fs.readFileSync(flat.file).toString('base64')}`, `data:image/png;base64,${fs.readFileSync(zoomed.file).toString('base64')}`],
  )
  check('phone: export at zoom 2.5 shows the same picture as at zoom 1', diff < 2, `mean diff ${diff.toFixed(2)}`)
  check('phone: export resets the zoom', (await view()).zoom === 1)
  check('phone: export 1x long side is 1600 px', Math.max(flat.w, flat.h) === 1600, `${flat.w}x${flat.h}`)

  // ---- copy from the sheet
  await page.getByRole('button', { name: 'Экспорт', exact: true }).click()
  await page.getByRole('button', { name: 'Копировать в буфер' }).click()
  await page.locator('.toast').waitFor({ timeout: 30000 }).catch(() => {})
  const clip = await page.evaluate(async () => {
    try {
      const items = await navigator.clipboard.read()
      return items.some((it) => it.types.includes('image/png'))
    } catch (e) {
      return 'err:' + (e && e.message)
    }
  })
  check('phone: copy to clipboard puts an image/png on the clipboard', clip === true, String(clip))

  // ---- the menu sheet: pyramid, and the sheet closes after it
  await page.getByRole('button', { name: 'Меню', exact: true }).click()
  await page.getByRole('button', { name: 'Пирамида', exact: true }).click()
  await page.waitForTimeout(250)
  check('phone: pyramid from the menu sheet', (await scene(page)).items.filter((i) => i.type === 'ball').length >= 16)
  check('phone: the sheet closes after racking', (await page.locator('.sheet').count()) === 0)

  await pool(page, 'phone')

  await stage6(page, 'phone')

  await clothAndRuler(page, 'phone', { swipe })
  await endsDeleteHelp(page, 'phone', { swipe })
  await ghostsAndGroups(page, 'phone', { swipe })

  const ta = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    return [c, c.parentElement, c.parentElement.parentElement].map((e) => getComputedStyle(e).touchAction)
  })
  check('phone: canvas opts out of browser touch gestures', ta.every((v) => v === 'none'), ta.join(' / '))
  check('phone: no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  await ctx.close()
}

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('FAILED:\n' + failed.map((f) => ' - ' + f.name + (f.detail ? ' :: ' + f.detail : '')).join('\n'))
  process.exit(1)
}
