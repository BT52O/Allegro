// End-to-end test: runs the real Worker locally (wrangler dev, local R2 + D1) and drives it with Chromium.
// Covers first-time setup, sign-in, MP3 upload with tag reading, streaming, sync between two "devices",
// playlist editing and drag-to-reorder, removal, and that nothing is reachable without signing in.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

const devVars = join(root, '.dev.vars');
const madeDevVars = !existsSync(devVars);
if (madeDevVars) writeFileSync(devVars, `SETUP_CODE=${SETUP_CODE}\nSESSION_SECRET=e2e-only-secret-${Date.now()}\n`);

execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'allegro', '--local', '--persist-to', state], { cwd: root, env, stdio: 'inherit' });
const server = spawn(process.execPath, [wrangler, 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(URL);
  await page.waitForTimeout(800);
  return page;
}
const lib = page => page.evaluate(async () => (await fetch('/api/library')).json());

try {
  await waitForServer();
  const usingOurCode = madeDevVars;

  // --- first-time setup on a desktop browser
  const A = await device({ width: 1440, height: 900 });
  check(await A.isVisible('#gate-code'), 'first visit asks for the setup code');
  if (usingOurCode) {
    await A.fill('#gate-code', 'WRONG-CODE'); await A.fill('#gate-pw', PASSWORD); await A.fill('#gate-pw2', PASSWORD);
    await A.click('#gate-btn'); await A.waitForTimeout(1200);
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
  check(data.songs.some(s => s.title === 'Untagged Song' && s.artist === 'Some Band'), 'untagged file named from "Artist - Title" filename');

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
  await B.fill('#gate-pw', 'not the password'); await B.click('#gate-btn'); await B.waitForTimeout(1200);
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
  check(await A.isVisible('#pl-edit'), 'clicking the playlist title opens Edit details');
  await A.fill('#pe-name', 'Renamed In Test'); await A.fill('#pe-desc', 'From the e2e test');
  await A.click('#pe-save'); await A.waitForTimeout(1200);
  data = await lib(A);
  const pl = data.state.playlists.find(p => p.id === 'pl-example');
  check(pl && pl.name === 'Renamed In Test' && pl.desc === 'From the e2e test', 'playlist name and description save online');
  const before = await A.$$eval('#view .tl .tr', x => x.map(e => e.dataset.id));
  const r0 = await (await A.$('#view .tl .tr >> nth=0')).boundingBox(), r2 = await (await A.$('#view .tl .tr >> nth=2')).boundingBox();
  await A.mouse.move(r0.x + 300, r0.y + r0.height / 2); await A.mouse.down();
  await A.mouse.move(r0.x + 310, r0.y + 30, { steps: 4 }); await A.mouse.move(r2.x + 320, r2.y + r2.height * .8, { steps: 8 });
  await A.mouse.up(); await A.waitForTimeout(1200);
  data = await lib(A);
  const order = data.state.playlists.find(p => p.id === 'pl-example').ids;
  check(order[2] === before[0] && order[0] === before[1], 'dragging a song reorders the playlist and saves', JSON.stringify(order.slice(0, 3)));

  // --- collapsible sidebar
  await A.click('#side-toggle', { force: true }); await A.waitForTimeout(700);
  check(Math.round((await (await A.$('.side')).boundingBox()).width) === 64, 'sidebar collapses');
  await A.click('#side-toggle', { force: true }); await A.waitForTimeout(700);
  check((await (await A.$('.side')).boundingBox()).width > 200, 'sidebar expands again');

  // --- My Library: Custom Sort is listed first, Creator is gone, dragging rearranges and saves
  await A.click('#sl-sort'); await A.waitForTimeout(200);
  const sorts = await A.$$eval('#menu [data-sort-opt] span', x => x.map(e => e.textContent));
  check(sorts[0] === 'Custom Sort' && !sorts.includes('Creator'), 'sort menu starts with Custom Sort, no Creator', JSON.stringify(sorts));
  await A.keyboard.press('Escape');
  const sideKinds = await A.$$eval('#side-list .li', x => x.map(e => e.dataset.open.split(':')[0]));
  check(sideKinds.every(k => k === 'liked' || k === 'playlist') && (await A.textContent('.sl-head h2')) === 'My Playlists' && !(await A.$('[data-sl-chip]')), 'My Playlists shows only Liked Songs and playlists, no filters');
  for (let n = 0; n < 2; n++) {
    await A.evaluate(() => document.querySelector('.nav-btn[data-nav=library]').click()); await A.waitForTimeout(400);
    await A.click('[data-chip="playlists"]'); await A.waitForTimeout(300);
    await A.click('[data-action="new-pl"]'); await A.waitForTimeout(400);
    await A.keyboard.press('Escape'); await A.waitForTimeout(300);
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

  // --- remove a song (the server delete runs after the 8-second undo window)
  await B.reload(); await B.waitForTimeout(1500);
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
  console.error('FAIL  test crashed:', e);
} finally {
  await browser.close();
  server.kill();
  if (madeDevVars) rmSync(devVars, { force: true });
  rmSync(state, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
