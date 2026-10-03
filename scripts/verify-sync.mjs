/**
 * Acceptance for stage 6: the server, the sync between devices, and offline.
 *
 * Every check here is one line of the brief's table, run against the real
 * functions (scripts/api-server.mjs serves the shipped .mts modules) and the
 * real built app. Two "devices" are two browser contexts, which is exactly
 * what they are to the server: separate storage, separate device id, the same
 * library.
 *
 *   node --import ./scripts/blobs-register.mjs scripts/api-server.mjs &
 *   npm run build && npx vite preview --port 4180 &
 *   PORT=4180 node scripts/verify-sync.mjs
 *
 * It is a separate file from verify-browser.mjs because these scenarios are
 * not about a screen size: they need several contexts, a server that can be
 * reset, and a clock that can be pushed a month forward. The per-screen
 * checks of the library interface live in verify-browser.mjs and run on all
 * three viewports.
 */

import { chromium } from 'playwright'

const PORT = process.env.PORT || '4180'
const API = process.env.API_BASE || 'http://127.0.0.1:4181'
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
}

const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
)

const post = (p) => fetch(`${API}${p}`, { method: 'POST' }).then((r) => r.json())
const resetServer = () => post('/__test/reset')
const runDaily = () => post('/__test/daily')
/** make a key invisible to list(), the way a lagging listing does on Netlify */
const hideFromList = (key) => post(`/__test/hide?key=${encodeURIComponent(key)}`)
/** make every list() answer "empty", the way the live site did */
const blindList = () => post('/__test/blind')
/** remove one key, to reproduce a store whose catalogue was lost */
const dropKey = (key) => post(`/__test/drop?key=${encodeURIComponent(key)}`)
/** refuse every conditional write, as a platform without if-match would */
const noConditionalWrites = () => post('/__test/no-cas')
const showAll = () => post('/__test/show')

/* ------------------------------------------------------------- a device */

/** a browser context is a device: its own IndexedDB, its own device id */
async function device(name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  await page.goto(`http://localhost:${PORT}/?debug=1`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__library?.getState().ready === true, null, { timeout: 20000 })
  return { name, ctx, page, errors }
}

const lib = (d) => d.page.evaluate(() => {
  const s = window.__library.getState()
  return {
    ready: s.ready,
    sync: s.sync,
    currentId: s.currentId,
    editorDirty: s.editorDirty,
    uploaded: s.uploaded,
    lastConflict: s.lastConflict,
    items: s.items.map((m) => ({
      id: m.id, rev: m.rev, title: m.title, dirty: m.dirty,
      deletedAt: m.deletedAt, itemCount: m.itemCount,
    })),
  }
})

/** make a fresh exercise with a title and a few balls, and commit it */
async function draw(d, title, balls = 2) {
  await d.page.evaluate(async (t) => {
    await window.__library.getState().createNew()
    const st = window.__store.getState()
    st.setTitle(t)
    return t
  }, title)
  await d.page.evaluate((n) => {
    const st = window.__store.getState()
    for (let i = 0; i < n; i++) st.addBall('white', { x: 700 + i * 250, y: 700 })
  }, balls)
  await d.page.evaluate(() => window.__library.getState().commitNow())
}

/**
 * Push and pull until everything this device holds is on the server.
 *
 * It waits for an exchange that STARTS after this call: a device that is
 * already 'synced' would otherwise satisfy the condition instantly and the
 * test would go on to assert things about data that has not arrived yet.
 */
async function sync(d, timeout = 20000) {
  const from = await d.page.evaluate(() => {
    window.__sync()
    return window.__syncCycles()
  })
  await d.page.waitForFunction(
    (n) => {
      const s = window.__library.getState()
      return window.__syncCycles() > n && s.sync === 'synced' && s.items.every((m) => m.dirty === 0)
    },
    from,
    { timeout },
  )
}

/** wait until a record matching the predicate is here, syncing as needed */
async function waitUntil(d, fnBody, timeout = 30000) {
  await d.page.evaluate(() => window.__sync())
  await d.page.waitForFunction(fnBody, null, { timeout })
}

/** pull only: wait until the named exercise is here */
async function waitFor(d, title, timeout = 20000) {
  await d.page.evaluate(() => window.__sync())
  await d.page.waitForFunction(
    (t) => window.__library.getState().items.some((m) => m.title === t && m.deletedAt === null),
    title,
    { timeout },
  )
}

/* ------------------------------------------------------ 1. two devices */

async function twoDevices() {
  await resetServer()
  const a = await device('A')
  const b = await device('B')

  await draw(a, 'Выход на свояка')
  await sync(a)
  const serverList = await fetch(`${API}/api/exercises?since=0`).then((r) => r.json())
  check('two devices: the exercise reaches the server', serverList.items.length === 1 && serverList.items[0].title === 'Выход на свояка', JSON.stringify(serverList.items.map((i) => i.title)))

  await waitFor(b, 'Выход на свояка').catch(() => {})
  const lb = await lib(b)
  const got = lb.items.find((m) => m.title === 'Выход на свояка')
  check('two devices: it appears on the second device', Boolean(got), JSON.stringify(lb.items.map((i) => i.title)))
  check('two devices: the drawing came with it', got?.itemCount === 2, `items ${got?.itemCount}`)

  const sceneB = await b.page.evaluate(async (id) => {
    await window.__library.getState().open(id)
    return window.__store.getState().scene.items.length
  }, got.id)
  check('two devices: the second device can open it', sceneB === 2, `${sceneB} objects`)

  // the thumbnail is captured on A's canvas, uploaded with the write, and
  // fetched by B: the whole path, end to end
  await a.page.evaluate(() => window.__library.getState().commitNow(true))
  await sync(a, 30000)
  const onServer = await fetch(`${API}/api/exercises?since=0`).then((r) => r.json())
  check('two devices: the thumbnail is on the server', onServer.items[0]?.previewAt > 0, `previewAt ${onServer.items[0]?.previewAt}`)
  await sync(b, 30000)
  await b.page.getByRole('button', { name: /Библиотека/ }).click()
  await b.page.locator('.lib-card').first().waitFor({ timeout: 20000 })
  const shown = await b.page
    .locator('img.lib-card__thumb')
    .first()
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  check('two devices: the second device shows the thumbnail', shown)
  await b.page.locator('.library').getByRole('button', { name: 'Закрыть' }).click()

  // the brief is explicit: no authorisation, no login, no passwords
  const body = await a.page.locator('body').innerText()
  const noLogin =
    (await a.page.locator('input[type=password]').count()) === 0 &&
    !/пароль|войти|вход в|регистраци/i.test(body)
  check('two devices: nothing anywhere asks the coach to log in', noLogin)

  await a.ctx.close()
  await b.ctx.close()
}

/* -------------------------------------------------------- 2. a conflict */

async function conflict() {
  await resetServer()
  const a = await device('A')
  const b = await device('B')

  await draw(a, 'Дуплет в угол')
  await sync(a)
  await waitFor(b, 'Дуплет в угол')
  await sync(b)

  const id = (await lib(a)).items[0].id

  // both go offline and both edit the same exercise
  await a.ctx.setOffline(true)
  await b.ctx.setOffline(true)
  for (const [d, n] of [[a, 3], [b, 5]]) {
    await d.page.evaluate(async (exId) => {
      await window.__library.getState().open(exId)
    }, id)
    await d.page.evaluate((count) => {
      const st = window.__store.getState()
      for (let i = 0; i < count; i++) st.addBall('cue', { x: 1500 + i * 200, y: 1200 })
    }, n)
    await d.page.evaluate(() => window.__library.getState().commitNow())
  }

  // B's edit is the later one, so A is the device that finds the conflict
  await b.ctx.setOffline(false)
  await sync(b)
  await a.ctx.setOffline(false)
  await sync(a, 30000)

  const la = await lib(a)
  const alive = la.items.filter((m) => m.deletedAt === null)
  check('conflict: the losing version is kept as a second exercise', alive.length === 2, JSON.stringify(alive.map((m) => m.title)))
  check('conflict: the copy is named so the coach can find it', alive.some((m) => m.title.startsWith('конфликт: ')), JSON.stringify(alive.map((m) => m.title)))
  const counts = alive.map((m) => m.itemCount).sort((x, y) => x - y)
  check('conflict: neither version lost its objects', counts.join(',') === '5,7', `object counts ${counts.join(',')}`)

  // B has the title already, so waiting for it would prove nothing: what has
  // to arrive is the copy A made of B's losing version
  await waitUntil(b, () =>
    window.__library.getState().items.some((m) => m.title.startsWith('конфликт: ')),
  )
  await sync(b, 30000)
  const lb = await lib(b)
  const bAlive = lb.items.filter((m) => m.deletedAt === null)
  check('conflict: both devices end up with both versions', bAlive.length === 2, JSON.stringify(bAlive.map((m) => m.title)))
  check('conflict: and they agree on which is which', JSON.stringify(bAlive.map((m) => m.itemCount).sort()) === JSON.stringify(alive.map((m) => m.itemCount).sort()))

  await a.ctx.close()
  await b.ctx.close()
}

/* -------------------------------------------------------- 3. a deletion */

async function deletion() {
  await resetServer()
  const a = await device('A')
  const b = await device('B')

  await draw(a, 'Абриколь')
  await sync(a)
  await waitFor(b, 'Абриколь')
  await sync(b)

  const id = (await lib(a)).items.find((m) => m.title === 'Абриколь').id
  await a.page.evaluate((exId) => window.__library.getState().remove(exId), id)
  await sync(a)

  await b.page.evaluate(() => window.__sync())
  await b.page.waitForFunction(
    (exId) => {
      const m = window.__library.getState().items.find((x) => x.id === exId)
      return m && m.deletedAt !== null
    },
    id,
    { timeout: 20000 },
  )
  let lb = await lib(b)
  check('deletion: the second device sees it deleted', lb.items.find((m) => m.id === id)?.deletedAt !== null)
  check('deletion: it is in the trash, not gone', lb.items.some((m) => m.id === id))

  // the classic resurrection: B syncs again, and again, with it still cached
  for (let i = 0; i < 3; i++) await sync(b)
  await sync(a)
  lb = await lib(b)
  const la = await lib(a)
  check('deletion: it does not come back on the second device', lb.items.find((m) => m.id === id)?.deletedAt !== null)
  check('deletion: it does not come back on the first either', la.items.find((m) => m.id === id)?.deletedAt !== null)

  // the trash restores it, and the restore travels
  await a.page.evaluate((exId) => window.__library.getState().restore(exId), id)
  await sync(a)
  await b.page.evaluate(() => window.__sync())
  await b.page.waitForFunction(
    (exId) => window.__library.getState().items.find((x) => x.id === exId)?.deletedAt === null,
    id,
    { timeout: 20000 },
  )
  check('deletion: restoring from the trash reaches the other device', (await lib(b)).items.find((m) => m.id === id)?.deletedAt === null)

  await a.ctx.close()
  await b.ctx.close()
}

/* ----------------------------------------------------------- 4. offline */

async function offline() {
  await resetServer()
  const a = await device('A')

  // the service worker has to be in place before the network goes away
  await a.page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 20000 })
  await draw(a, 'До обрыва')
  await sync(a)

  await a.ctx.setOffline(true)
  // the reload itself may report a failure; what matters is what renders
  await a.page.reload({ waitUntil: 'load' }).catch(() => {})
  const opened = await a.page
    .waitForFunction(() => window.__library?.getState().ready === true, null, { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  check('offline: the app opens with the network off', opened)
  check('offline: the canvas is there', (await a.page.locator('canvas').count()) > 0)
  const kept = await lib(a)
  check('offline: the library is still readable', kept.items.some((m) => m.title === 'До обрыва'))

  await draw(a, 'Нарисовано без сети')
  await a.page.evaluate(() => window.__sync())
  await a.page.waitForFunction(() => window.__library.getState().sync === 'offline', null, { timeout: 20000 })
  const off = await lib(a)
  check('offline: the header says there is no connection', off.sync === 'offline')
  check('offline: the new exercise is saved locally', off.items.some((m) => m.title === 'Нарисовано без сети'))
  check('offline: and marked as not sent', off.items.find((m) => m.title === 'Нарисовано без сети')?.dirty === 1)

  await a.ctx.setOffline(false)
  await sync(a, 30000)
  const server = await fetch(`${API}/api/exercises?since=0`).then((r) => r.json())
  const names = server.items.map((i) => i.title)
  check('offline: it goes up when the network returns', names.includes('Нарисовано без сети'), JSON.stringify(names))
  check('offline: the header says synchronised again', (await lib(a)).sync === 'synced')
  // reloading between a save and the next change must not clone the exercise
  check('offline: the reload did not duplicate anything', new Set(names).size === names.length && names.length === 2, JSON.stringify(names))

  await a.ctx.close()
}

/* -------------------------------- 5. a library from before the server */

async function migration() {
  await resetServer()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  // a device that has been running a build from before this stage: one scene
  // under the old key, no database at all. Seeded before the app boots, so
  // there is no window where the app has already written its own state.
  await ctx.addInitScript(() => {
    const KEY = 'biliardconf.scene.v1'
    if (window.localStorage.getItem(KEY)) return
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        table: { lengthMm: 3556, widthMm: 1778, ballMm: 68, markings: true, cloth: 'blue' },
        title: 'Старое упражнение',
        items: [
          { id: 'b1', type: 'ball', x: 900, y: 800, kind: 'white' },
          { id: 'b2', type: 'ball', x: 1400, y: 900, kind: 'cue' },
        ],
      }),
    )
  })
  const page = await ctx.newPage()
  await page.goto(`http://localhost:${PORT}/?debug=1`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__library?.getState().ready === true, null, { timeout: 20000 })

  const d = { name: 'M', ctx, page, errors: [] }
  const after = await lib(d)
  check('migration: the old scene became a library exercise', after.items.some((m) => m.title === 'Старое упражнение'), JSON.stringify(after.items.map((i) => i.title)))
  const legacyKept = await page.evaluate(() => window.localStorage.getItem('biliardconf.scene.v1.migrated') !== null)
  check('migration: the old key is copied aside, not deleted', legacyKept)

  await sync(d, 30000)
  const server = await fetch(`${API}/api/exercises?since=0`).then((r) => r.json())
  check('migration: the whole local library is on the server', server.items.filter((m) => m.deletedAt === null).length === after.items.filter((m) => m.deletedAt === null).length, `server ${server.items.length}, device ${after.items.length}`)
  const reported = (await lib(d)).uploaded
  check('migration: the coach is told how many moved', typeof reported === 'number' && reported >= 1, `uploaded ${reported}`)

  // a second boot must not adopt it twice
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => window.__library?.getState().ready === true, null, { timeout: 20000 })
  const twice = (await lib(d)).items.filter((m) => m.title === 'Старое упражнение' && m.deletedAt === null)
  check('migration: a second boot does not make a twin', twice.length === 1, `${twice.length} copies`)

  await ctx.close()
}

/* --------------------------------------------------------- 6. snapshots */

async function snapshots() {
  await resetServer()
  const a = await device('A')

  await draw(a, 'Было так', 2)
  await sync(a)
  const id = (await lib(a)).items.find((m) => m.title === 'Было так').id

  await runDaily()
  const days = await fetch(`${API}/api/snapshots`).then((r) => r.json())
  check('snapshot: a daily snapshot exists', Array.isArray(days.days) && days.days.length === 1, JSON.stringify(days.days))
  const day = days.days[0]
  const body = await fetch(`${API}/api/snapshots/${day}`).then((r) => r.json())
  check('snapshot: it holds the whole library', body.records.length === 1 && body.records[0].scene.items.length === 2)

  // the library moves on: the exercise is changed and another is deleted
  await a.page.evaluate(async (exId) => {
    await window.__library.getState().open(exId)
    const st = window.__store.getState()
    st.setTitle('Стало иначе')
    for (let i = 0; i < 4; i++) st.addBall('cue', { x: 1800 + i * 150, y: 1300 })
    await window.__library.getState().commitNow()
  }, id)
  await sync(a)
  check('snapshot: the library changed after it was taken', (await lib(a)).items.find((m) => m.id === id).itemCount === 6)

  // restore through the interface, which is what the brief asks for
  const L = a.page.locator('.library')
  await a.page.getByRole('button', { name: /Библиотека/ }).click()
  await L.waitFor({ timeout: 20000 })
  await L.getByRole('tab', { name: /Снимки/ }).click()
  await L.getByRole('button', { name: day, exact: true }).click()
  await a.page.waitForSelector('.snap__head', { timeout: 20000 })
  a.page.once('dialog', (dlg) => dlg.accept())
  await L.getByRole('button', { name: 'Восстановить всё' }).click()
  // any note, not the first: when the boot's first exchange happens to carry
  // this exercise up, «Перенесено на сервер» stands above it, and rightly so
  await a.page.waitForFunction(
    () => [...document.querySelectorAll('.library__note')].some((n) => n.textContent?.includes('Восстановлено')),
    null,
    { timeout: 20000 },
  )
  const note = await a.page.locator('.library__note').last().textContent()
  check('snapshot: restoring reports what it did', /Восстановлено: 1/.test(note ?? ''), note ?? '')

  const back = await lib(a)
  const now = back.items.find((m) => m.id === id)
  check('snapshot: the exercise is back as it was that day', now.itemCount === 2 && now.title === 'Было так', `${now.title}, ${now.itemCount} objects`)
  check('snapshot: the version it replaced is kept as a copy', back.items.some((m) => m.title.startsWith('копия перед восстановлением')), JSON.stringify(back.items.map((m) => m.title)))

  await L.getByRole('button', { name: 'Закрыть' }).click()
  await sync(a, 30000)
  const server = await fetch(`${API}/api/exercises?since=0`).then((r) => r.json())
  const serverNow = server.items.find((m) => m.id === id)
  check('snapshot: the restore reached the server too', serverNow?.title === 'Было так', serverNow?.title)
  check('snapshot: no error on the page', a.errors.length === 0, a.errors.slice(0, 2).join(' | '))

  await a.ctx.close()
}

/* -------------------------------------------------- 7. the server is out */

async function serverDown() {
  await resetServer()
  const a = await device('A')
  await draw(a, 'Пока сервер жив')
  await sync(a)

  // not the same as offline: the network is up and the server answers 500
  await a.page.route('**/api/**', (route) => route.fulfill({ status: 500, body: '{"error":"boom"}' }))
  await draw(a, 'Когда сервер лёг')
  await a.page.evaluate(() => window.__sync())
  await a.page.waitForFunction(() => window.__library.getState().sync === 'offline', null, { timeout: 20000 })
  const st = await lib(a)
  check('write error: the coach is told there is no connection', st.sync === 'offline')
  check('write error: the work is saved locally anyway', st.items.some((m) => m.title === 'Когда сервер лёг' && m.dirty === 1))

  // and it keeps working: another exercise is drawn while the server is out
  await draw(a, 'И ещё одно')
  const st2 = await lib(a)
  check('write error: the editor keeps working', st2.items.filter((m) => m.deletedAt === null).length === 3)

  await a.page.unroute('**/api/**')
  await sync(a, 30000)
  const server = await fetch(`${API}/api/exercises?since=0`).then((r) => r.json())
  const titles = server.items.map((m) => m.title)
  check('write error: nothing was lost once the server came back', ['Пока сервер жив', 'Когда сервер лёг', 'И ещё одно'].every((t) => titles.includes(t)), JSON.stringify(titles))

  await a.ctx.close()
}

/* ------------------------------------------- 8. a lost answer, and volume */

async function lostAnswer() {
  await resetServer()
  const a = await device('A')
  await draw(a, 'Ответ потерялся')

  // the write lands, the answer never arrives: the classic way a client ends
  // up forking a conflict copy of its own work
  let dropped = 0
  await a.page.route('**/api/exercises/ex-*', async (route) => {
    if (route.request().method() !== 'PUT' || dropped > 0) return route.continue()
    dropped++
    const res = await route.fetch()
    await res.body()
    await route.abort('connectionreset')
  })
  await a.page.evaluate(() => window.__sync())
  await a.page.waitForTimeout(1500)
  await a.page.unroute('**/api/exercises/ex-*')
  await sync(a, 30000)

  const st = await lib(a)
  const alive = st.items.filter((m) => m.deletedAt === null)
  check('lost answer: the write is not repeated as a conflict copy', alive.length === 1, JSON.stringify(alive.map((m) => m.title)))
  check('lost answer: the device knows it is synchronised', st.sync === 'synced' && alive[0].dirty === 0)
  check('lost answer: the server holds exactly one copy', (await fetch(`${API}/api/exercises?since=0`).then((r) => r.json())).items.length === 1)

  await a.ctx.close()
}

async function volume() {
  await resetServer()
  const a = await device('A')

  // a hundred exercises, written straight to the server, then pulled down
  for (let i = 0; i < 100; i++) {
    const id = `ex-${(Date.now() + i).toString(36)}-${i.toString(16).padStart(12, '0')}`
    await fetch(`${API}/api/exercises/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRev: 0,
        clientUpdatedAt: Date.now() + i,
        deviceId: 'dev-000000000000',
        writeId: `seed${i.toString(16).padStart(12, '0')}`,
        title: `Упражнение ${i + 1}`,
        scene: {
          version: 1,
          table: { lengthMm: 3556, widthMm: 1778, ballMm: 68, markings: true, cloth: 'blue' },
          items: Array.from({ length: 8 }, (_, k) => ({ id: `b${k}`, type: 'ball', x: 600 + k * 120, y: 700, kind: 'white' })),
        },
      }),
    })
  }
  check('volume: a hundred exercises are on the server', (await fetch(`${API}/api/exercises?since=0`).then((r) => r.json())).items.length === 100)

  await a.page.evaluate(() => window.__sync())
  await a.page.waitForFunction(() => window.__library.getState().items.length >= 100, null, { timeout: 120000 })

  // the measurement that matters: from the click to a list on screen
  const t0 = Date.now()
  await a.page.getByRole('button', { name: /Библиотека/ }).click()
  await a.page.waitForFunction(() => document.querySelectorAll('.lib-card').length >= 100, null, { timeout: 20000 })
  const took = Date.now() - t0
  check('volume: the list of a hundred opens in under a second', took < 1000, `${took} ms`)
  check('volume: every exercise is in the list', (await a.page.locator('.lib-card').count()) >= 100)

  await a.ctx.close()
}

/* -------------------------- 9. a listing that lags, and one that lies */

/**
 * A marker that shows up late in a listing.
 *
 * Netlify Blobs answers list() with eventual consistency: a marker can take up
 * to a minute to appear even when reading the blob itself is strongly
 * consistent. The change feed used to be built from that listing, so a cursor
 * that only moved forward had a hole in it - it advanced past the late
 * marker's timestamp, and when the marker finally appeared it was already
 * older than the cursor and was skipped for good.
 *
 * The feed is a keyed read of the catalogue now, so a lagging listing cannot
 * hide anything from it. This scenario therefore asserts the opposite of what
 * it once did: the marker is invisible to list() throughout, and the exercise
 * still arrives, immediately.
 */
async function lateMarker() {
  await resetServer()
  const a = await device('A')
  const b = await device('B')

  await draw(a, 'Написано первым')
  await sync(a)
  const id = (await lib(a)).items[0].id

  // as far as any listing is concerned, A's marker is still propagating
  await hideFromList(id)

  await draw(b, 'Написано вторым')
  await sync(b)
  const seen = (await lib(b)).items.map((m) => m.title)
  check('lagging listing: the exercise arrives all the same', seen.includes('Написано первым'), JSON.stringify(seen))

  await sync(a)
  const back = (await lib(a)).items.map((m) => m.title)
  check('lagging listing: nothing of the second device was lost', back.includes('Написано вторым'), JSON.stringify(back))

  await showAll()
  await a.ctx.close()
  await b.ctx.close()
}

/**
 * A listing that lies: answers "nothing here" for a store holding everything.
 *
 * This is what the live site did. Writes returned 200, keyed reads returned
 * the bodies, the probe key that /api/health writes and reads back worked -
 * and every listing, of every prefix, reported an empty store. The coach saved
 * on the phone and on the computer and neither device ever saw the other's
 * work; the export handed back a file with zero records; the nightly snapshot
 * would have photographed nothing.
 *
 * So: list() answers empty for everything, from the first request, and the
 * whole product is required to work anyway. Nothing that enumerates may ask
 * it.
 */
async function blindListing() {
  await resetServer()
  await blindList()
  const a = await device('A')
  const b = await device('B')

  await draw(a, 'Слепой список: с компьютера')
  await sync(a)
  await waitFor(b, 'Слепой список: с компьютера', 30000)
  check('blind listing: the second device sees what the first saved', true)

  await draw(b, 'Слепой список: с телефона')
  await sync(b)
  await waitFor(a, 'Слепой список: с телефона', 30000)
  check('blind listing: and the first sees what the second saved', true)

  const feed = await fetch(`${API}/api/exercises?since=0`).then((r) => r.json())
  check('blind listing: the feed answers with both', feed.items.filter((m) => m.deletedAt === null).length === 2, `${feed.items.length} rows`)

  const backup = await fetch(`${API}/api/backup`).then((r) => r.json())
  check('blind listing: the export is not empty', backup.count === 2 && backup.records.length === 2, `count ${backup.count}, ${backup.records.length} records`)

  await runDaily()
  const days = await fetch(`${API}/api/snapshots`).then((r) => r.json())
  const body = days.days?.length ? await fetch(`${API}/api/snapshots/${days.days[0]}`).then((r) => r.json()) : { records: [] }
  check('blind listing: the nightly snapshot photographs the library', body.records.length === 2, `${body.records.length} records in ${JSON.stringify(days.days)}`)

  await showAll()
  await a.ctx.close()
  await b.ctx.close()
}

/**
 * The state the live site was actually left in: every exercise present under
 * its own key, and nothing on the server that can enumerate them.
 *
 * A device that was never there - a phone opened in a private window - has no
 * ids to offer and must see an empty library, because from the server's side
 * that is all there is to know. The device that holds the exercises knows
 * their ids, offers them on its first exchange, and the catalogue is rebuilt
 * from the bodies that were there all along. Then the phone sees them.
 *
 * Nothing is created from an offered id: an id with no body behind it is
 * ignored, so this door cannot resurrect a swept exercise or invent one.
 */
async function lostCatalogue() {
  await resetServer()
  const a = await device('A')

  await draw(a, 'Было на сервере раньше')
  await draw(a, 'И это тоже')
  await sync(a)
  const ids = (await lib(a)).items.map((m) => m.id)

  // the catalogue is gone; the exercises are not
  await dropKey('catalog')
  const empty = await fetch(`${API}/api/exercises?since=0`).then((r) => r.json())
  check('lost catalogue: the server now enumerates nothing', empty.items.length === 0, `${empty.items.length} rows`)
  const stillThere = await fetch(`${API}/api/exercises/${ids[0]}`).then((r) => r.status)
  check('lost catalogue: the exercise itself is still readable by key', stillThere === 200, `status ${stillThere}`)

  // a device that has never seen the library cannot heal it and must not pretend
  const fresh = await device('C')
  await sync(fresh)
  check('lost catalogue: a new device sees nothing, and says so honestly', (await lib(fresh)).items.length === 0)

  // the device that HAS them offers its ids on its first exchange after a start
  await a.page.reload({ waitUntil: 'load' })
  await a.page.waitForFunction(() => window.__library?.getState().ready === true, null, { timeout: 20000 })
  await sync(a, 30000)
  const healed = await fetch(`${API}/api/exercises?since=0`).then((r) => r.json())
  check('lost catalogue: the device that holds them puts them back', healed.items.length === 2, `${healed.items.length} rows`)

  await waitFor(fresh, 'Было на сервере раньше', 30000)
  const onFresh = (await lib(fresh)).items.map((m) => m.title)
  check('lost catalogue: and the new device finally receives the library', onFresh.includes('И это тоже'), JSON.stringify(onFresh))

  // an id nobody has a body for is not a way to invent an exercise
  const invented = await fetch(`${API}/api/exercises?since=0`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['ex-zzzzzz-0123456789ab'] }),
  }).then((r) => r.json())
  check('lost catalogue: an offered id with no body behind it is ignored', invented.items.length === 2 && invented.restored === 0, `${invented.items.length} rows, restored ${invented.restored}`)

  await a.ctx.close()
  await fresh.ctx.close()
}

/**
 * A platform that does not honour conditional writes.
 *
 * The catalogue is one blob two devices write, and it is kept safe by a
 * compare-and-swap against the ETag. Whether the live platform honours
 * `if-match` is now measured by /api/health rather than assumed - but the
 * measurement is no use if the answer "no" means the coach cannot save.
 *
 * So: every conditional write is refused, and saving must still work. The
 * protection given up is the one the heal path restores anyway.
 */
async function withoutConditionalWrites() {
  await resetServer()
  await noConditionalWrites()
  const a = await device('A')
  const b = await device('B')

  await draw(a, 'Без условной записи')
  await sync(a, 30000)
  const onServer = await fetch(`${API}/api/exercises?since=0`).then((r) => r.json())
  check('no conditional writes: the exercise still reaches the server', onServer.items.length === 1, `${onServer.items.length} rows`)

  await waitFor(b, 'Без условной записи', 30000)
  check('no conditional writes: and the other device still receives it', true)

  await draw(b, 'И второе тоже')
  await sync(b, 30000)
  await waitFor(a, 'И второе тоже', 30000)
  const both = (await lib(a)).items.filter((m) => m.deletedAt === null).map((m) => m.title)
  check('no conditional writes: neither exercise was lost', both.length === 2, JSON.stringify(both))

  await showAll()
  await a.ctx.close()
  await b.ctx.close()
}

/**
 * A pool exercise travels like any other.
 *
 * The server never looks inside a scene, so this is about the two ends: the
 * table's game and every ball's number have to survive the write on one
 * device and the read on the other, not just the local autosave.
 */
async function poolTravels() {
  await resetServer()
  const a = await device('A')
  const b = await device('B')

  await a.page.evaluate(async () => {
    await window.__library.getState().createNew()
    const st = window.__store.getState()
    st.setGame('pool')
    st.setTitle('Девятка с разбоя')
    st.rackPool(9)
    await window.__library.getState().commitNow()
  })
  await sync(a)
  await waitFor(b, 'Девятка с разбоя', 30000)
  const got = await b.page.evaluate(async () => {
    const lib = window.__library.getState()
    const id = lib.items.find((m) => m.title === 'Девятка с разбоя').id
    await lib.open(id)
    const sc = window.__store.getState().scene
    return {
      game: sc.table.game,
      length: sc.table.lengthMm,
      numbers: sc.items.filter((i) => i.type === 'ball' && i.kind !== 'cue').map((i) => i.number).sort((x, y) => x - y).join(','),
      cue: sc.items.filter((i) => i.type === 'ball' && i.kind === 'cue').length,
    }
  })
  check('pool: the other device opens it on a pool table', got.game === 'pool' && got.length === 2540, JSON.stringify(got))
  check('pool: with every ball numbered as it was racked', got.numbers === '1,2,3,4,5,6,7,8,9' && got.cue === 1, got.numbers)

  await a.ctx.close()
  await b.ctx.close()
}

/* -------------------------------------------------------------- the run */

await twoDevices()
await conflict()
await deletion()
await offline()
await migration()
await snapshots()
await serverDown()
await lostAnswer()
await lateMarker()
await blindListing()
await lostCatalogue()
await withoutConditionalWrites()
await poolTravels()
await volume()

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('FAILED:\n' + failed.map((f) => ' - ' + f.name + (f.detail ? ' :: ' + f.detail : '')).join('\n'))
  process.exit(1)
}
