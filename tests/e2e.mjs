// End-to-end test: runs the real Worker locally (wrangler dev, local R2 + D1) and drives it with Chromium.
// Covers first-time setup, sign-in, MP3 upload with tag reading, streaming, sync between two "devices",
// playlist editing and drag-to-reorder, removal, and that nothing is reachable without signing in.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'tests', 'fixtures');
const PORT = 8799, URL = `http://127.0.0.1:${PORT}/`;
const SETUP_CODE = 'TEST-CODE-0001', PASSWORD = 'correct horse battery';
const state = mkdtempSync(join(tmpdir(), 'allegro-e2e-'));
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };

let failures = 0;
const gh = (msg) => { if (process.env.GITHUB_ACTIONS) console.log(`::error title=e2e::${String(msg).replace(/\r?\n/g, ' ').slice(0, 900)}`); };
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!ok) { failures++; gh(`FAIL ${label} ${extra}`); } };

const devVars = join(root, '.dev.vars');
const madeDevVars = !existsSync(devVars);
if (madeDevVars) writeFileSync(devVars, `SETUP_CODE=${SETUP_CODE}\nSESSION_SECRET=e2e-only-secret-${Date.now()}\n`);

// A stand-in for Apple's song search, so tests don't depend on the internet.
const MOCK_PORT = 8798, MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const SONGS = [
  { trackName: 'Untagged Song', artistName: 'Some Band', collectionName: 'Mock Album', releaseDate: '2020-05-01T07:00:00Z', primaryGenreName: 'Pop', trackNumber: 3 },
  { trackName: 'Swapped Song', artistName: 'Mock Band', collectionName: 'Swap Album', releaseDate: '2019-01-01T07:00:00Z', primaryGenreName: 'Rock', trackNumber: 1 },
  { trackName: 'Mock Hit', artistName: 'Mock Artist', collectionName: 'Mock Hit Album', releaseDate: '2021-02-02T07:00:00Z', primaryGenreName: 'Pop', trackNumber: 7 }
];
const lookups = [];
const mock = createServer((req, res) => {
  const u = new globalThis.URL(req.url, MOCK);
  if (u.pathname === '/search' && (u.searchParams.get('term') || '').toLowerCase().includes('deezer')) {
    res.writeHead(403); res.end('Forbidden');   // Apple turning the server away
  } else if (u.pathname === '/deezer') {
    const q = (u.searchParams.get('q') || '').toLowerCase();
    const data = q.includes('deezer song') ? [{ title: 'Deezer Song', artist: { name: 'Deezer Band' }, album: { title: 'Deezer Album', cover_xl: `${MOCK}/art/deezer.jpg` }, duration: 6 }] : [];
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data, total: data.length }));
  } else if (u.pathname === '/search') {
    const term = (u.searchParams.get('term') || '').toLowerCase(); lookups.push(term);
    const results = SONGS.filter(x => term.includes(x.trackName.toLowerCase())).map(x => ({ wrapperType: 'track', kind: 'song', ...x, artworkUrl100: `${MOCK}/art/${encodeURIComponent(x.trackName)}/100x100bb.jpg` }));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ resultCount: results.length, results }));
  } else if (u.pathname.startsWith('/art/')) {
    res.writeHead(200, { 'content-type': 'image/png' }); res.end(readFileSync(join(fixtures, 'cover.png')));
  } else { res.writeHead(404); res.end(); }
});
await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'allegro', '--local', '--persist-to', state], { cwd: root, env, stdio: 'inherit' });
const server = spawn(process.execPath, [wrangler, 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state, '--var', `MUSIC_SEARCH_URL:${MOCK}/search`, '--var', `DEEZER_SEARCH_URL:${MOCK}/deezer`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(URL + 'api/session'); if (r.ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start:\n' + serverLog);
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const pageErrors = [];
async function device(viewport) {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com|itunes\.apple\.com/, r => r.abort());
  await page.goto(URL);
  await page.waitForTimeout(800);
  return page;
}
const lib = page => page.evaluate(async () => (await fetch('/api/library')).json());
const shot = async (pg, name) => { if (process.env.SHOTS) await pg.screenshot({ path: join(process.env.SHOTS, name + '.png') }); };

try {
  await waitForServer();
  const usingOurCode = madeDevVars;

  // --- first-time setup on a desktop browser
  const A = await device({ width: 1440, height: 900 });
  check(await A.isVisible('#gate-code'), 'first visit asks for the setup code');
  if (usingOurCode) {
    await A.fill('#gate-code', 'WRONG-CODE'); await A.fill('#gate-pw', PASSWORD); await A.fill('#gate-pw2', PASSWORD);
    await A.click('#gate-btn'); await A.waitForFunction(() => document.getElementById('gate-err').textContent.trim(), null, { timeout: 10000 }).catch(() => {});
    check((await A.textContent('#gate-err')).includes('not right'), 'wrong setup code is rejected');
    await A.fill('#gate-code', SETUP_CODE); await A.click('#gate-btn'); await A.waitForTimeout(1500);
    check(!(await A.isVisible('#gate')), 'setup with the right code signs you in');
  } else {
    console.log('SKIP  setup flow (a local .dev.vars already exists, so the setup code is unknown to the test)');
  }

  // --- upload
  await A.setInputFiles('#file-input', [join(fixtures, 'tagged.mp3'), join(fixtures, 'Some Band - Untagged Song.mp3')]);
  await A.waitForTimeout(4000);
  let data = await lib(A);
  const tagged = data.songs.find(s => s.title === '晴天');
  check(data.songs.length === 2, 'two songs uploaded', `(${data.songs.length})`);
  check(!!tagged && tagged.artist === 'Test Artist' && tagged.album === 'Test Album' && tagged.cover, 'ID3 tags and cover art were read');
  const untagged = data.songs.find(s => s.title === 'Untagged Song' && s.artist === 'Some Band');
  check(!!untagged, 'untagged file named from "Artist - Title" filename');
  check(!!untagged && untagged.album === 'Mock Album' && untagged.year === '2020' && untagged.cover, 'missing album, year and art are looked up online', JSON.stringify(untagged));
  check(!lookups.some(t => t.includes('晴天')), 'fully tagged songs are not looked up');
  check(!(await A.$('#add-btn')) && !(await A.$('.topbar [data-action="add"]')), 'no Add Music button in the top bar');

  // --- streaming with Range
  const range = await A.evaluate(async id => { const r = await fetch('/api/audio/' + id, { headers: { range: 'bytes=0-99' } }); return [r.status, r.headers.get('content-range'), (await r.arrayBuffer()).byteLength]; }, tagged.id);
  check(range[0] === 206 && range[2] === 100, 'audio streams with byte ranges', JSON.stringify(range));

  // --- like a song on desktop
  await A.evaluate(() => document.querySelector('.tab[data-nav=library]').click());
  await A.click('[data-chip="songs"]'); await A.waitForTimeout(300);
  await A.click(`.tr[data-id="${tagged.id}"] [data-like]`, { force: true }); await A.waitForTimeout(1200);
  data = await lib(A);
  check(data.state && data.state.liked.includes(tagged.id), 'liking a song saves online');

  // --- second device: phone, signs in with the password and sees everything
  const B = await device({ width: 390, height: 844 });
  check(await B.isVisible('#gate') && !(await B.isVisible('#gate-code')), 'second device asks for the password only');
  await B.fill('#gate-pw', 'not the password'); await B.click('#gate-btn'); await B.waitForFunction(() => document.getElementById('gate-err').textContent.trim(), null, { timeout: 10000 }).catch(() => {});
  check((await B.textContent('#gate-err')).includes('Wrong password'), 'wrong password is rejected');
  await B.fill('#gate-pw', PASSWORD); await B.click('#gate-btn'); await B.waitForTimeout(2000);
  await B.click('.tab[data-nav=library]'); await B.click('[data-chip="songs"]'); await B.waitForTimeout(400);
  const names = await B.$$eval('.tr .t-name', x => x.map(e => e.textContent));
  check(names.includes('晴天') && names.includes('Untagged Song'), 'songs appear on the second device');
  await B.click(`.tr[data-id="${tagged.id}"]`); await B.waitForTimeout(2000);
  check(await B.evaluate(() => document.body.classList.contains('is-playing')), 'an uploaded song plays on the second device');
  check(await B.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone layout has no sideways scroll');
  await B.click('.tab[data-nav=home]'); await B.waitForTimeout(600);
  check((await B.$$eval('#shelf-history .card-t', x => x.map(e => e.textContent))).includes('Test Album'), 'Track History shows the album you just played');
  await B.click('#shelf-history [data-open="history"]'); await B.waitForTimeout(600);
  check((await B.$$eval('#view .tr .t-name', x => x.map(e => e.textContent)))[0] === '晴天', 'View all lists recently played songs, newest first');
  data = await lib(B);
  check(Array.isArray(data.state.history) && data.state.history[0] && data.state.history[0].id === tagged.id, 'play history saves online');

  // --- playlist: edit details and drag to reorder (desktop)
  await A.click('#side-list [data-open="playlist:pl-example"]'); await A.waitForTimeout(700);
  await A.click('.vhead h1'); await A.waitForTimeout(300);
  const titleOpens = await A.isVisible('#pl-edit');
  await A.click('.vhead .art', { position: { x: 30, y: 120 } }); await A.waitForTimeout(300);
  check(!titleOpens && await A.isVisible('#pl-edit'), 'Edit Details opens from the cover only, not the title');
  await A.fill('#pe-name', 'Renamed In Test'); await A.fill('#pe-desc', 'From the e2e test');
  await A.click('#pe-save'); await A.waitForTimeout(1200);
  data = await lib(A);
  const pl = data.state.playlists.find(p => p.id === 'pl-example');
  check(pl && pl.name === 'Renamed In Test' && pl.desc === 'From the e2e test', 'playlist name and description save online');
  const firstSide = await A.$eval('#side-list .li', e => e.textContent.trim());
  const plCount = (await lib(A)).state.playlists.length;
  await A.click('#side-list .li-create'); await A.waitForTimeout(500);
  const dlg = firstSide === 'Create Playlist' && await A.isVisible('#pl-edit') && (await A.textContent('#pe-title')) === 'Create Playlist' && (await A.textContent('#pe-save')) === 'Create';
  await A.keyboard.press('Escape'); await A.waitForTimeout(800);
  const notYet = (await lib(A)).state.playlists.length === plCount && (await A.$$('#side-list .li[data-open^="playlist:"]')).length === plCount;
  check(dlg && notYet, 'Create Playlist asks first, and closing it creates nothing');
  await A.click('#side-list .li-create'); await A.waitForTimeout(500);
  await A.fill('#pe-name', 'Made In Test');
  await A.click('#pe-save'); await A.waitForTimeout(1200);
  const made = (await lib(A)).state.playlists.some(p => p.name === 'Made In Test'), h1 = await A.textContent('#view h1');
  check(made && h1 === 'Made In Test', 'pressing Create makes the playlist and opens it', JSON.stringify({ made, h1, err: await A.textContent('#pe-err'), open: await A.isVisible('#pl-edit') }));
  await A.evaluate(() => document.querySelector('.nav-btn[data-nav=library]').click()); await A.waitForTimeout(400);
  await A.click('[data-chip="playlists"]'); await A.waitForTimeout(300);
  const noCardPens = !(await A.$('#view .pl-pen')) && !(await A.$('#side-list .pl-pen'));
  await A.click('#side-list [data-open="playlist:pl-example"]'); await A.waitForTimeout(600);
  await A.hover('.vhead .art'); await A.waitForTimeout(300);
  const penVisible = await A.$eval('.vhead .pl-pen', e => getComputedStyle(e).opacity === '1');
  check(noCardPens && penVisible, 'pen shows only on the playlist page cover');
  const chooser = A.waitForEvent('filechooser');
  await A.click('.vhead .pl-pen');
  await (await chooser).setFiles(join(fixtures, 'wide.png')); await A.waitForTimeout(600);
  const cropOpen = await A.isVisible('#cropper');
  const cb = await (await A.$('#crop-box')).boundingBox();
  await A.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2); await A.mouse.down();
  await A.mouse.move(cb.x + cb.width / 2 - 80, cb.y + cb.height / 2, { steps: 6 }); await A.mouse.up();
  await A.$eval('#crop-zoom', el => { el.value = 1.5; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const off = await A.$eval('#crop-img', i => i.style.transform);
  await A.click('#crop-center'); await A.waitForTimeout(400);
  const centered = await A.$eval('#crop-img', i => { const m = i.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/); const V = document.getElementById('crop-box').clientWidth, s = +m[3]; return Math.abs(+m[1] - (V - i.naturalWidth * s) / 2) < 1 && Math.abs(+m[2] - (V - i.naturalHeight * s) / 2) < 1; });
  check(centered && off !== await A.$eval('#crop-img', i => i.style.transform), 'Center Image centers the photo');
  await A.click('#crop-apply'); await A.waitForTimeout(1800);
  check(cropOpen && !(await A.isVisible('#cropper')), 'choosing a photo opens the crop window');
  data = await lib(A);
  const cv = data.state.playlists.find(p => p.id === 'pl-example').cover;
  const dims = cv ? await A.evaluate(c => new Promise(r => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.onerror = () => r(null); i.src = '/api/playlist-cover/pl-example?v=' + c; }), cv) : null;
  check(!!dims && dims[0] === dims[1], 'pen uploads the cropped, square cover', JSON.stringify(dims));
  await A.click('#side-list [data-open="playlist:pl-example"]'); await A.waitForTimeout(600);
  await A.click('.vhead .art', { position: { x: 30, y: 120 } }); await A.waitForTimeout(400);
  const bubbles = await A.$$eval('#pe-actions .pill-btn', x => x.filter(e => e.offsetParent).map(e => e.textContent));
  await A.click('#pe-view');
  const lbOk = await A.waitForFunction(() => { const i = document.getElementById('lightbox-img'); return !document.getElementById('lightbox').hidden && i.complete && i.naturalWidth > 0; }, null, { timeout: 10000 }).then(() => true, () => false);
  await A.keyboard.press('Escape'); await A.waitForTimeout(400);
  const lbClosed = !(await A.isVisible('#lightbox')) && await A.isVisible('#pl-edit');
  await A.keyboard.press('Escape'); await A.waitForTimeout(300);
  check(bubbles.join('|') === 'Remove Photo|View Full Image' && lbOk && lbClosed, 'Edit details has Remove photo and View full image buttons', JSON.stringify(bubbles));
  const before = await A.$$eval('#view .tl .tr', x => x.map(e => e.dataset.id));
  const r0 = await (await A.$('#view .tl .tr >> nth=0')).boundingBox(), r2 = await (await A.$('#view .tl .tr >> nth=2')).boundingBox();
  await A.mouse.move(r0.x + 300, r0.y + r0.height / 2); await A.mouse.down();
  await A.mouse.move(r0.x + 310, r0.y + 30, { steps: 4 }); await A.mouse.move(r2.x + 320, r2.y + r2.height * .8, { steps: 8 });
  await A.mouse.up(); await A.waitForTimeout(1200);
  data = await lib(A);
  const order = data.state.playlists.find(p => p.id === 'pl-example').ids;
  check(order[2] === before[0] && order[0] === before[1], 'dragging a song reorders the playlist and saves', JSON.stringify(order.slice(0, 3)));

  // --- the Add to Playlist submenu stays where the menu opened
  for (const pos of ['first', 'last']) {
    const row = pos === 'first' ? '#view .tl .tr >> nth=0' : '#view .tl .tr >> nth=-1';
    await A.click(`${row} >> .more`, { force: true }); await A.waitForTimeout(250);
    const m1 = await A.$eval('#menu', m => m.getBoundingClientRect().toJSON());
    await A.click('#menu .mi:has-text("Add to Playlist")'); await A.waitForTimeout(250);
    const m2 = await A.$eval('#menu', m => m.getBoundingClientRect().toJSON());
    const same = Math.abs(m1.left - m2.left) < 1 && (Math.abs(m1.top - m2.top) < 1 || Math.abs(m1.bottom - m2.bottom) < 1);
    check(same, `Add to Playlist submenu grows from the same spot (${pos} song)`, JSON.stringify([Math.round(m1.top), Math.round(m1.bottom), Math.round(m2.top), Math.round(m2.bottom)]));
    await A.keyboard.press('Escape'); await A.waitForTimeout(200);
  }

  // --- back and forward go one page only
  await A.click('.nav-btn[data-nav="home"]'); await A.waitForTimeout(400);
  await A.click('.nav-btn[data-nav="search"]'); await A.waitForTimeout(400);
  await A.click('.nav-btn[data-nav="library"]'); await A.waitForTimeout(400);
  await A.click('#nav-back'); await A.waitForTimeout(400);
  const atExplore = (await A.textContent('#view h1')) === 'Explore', backOff = await A.$eval('#nav-back', b => b.disabled);
  await A.click('#nav-fwd'); await A.waitForTimeout(400);
  const atLib = (await A.textContent('#view h1')) === 'My Library', fwdOff = await A.$eval('#nav-fwd', b => b.disabled);
  check(atExplore && backOff && atLib && fwdOff, 'back and forward go one page only');

  // --- collapsible sidebar
  const dragEdge = async toX => {
    const hb = await (await A.$('#side-toggle')).boundingBox(), x = hb.x + hb.width / 2, y = hb.y + hb.height / 2;
    await A.mouse.move(x, y); await A.mouse.down();
    await A.mouse.move(toX, y, { steps: 8 }); await A.mouse.up(); await A.waitForTimeout(700);
  };
  const sideX = (await (await A.$('.side')).boundingBox()).x;
  const w0 = Math.round((await (await A.$('.side')).boundingBox()).width);
  const ic0 = await A.$eval('.nav-btn[data-nav="home"] .ic', e => e.getBoundingClientRect().left);
  await dragEdge(sideX + 60);
  const rail = Math.round((await (await A.$('.side')).boundingBox()).width);
  const ic1 = await A.$eval('.nav-btn[data-nav="home"] .ic', e => e.getBoundingClientRect().left);
  await dragEdge(sideX + 20);
  const stillRail = Math.round((await (await A.$('.side')).boundingBox()).width);
  await dragEdge(sideX + 300);
  const back = Math.round((await (await A.$('.side')).boundingBox()).width);
  check(rail === 64 && stillRail === 64 && back === w0 && Math.abs(ic0 - ic1) < 1, 'dragging the edge switches between full and collapsed only, icons stay put', JSON.stringify([w0, rail, back, Math.round(ic0), Math.round(ic1)]));
  await A.dblclick('#side-toggle'); await A.waitForTimeout(700);
  const dbl = Math.round((await (await A.$('.side')).boundingBox()).width);
  await A.dblclick('#side-toggle'); await A.waitForTimeout(700);
  check(dbl === 64 && Math.round((await (await A.$('.side')).boundingBox()).width) === w0, 'double-clicking the edge collapses and expands it');
  {
    const hb = await (await A.$('#side-toggle')).boundingBox(), y = hb.y + hb.height / 2, sx = hb.x + hb.width / 2;
    const widths = [];
    await A.mouse.move(sx, y); await A.mouse.down();
    for (const x of [sideX + 30, sideX + 300, sideX + 30, sideX + 300]) { await A.mouse.move(x, y, { steps: 6 }); await A.waitForTimeout(600); widths.push(Math.round((await (await A.$('.side')).boundingBox()).width)); }
    await A.mouse.up(); await A.waitForTimeout(500);
    check(widths.join() === [64, w0, 64, w0].join(), 'one drag can collapse and expand back and forth', JSON.stringify(widths));
  }

  // --- My Library: Custom Sort is listed first, Creator is gone, dragging rearranges and saves
  await A.click('#sl-sort'); await A.waitForTimeout(200);
  const sorts = await A.$$eval('#menu [data-sort-opt] span', x => x.map(e => e.textContent));
  check(sorts[0] === 'Custom Sort' && !sorts.includes('Creator'), 'sort menu starts with Custom Sort, no Creator', JSON.stringify(sorts));
  await A.keyboard.press('Escape');
  const sideKinds = await A.$$eval('#side-list .li[data-open]', x => x.map(e => e.dataset.open.split(':')[0]));
  check(sideKinds.every(k => k === 'liked' || k === 'playlist') && (await A.textContent('.sl-head h2')) === 'My Playlists' && !(await A.$('[data-sl-chip]')), 'My Playlists shows only Liked Songs and playlists, no filters');
  for (let n = 0; n < 2; n++) {
    await A.evaluate(() => document.querySelector('.nav-btn[data-nav=library]').click()); await A.waitForTimeout(400);
    await A.click('[data-chip="playlists"]'); await A.waitForTimeout(300);
    await A.click('[data-action="new-pl"]'); await A.waitForTimeout(400);
    await A.click('#pe-save'); await A.waitForTimeout(600);
  }
  const sideBefore = await A.$$eval('#side-list .li[data-drag]', x => x.map(e => e.dataset.open));
  const s0 = await (await A.$('#side-list .li[data-drag] >> nth=0')).boundingBox(), s2 = await (await A.$('#side-list .li[data-drag] >> nth=2')).boundingBox();
  await A.mouse.move(s0.x + 40, s0.y + s0.height / 2); await A.mouse.down();
  await A.mouse.move(s0.x + 45, s0.y + 30, { steps: 4 }); await A.mouse.move(s2.x + 45, s2.y + s2.height * .8, { steps: 8 });
  await A.mouse.up(); await A.waitForTimeout(1200);
  const sideAfter = await A.$$eval('#side-list .li[data-drag]', x => x.map(e => e.dataset.open));
  check(sideAfter[2] === sideBefore[0] && sideAfter[0] === sideBefore[1], 'dragging rearranges My Library');
  data = await lib(A);
  check(Array.isArray(data.state.libOrder) && data.state.libOrder.indexOf(sideBefore[0]) > data.state.libOrder.indexOf(sideBefore[2]), 'custom library order saves online');
  check(await A.textContent('#sl-sort-label') === 'Custom Sort', 'library is on Custom Sort after dragging');

  // --- clicking the page you are already on refreshes it
  await A.click('.nav-btn[data-nav="home"]'); await A.waitForTimeout(500);
  await A.evaluate(() => { window.__marker = document.querySelector('#view h1'); });
  await A.click('.nav-btn[data-nav="home"]'); await A.waitForTimeout(600);
  check(await A.evaluate(() => window.__marker !== document.querySelector('#view h1') && document.querySelector('#view').classList.contains('enter-fwd')), 'clicking the current page refreshes it');
  await A.hover('.logo'); await A.waitForTimeout(300);
  check(await A.$eval('.logo', e => getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)'), 'Allegro logo shows hover on the Home page');

  // --- the search box sits in the top right on every page, next to the profile button
  const boxes = [];
  for (const n of ['home', 'library', 'uploads']) {
    await A.click(`.nav-btn[data-nav="${n}"]`); await A.waitForTimeout(350);
    boxes.push(await A.evaluate(() => { const b = document.getElementById('search-box').getBoundingClientRect(), a = document.getElementById('acct-btn').getBoundingClientRect(); return b.width > 200 && b.height > 0 && b.right <= a.left && a.left - b.right < 20; }));
  }
  await A.fill('#search-input', 'Some');
  await A.waitForTimeout(500);
  const searched = await A.evaluate(() => [...document.querySelectorAll('#view .t-name')].map(e => e.textContent));
  check(boxes.every(Boolean) && searched.includes('Untagged Song'), 'search box is in the top right on every page, and typing shows results', JSON.stringify({ boxes, searched }));
  await shot(A, 'search-top');
  await A.click('.nav-btn[data-nav="home"]'); await A.waitForTimeout(400);
  check(await A.inputValue('#search-input') === '', 'leaving the results clears the search box');

  // --- Uploads: storage notice, editing only here, and lookups
  await A.click('.nav-btn[data-nav="library"]'); await A.waitForTimeout(400);
  await A.click('[data-chip="songs"]'); await A.waitForTimeout(300);
  const editInSongs = await A.$$eval('#view [data-edit-song]', x => x.length);
  const noChip = !(await A.$('[data-chip="uploads"]'));
  await A.click('.nav-btn[data-nav="uploads"]'); await A.waitForTimeout(400);
  check(noChip && (await A.textContent('#view h1')) === 'Uploads' && await A.$eval('.nav-btn[data-nav="uploads"]', b => b.classList.contains('active')), 'Uploads is its own page in the menu, under My Library');
  const note = await A.$eval('.storage-note', e => [e.textContent, getComputedStyle(e).backgroundColor, getComputedStyle(e).color]).catch(() => null);
  check(!!note && note[0].includes('10 GB') && note[0].includes('left') && note[1] === 'rgb(253, 228, 228)' && note[2] === 'rgb(138, 20, 20)', 'Uploads shows the storage notice in dark red on light red', JSON.stringify(note));
  await shot(A, 'uploads');
  const upRows = await A.$$eval('#view .tr', x => x.map(e => e.dataset.id));
  check(upRows.length === 2 && editInSongs === 0 && (await A.$$eval('#view [data-edit-song]', x => x.length)) === 2, 'Uploads lists your songs, and only there can you edit them', JSON.stringify([upRows.length, editInSongs]));
  // upload a "Title - Artist" file from the Uploads button: the order gets worked out
  const swapped = join(state, 'Swapped Song - Mock Band (Official Audio).mp3');
  copyFileSync(join(fixtures, 'Some Band - Untagged Song.mp3'), swapped);
  await A.click('#view [data-action="add"]'); await A.waitForTimeout(250);
  const upChooser = A.waitForEvent('filechooser');
  await A.click('#menu .mi:has-text("Choose Audio Files")');
  await (await upChooser).setFiles(swapped);
  await A.waitForFunction(() => document.querySelectorAll('#view .tr').length === 3, null, { timeout: 15000 }).catch(() => {});
  data = await lib(A);
  const sw = data.songs.find(s => s.fileName && s.fileName.startsWith('Swapped Song'));
  check(!!sw && sw.title === 'Swapped Song' && sw.artist === 'Mock Band' && sw.album === 'Swap Album' && sw.cover, '"Title - Artist" file names are recognized and filled in', JSON.stringify(sw));
  // edit a song by hand: name, artist, album and a cropped photo
  await A.click(`#view [data-edit-song="${tagged.id}"]`); await A.waitForTimeout(400);
  const seOpen = await A.isVisible('#song-edit');
  await A.fill('#se-name', 'Sunny Day'); await A.fill('#se-artist', 'Edited Artist'); await A.fill('#se-album', 'Edited Album');
  const artChooser = A.waitForEvent('filechooser');
  await A.click('#se-cover');
  await (await artChooser).setFiles(join(fixtures, 'wide.png')); await A.waitForTimeout(600);
  await A.click('#crop-apply'); await A.waitForTimeout(600);
  await A.click('#se-save');
  await A.waitForFunction(() => document.getElementById('song-edit').hidden, null, { timeout: 10000 }).catch(() => {});
  data = await lib(A);
  const ed = data.songs.find(s => s.id === tagged.id);
  const edImg = await A.$eval(`#view [data-edit-song="${tagged.id}"] img`, i => i.getAttribute('src')).catch(() => '');
  const edDims = await A.evaluate(src => new Promise(r => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.onerror = () => r(null); i.src = src; }), edImg);
  check(seOpen && ed.title === 'Sunny Day' && ed.artist === 'Edited Artist' && ed.album === 'Edited Album' && ed.coverV > 0 && edImg.includes('?v=') && !!edDims && edDims[0] === edDims[1], 'editing a song saves its name, artist, album and new square art', JSON.stringify({ ed, edImg, edDims }));
  // Find Info Online in the editor fills everything in from the pick
  await A.click(`#view [data-edit-song="${tagged.id}"]`); await A.waitForTimeout(400);
  await A.fill('#se-name', 'Nightcore - Mock Hit (Official Audio)'); await A.fill('#se-artist', '');
  await A.click('#se-search');
  await A.waitForSelector('#se-results .se-hit', { timeout: 10000 }).catch(() => {});
  await shot(A, 'editor-search');
  await A.click('#se-results .se-hit >> nth=0').catch(() => {});
  await shot(A, 'editor-filled');
  const filled = [await A.inputValue('#se-name'), await A.inputValue('#se-artist'), await A.inputValue('#se-album')];
  await A.click('#se-save');
  await A.waitForFunction(() => document.getElementById('song-edit').hidden, null, { timeout: 10000 }).catch(() => {});
  data = await lib(A);
  const hit = data.songs.find(s => s.id === tagged.id);
  check(filled.join('|') === 'Mock Hit|Mock Artist|Mock Hit Album' && hit.album === 'Mock Hit Album' && hit.year === '2021' && hit.coverV > ed.coverV, 'Find Info Online fills in the song from the search', JSON.stringify({ filled, hit }));
  // when Apple turns the server away, Deezer still answers
  const dz = await A.evaluate(async () => (await fetch('/api/lookup?term=deezer%20song')).json());
  const dzHit = dz.results && dz.results.find(r => r.title === 'Deezer Song');
  const dzArt = dzHit ? await A.evaluate(async u => (await fetch('/api/art?url=' + encodeURIComponent(u))).status, dzHit.art) : 0;
  check(!!dzHit && dzHit.artist === 'Deezer Band' && dzHit.album === 'Deezer Album' && /403/.test(dz.sources.apple) && dzArt === 200, 'song search falls back to Deezer when Apple refuses', JSON.stringify({ dz, dzArt }));
  // the menu offers Edit Song in Uploads but not elsewhere
  await A.click(`#view .tr[data-id="${tagged.id}"] .more`, { force: true }); await A.waitForTimeout(250);
  const upMenu = await A.$$eval('#menu .mi', x => x.map(e => e.textContent.trim()));
  await A.keyboard.press('Escape');
  await A.click('.nav-btn[data-nav="library"]'); await A.waitForTimeout(400);
  await A.click('[data-chip="songs"]'); await A.waitForTimeout(300);
  await A.click(`#view .tr[data-id="${tagged.id}"] .more`, { force: true }); await A.waitForTimeout(250);
  const songsMenu = await A.$$eval('#menu .mi', x => x.map(e => e.textContent.trim()));
  await A.keyboard.press('Escape');
  check(upMenu.includes('Edit Song') && !songsMenu.includes('Edit Song'), 'Edit Song is in the menu only in Uploads');
  // Find Missing Info repairs older uploads
  await A.evaluate(async id => {
    const s = (await (await fetch('/api/library')).json()).songs.find(x => x.id === id);
    await fetch('/api/songs/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...s, album: 'Unknown album', cover: false }) });
  }, untagged.id);
  await A.reload(); await A.waitForTimeout(1500);
  await A.click('.nav-btn[data-nav="uploads"]'); await A.waitForTimeout(400);
  await shot(A, 'uploads-missing');
  const fillBtn = await A.isVisible('#view [data-action="fill-info"]');
  await A.click('#view [data-action="fill-info"]').catch(() => {});
  await A.waitForFunction(() => !document.querySelector('#view [data-action="fill-info"]'), null, { timeout: 15000 }).catch(() => {});
  data = await lib(A);
  const fixedSong = data.songs.find(s => s.id === untagged.id);
  check(fillBtn && fixedSong.album === 'Mock Album' && fixedSong.cover, 'Find Missing Info fills in older uploads', JSON.stringify(fixedSong));

  // --- remove a song (the server delete runs after the 8-second undo window)
  await B.reload(); await B.waitForTimeout(1500);
  await B.click('.tab[data-nav=uploads]'); await B.waitForTimeout(500);
  await shot(B, 'phone-uploads');
  check((await B.textContent('#view h1')) === 'Uploads' && await B.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone has an Uploads tab that fits the screen');
  await B.click('.tab[data-nav=library]'); await B.click('[data-chip="songs"]'); await B.waitForTimeout(400);
  const victim = (await lib(B)).songs.find(s => s.title === 'Untagged Song').id;
  await B.click(`.tr[data-id="${victim}"] .more`, { force: true }); await B.waitForTimeout(300);
  await B.click('.mi.danger'); await B.waitForTimeout(9500);
  check(!(await lib(B)).songs.some(s => s.id === victim), 'removing a song deletes it online');

  // --- nothing is reachable without a session
  const anon = await (await browser.newContext()).newPage();
  check((await anon.goto(URL + 'api/library')).status() === 401, 'library needs sign-in');
  check((await anon.goto(URL + 'api/audio/' + tagged.id)).status() === 401, 'song files need sign-in');
  check((await anon.goto(URL + 'api/playlist-cover/pl-example')).status() === 401, 'playlist covers need sign-in');

  check(pageErrors.length === 0, 'no JavaScript errors', pageErrors.join(' | '));
} catch (e) {
  failures++;
  console.error('FAIL  test crashed:', e && e.stack);
  gh(`test crashed: ${e && e.message}`);
} finally {
  await browser.close();
  server.kill(); mock.close();
  if (madeDevVars) rmSync(devVars, { force: true });
  rmSync(state, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
