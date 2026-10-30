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
const lookups = [], transcribed = [];
const mock = createServer((req, res) => {
  const u = new globalThis.URL(req.url, MOCK);
  if (u.pathname === '/search' && (u.searchParams.get('term') || '').toLowerCase().includes('deezer')) {
    res.writeHead(403); res.end('Forbidden');   // Apple turning the server away
  } else if (u.pathname.startsWith('/lrclib/')) {
    const name = (u.searchParams.get('track_name') || '').toLowerCase();
    const hit = name.includes('mock hit') ? { trackName: 'Mock Hit', artistName: 'Mock Artist', duration: 8, instrumental: false, plainLyrics: 'First line',
      syncedLyrics: '[00:00.20]Mock Artist: First line\n[00:01.60]Second line\n[00:03.00]Guest Singer: Third line by the guest\n[00:04.40]Guest Singer: Fourth line\n[00:05.80]Together: Both sing' } : null;
    res.writeHead(hit || u.pathname.endsWith('/search') ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(u.pathname.endsWith('/search') ? (hit ? [hit] : []) : (hit || { message: 'not found' })));
  } else if (u.pathname === '/transcribe') {
    // a stand-in for Whisper: it "hears" three lines at set times
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
      try { const b = JSON.parse(body); transcribed.push({ lang: b.language || '', prompt: b.initial_prompt || '', bytes: (b.audio || '').length }); } catch (e) {}
      const w = (word, start) => ({ word, start, end: start + .3 });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ transcription_info: { text: 'hello there second line third line' }, segments: [
        { start: .5, end: 1.2, text: ' Hello there', words: [w(' Hello', .5), w(' there', .9)] },
        { start: 2, end: 2.7, text: ' Second line', words: [w(' Second', 2), w(' line', 2.4)] },
        { start: 3.6, end: 4.3, text: ' Third line', words: [w(' Third', 3.6), w(' line', 4)] }] }));
    });
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

// Workers AI only runs on Cloudflare, so tests use a copy of the config without it and a stand-in for Whisper.
const testConfig = join(root, '.wrangler-test.jsonc');
writeFileSync(testConfig, readFileSync(join(root, 'wrangler.jsonc'), 'utf8').replace(/^\s*"ai":.*\n/m, ''));
execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'allegro', '--local', '--config', testConfig, '--persist-to', state], { cwd: root, env, stdio: 'inherit' });
const server = spawn(process.execPath, [wrangler, 'dev', '--config', testConfig, '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state, '--var', `TRANSCRIBE_URL:${MOCK}/transcribe`, '--var', `MUSIC_SEARCH_URL:${MOCK}/search`, '--var', `DEEZER_SEARCH_URL:${MOCK}/deezer`, '--var', 'HISTORY_MERGE_MS:0', '--var', `LYRICS_URL:${MOCK}/lrclib`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // phone Now Playing: cover across the top, fading into a deep color from the art, white text
  await B.click('#p-cover'); await B.waitForTimeout(1200);
  const npv = await B.evaluate(() => { const sh = document.getElementById('sheet'), art = document.querySelector('.s-art').getBoundingClientRect(); return [getComputedStyle(sh).backgroundImage, getComputedStyle(document.getElementById('s-title')).color, Math.round(art.width), innerWidth, Math.round(art.top), sh.style.getPropertyValue('--deep')]; });
  await shot(B, 'phone-now-playing');
  await B.click('.sheet-top [data-act="sheet"]'); await B.waitForTimeout(400);
  check(npv[1] === 'rgb(255, 255, 255)' && npv[2] === npv[3] && npv[4] === 0 && !!npv[5] && npv[0].includes(`rgb(${npv[5].trim().split(' ').join(', ')})`), 'phone Now Playing: cover edge to edge on top, deep color from the art, white text', JSON.stringify(npv));
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
  await A.click('#side-list .li-create'); await A.waitForTimeout(300);
  const createOpts = await A.$$eval('#menu .mi', x => x.map(e => e.textContent.trim()));
  await A.click('#menu .mi:has-text("Playlist")'); await A.waitForTimeout(500);
  const dlg = firstSide === 'Create' && createOpts.join('|') === 'Playlist|Folder' && await A.isVisible('#pl-edit') && (await A.textContent('#pe-title')) === 'Create Playlist' && (await A.textContent('#pe-save')) === 'Create';
  await A.keyboard.press('Escape'); await A.waitForTimeout(800);
  const notYet = (await lib(A)).state.playlists.length === plCount && (await A.$$('#side-list .li[data-open^="playlist:"]')).length === plCount;
  check(dlg && notYet, 'Create Playlist asks first, and closing it creates nothing');
  await A.click('#side-list .li-create'); await A.waitForTimeout(300);
  await A.click('#menu .mi:has-text("Playlist")'); await A.waitForTimeout(500);
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
  const plLayout = await A.evaluate(() => { const art = document.querySelector('.pl-head .art').getBoundingClientRect(), h = document.querySelector('.pl-head h1').getBoundingClientRect(), list = document.querySelector('.pl-main').getBoundingClientRect();
    return [h.top > art.bottom, list.left > art.right, [...document.querySelectorAll('.pl-btns button span')].map(e => e.textContent).join('|'), [...document.querySelectorAll('.pl-icons .pl-ic span')].map(e => e.textContent).join('|'), getComputedStyle(document.querySelector('.pl-head')).position]; });
  await shot(A, 'playlist-layout');
  check(plLayout[0] && plLayout[1] && plLayout[2] === 'Play|Shuffle' && plLayout[3] === 'Edit|Add|History|More' && plLayout[4] === 'sticky', 'playlist page: cover, title, Play/Shuffle and buttons on the left, songs on the right', JSON.stringify(plLayout));
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

  // --- page breaks: + > Add a Page Break, after a chosen song, numbering restarts; rename; + > Add a Song
  await A.click('#side-list [data-open="playlist:pl-example"]'); await A.waitForTimeout(500);
  const plRows = await A.$$eval('#view .tl .tr', x => x.map(e => e.dataset.id));
  await A.click('.actions [data-pl-add]'); await A.waitForTimeout(250);
  const addOpts = await A.$$eval('#menu .mi', x => x.map(e => e.textContent.trim()));
  await A.click('#menu .mi:has-text("Add a Page Break")'); await A.waitForTimeout(400);
  const bkDefault = await A.inputValue('#bk-name');
  await A.selectOption('#bk-after', plRows[2]);
  await A.click('#bk-save'); await A.waitForTimeout(700);
  data = await lib(A);
  let plx = data.state.playlists.find(p => p.id === 'pl-example');
  const at = plx.ids.indexOf(plRows[2]), marker = plx.ids[at + 1] || '';
  const nums = await A.$$eval('#view .tl .tr .num', x => x.map(e => e.textContent));
  const bkHead = await A.$$eval('#view .pl-break h3', x => x.map(e => e.textContent));
  check((await A.$$eval('#view .tl-head', x => x.length)) === 1, 'with page breaks, the column header row shows only once, at the top');
  check(addOpts.join('|') === 'Add a Song|Add a Page Break' && bkDefault === 'Volume 2' && marker.startsWith('brk:') && bkHead.join() === 'Volume 2' && nums[2] === '3' && nums[3] === '1', 'a page break goes after the chosen song, is named, and numbering starts over', JSON.stringify({ addOpts, bkDefault, marker, bkHead, nums }));
  await A.hover('#view .pl-break'); await A.click('#view .pl-break [data-break-more]'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("Rename or Move")'); await A.waitForTimeout(400);
  await A.fill('#bk-name', 'Disc Two'); await A.selectOption('#bk-after', plRows[0]); await A.click('#bk-save'); await A.waitForTimeout(700);
  data = await lib(A); plx = data.state.playlists.find(p => p.id === 'pl-example');
  check(plx.breaks[marker.slice(4)] === 'Disc Two' && plx.ids.indexOf(marker) === plx.ids.indexOf(plRows[0]) + 1 && (await A.textContent('#view .pl-break h3')) === 'Disc Two', 'a page break can be renamed and moved');
  await shot(A, 'page-break');
  await A.click('.actions [data-pl-add]'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("Add a Song")'); await A.waitForTimeout(400);
  await A.fill('#sp-q', 'Untagged'); await A.waitForTimeout(200);
  const spRows = await A.$$eval('#sp-list .sp-row b', x => x.map(e => e.textContent));
  const untaggedId = (await lib(A)).songs.find(x => x.title === 'Untagged Song').id;
  const already = plx.ids.includes(untaggedId);
  if (!already) await A.click('#sp-list [data-sp-add]');
  await A.waitForTimeout(200);
  const addedLabel = await A.textContent('#sp-list [data-sp-add]');
  await A.click('#sp-done'); await A.waitForTimeout(600);
  data = await lib(A); plx = data.state.playlists.find(p => p.id === 'pl-example');
  check(spRows.join() === 'Untagged Song' && addedLabel === 'Added' && plx.ids.includes(untaggedId) && !!(await A.$(`#view .tl .tr[data-id="${untaggedId}"]`)), 'Add a Song finds songs and adds them to the playlist', JSON.stringify({ spRows, addedLabel, already }));
  await A.hover('#view .pl-break'); await A.click('#view .pl-break [data-break-more]'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("Remove Page Break")'); await A.waitForTimeout(600);
  data = await lib(A); plx = data.state.playlists.find(p => p.id === 'pl-example');
  check(!plx.ids.some(x => x.startsWith('brk:')) && !(await A.$('#view .pl-break')), 'a page break can be removed');

  // --- folders: Create > Folder, name it, move a playlist in, and the folder page shows its playlists
  const foldersBefore = ((await lib(A)).state.folders || []).length;
  await A.click('#side-list .li-create'); await A.waitForTimeout(300);
  await A.click('#menu .mi:has-text("Folder")'); await A.waitForTimeout(500);
  const fdDlg = await A.isVisible('#fd-edit') && (await A.textContent('#fd-title')) === 'Create Folder' && (await A.textContent('#fd-save')) === 'Create';
  await A.keyboard.press('Escape'); await A.waitForTimeout(800);
  const fdNotYet = ((await lib(A)).state.folders || []).length === foldersBefore && !(await A.$('#side-list .li[data-open^="folder:"]'));
  check(fdDlg && fdNotYet, 'Create Folder asks first, and closing it creates nothing');
  await A.click('#side-list .li-create'); await A.waitForTimeout(300);
  await A.click('#menu .mi:has-text("Folder")'); await A.waitForTimeout(500);
  const renaming = await A.evaluate(() => document.activeElement && document.activeElement.id === 'fd-name');
  await A.fill('#fd-name', '华语'); await A.keyboard.press('Enter'); await A.waitForTimeout(800);
  data = await lib(A);
  const fd = (data.state.folders || []).find(f => f.name === '华语');
  const fdSide = fd && await A.$eval(`#side-list .li[data-open="folder:${fd.id}"]`, e => [!!e.querySelector('.folder-art .ic'), e.textContent.includes('华语')]).catch(() => null);
  const sideNow = await A.$$eval('#side-list .li[data-open]', x => x.map(e => e.dataset.open));
  check(sideNow[0] === 'liked' && sideNow[1] === 'folder:' + (fd && fd.id), 'a new folder goes right under Liked Songs', JSON.stringify(sideNow.slice(0, 3)));
  check(renaming && !!fd && fdSide && fdSide[0] && fdSide[1], 'Create > Folder makes a named folder with a plain folder icon', JSON.stringify({ renaming, fd, fdSide }));
  const madeId = data.state.playlists.find(p => p.name === 'Made In Test').id;
  // drag the playlist onto the folder in the sidebar
  {
    const src = await (await A.$(`#side-list [data-open="playlist:${madeId}"]`)).boundingBox(), dst = await (await A.$(`#side-list [data-open="folder:${fd.id}"]`)).boundingBox();
    await A.mouse.move(src.x + 40, src.y + src.height / 2); await A.mouse.down();
    await A.mouse.move(src.x + 45, src.y + src.height / 2 + 12, { steps: 4 });
    await A.mouse.move(dst.x + 60, dst.y + dst.height / 2, { steps: 10 }); await A.waitForTimeout(150);
    const lit = await A.$eval(`#side-list [data-open="folder:${fd.id}"]`, e => e.classList.contains('drop-into'));
    await A.mouse.up(); await A.waitForTimeout(800);
    data = await lib(A);
    check(lit && ((data.state.folders.find(f => f.id === fd.id) || {}).ids || []).includes(madeId), 'dragging a playlist onto a folder puts it inside', JSON.stringify({ lit }));
  }
  data = await lib(A);
  const inFolder = (data.state.folders.find(f => f.id === fd.id) || {}).ids || [];
  const goneFromSide = !(await A.$(`#side-list [data-open="playlist:${madeId}"]`));
  await A.click(`#side-list [data-open="folder:${fd.id}"]`); await A.waitForTimeout(600);
  await shot(A, 'folder-page');
  const fdPage = [await A.textContent('#view h1'), await A.$$eval('#view .card .card-t', x => x.map(e => e.textContent)), await A.$$eval('#view input', x => x.length)];
  check(inFolder.includes(madeId) && goneFromSide && fdPage[0] === '华语' && fdPage[1].includes('Made In Test') && fdPage[2] === 0, 'moving a playlist into a folder files it there; the folder page shows its playlists, no search box', JSON.stringify({ inFolder, goneFromSide, fdPage }));
  // rearrange playlists inside the folder by dragging: put pl-example in too, then drag it in front
  await A.click('#side-list [data-open="playlist:pl-example"]'); await A.waitForTimeout(500);
  await A.click('.actions [data-ctx-more]'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("Move to Folder")'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("华语")'); await A.waitForTimeout(600);
  await A.click(`#side-list [data-open="folder:${fd.id}"]`); await A.waitForTimeout(600);
  await A.mouse.move(5, 5); await A.hover(`#side-list [data-open="folder:${fd.id}"]`); await A.waitForTimeout(600);
  const peek = await A.evaluate(() => { const p = document.getElementById('folder-pop'); return p && !p.hidden ? [p.querySelector('.fp-head b').textContent, [...p.querySelectorAll('.fp-row .fp-t b')].map(e => e.textContent)] : null; });
  await shot(A, 'folder-peek');
  {
    const rows = await A.$$('#folder-pop .fp-row'), r0 = await rows[0].boundingBox(), r1 = await rows[1].boundingBox();
    const before = await A.$$eval('#folder-pop .fp-row', x => x.map(e => e.dataset.open));
    await A.mouse.move(r1.x + 60, r1.y + r1.height / 2); await A.mouse.down();
    await A.mouse.move(r1.x + 62, r1.y + r1.height / 2 - 10, { steps: 3 }); await A.mouse.move(r0.x + 60, r0.y + 6, { steps: 8 });
    await A.mouse.up(); await A.waitForTimeout(700);
    const after = await A.$$eval('#folder-pop .fp-row', x => x.map(e => e.dataset.open));
    const savedFd = ((await lib(A)).state.folders.find(f => f.id === fd.id) || {}).ids || [];
    check(after[0] === before[1] && after[1] === before[0] && savedFd[0] === before[1].slice(9) && await A.isVisible('#folder-pop'), 'playlists can be dragged to rearrange inside the folder preview', JSON.stringify({ before, after, savedFd }));
    // put them back the way they were for the tests that follow
    const s0 = await (await A.$$('#folder-pop .fp-row'))[1].boundingBox(), s1 = await (await A.$$('#folder-pop .fp-row'))[0].boundingBox();
    await A.mouse.move(s0.x + 60, s0.y + s0.height / 2); await A.mouse.down();
    await A.mouse.move(s0.x + 62, s0.y + s0.height / 2 - 10, { steps: 3 }); await A.mouse.move(s1.x + 60, s1.y + 6, { steps: 8 });
    await A.mouse.up(); await A.waitForTimeout(700);
  }
  await A.mouse.move(700, 400); await A.waitForTimeout(500);
  const peekGone = await A.evaluate(() => document.getElementById('folder-pop').hidden);
  check(!!peek && peek[0] === '华语' && peek[1].includes('Made In Test') && peek[1].includes('Renamed In Test') && peekGone, 'hovering a folder shows the playlists inside it', JSON.stringify(peek));
  const cardsPerRow = await A.$$eval('#view .folder-cards .card', x => { const t = x[0].getBoundingClientRect().top; return x.filter(e => Math.abs(e.getBoundingClientRect().top - t) < 2).length; });
  const fdOrder0 = await A.$$eval('#view .folder-cards .card', x => x.map(e => e.dataset.open));
  {
    const c1 = await (await A.$('#view .folder-cards .card >> nth=1')).boundingBox(), c0 = await (await A.$('#view .folder-cards .card >> nth=0')).boundingBox();
    await A.mouse.move(c1.x + c1.width / 2, c1.y + 60); await A.mouse.down();
    await A.mouse.move(c1.x + c1.width / 2 - 20, c1.y + 60, { steps: 4 });
    await A.mouse.move(c0.x + 20, c0.y + 60, { steps: 10 }); await A.mouse.up(); await A.waitForTimeout(800);
  }
  const fdOrder1 = await A.$$eval('#view .folder-cards .card', x => x.map(e => e.dataset.open));
  data = await lib(A);
  const savedOrder = (data.state.folders.find(f => f.id === fd.id) || {}).ids || [];
  check(fdOrder0.length === 2 && fdOrder1[0] === fdOrder0[1] && fdOrder1[1] === fdOrder0[0] && savedOrder[0] === fdOrder0[1].slice(9) && (await A.textContent('#view h1')) === '华语', 'dragging playlists on a folder page rearranges them and saves', JSON.stringify({ fdOrder0, fdOrder1, savedOrder }));
  // drag a card from the folder page to another folder in the sidebar, then back out into My Playlists
  const dragCard = async (sel, tx, ty) => {
    const c = await (await A.$(sel)).boundingBox();
    await A.mouse.move(c.x + c.width / 2, c.y + 60); await A.mouse.down();
    await A.mouse.move(c.x + c.width / 2 - 20, c.y + 60, { steps: 4 });
    await A.mouse.move(tx, ty, { steps: 12 }); await A.waitForTimeout(150);
    await A.mouse.up(); await A.waitForTimeout(800);
  };
  await A.click('#side-list .li-create'); await A.waitForTimeout(300);
  await A.click('#menu .mi:has-text("Folder")'); await A.waitForTimeout(400);
  await A.fill('#fd-name', 'Other Folder'); await A.keyboard.press('Enter'); await A.waitForTimeout(800);
  const other = (await lib(A)).state.folders.find(f => f.name === 'Other Folder');
  await A.mouse.move(5, 5); await A.hover(`#side-list [data-open="folder:${fd.id}"]`); await A.waitForTimeout(600);
  await A.hover(`#side-list [data-open="folder:${other.id}"]`); await A.waitForTimeout(90);
  const mid = await A.evaluate(() => { const p = document.getElementById('folder-pop'); return [p.classList.contains('moving'), !!p.querySelector('.fp-body.swap'), p.querySelector('.fp-head b').textContent]; });
  await A.waitForTimeout(400);
  await A.mouse.move(700, 600); await A.waitForTimeout(700);
  const closedPop = await A.evaluate(() => document.getElementById('folder-pop').hidden);
  check(mid[0] && mid[1] && mid[2] === 'Other Folder' && closedPop, 'moving between folders animates the preview over, and it fades away when you leave', JSON.stringify(mid));
  await A.click(`#side-list [data-open="folder:${fd.id}"]`); await A.waitForTimeout(600);
  {
    const t = await (await A.$(`#side-list [data-open="folder:${other.id}"]`)).boundingBox();
    await dragCard('#view .folder-cards .card[data-open="playlist:pl-example"]', t.x + 80, t.y + t.height / 2);
  }
  data = await lib(A);
  const movedOver = data.state.folders.find(f => f.id === other.id).ids.includes('pl-example') && !data.state.folders.find(f => f.id === fd.id).ids.includes('pl-example');
  {
    const last = await (await A.$('#side-list .li[data-drag] >> nth=-1')).boundingBox();
    await dragCard(`#view .folder-cards .card[data-open="playlist:${madeId}"]`, last.x + 80, last.y + last.height + 6);
  }
  data = await lib(A);
  const outNow = !data.state.folders.some(f => f.ids.includes(madeId)) && !!(await A.$(`#side-list [data-open="playlist:${madeId}"]`));
  check(movedOver && outNow, 'folder cards drag onto another folder, or back out into My Playlists', JSON.stringify({ movedOver, outNow }));
  // folders inside folders: + > New Folder Here, + > Add Playlists, a path back up, delete moves things up a level
  await A.click(`#side-list [data-open="folder:${fd.id}"]`); await A.waitForTimeout(500);
  await A.click('.folder-head [data-folder-add]'); await A.waitForTimeout(250);
  const fAddOpts = await A.$$eval('#menu .mi', x => x.map(e => e.textContent.trim()));
  await A.click('#menu .mi:has-text("New Folder Here")'); await A.waitForTimeout(400);
  await A.fill('#fd-name', 'Sub Folder'); await A.keyboard.press('Enter'); await A.waitForTimeout(800);
  data = await lib(A);
  const sub = data.state.folders.find(f => f.name === 'Sub Folder');
  const nestedOk = !!sub && data.state.folders.find(f => f.id === fd.id).ids.includes(sub.id) && !(await A.$(`#side-list [data-open="folder:${sub.id}"]`));
  const pathTxt = await A.textContent('.fd-path').catch(() => '');
  await A.click('.folder-head [data-folder-add]'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("Add Playlists")'); await A.waitForTimeout(400);
  await A.fill('#fk-q', 'Renamed'); await A.waitForTimeout(200);
  const pickLabel = await A.textContent('#fk-list [data-fk-add="pl-example"]').catch(() => '');
  await A.click('#fk-list [data-fk-add="pl-example"]'); await A.waitForTimeout(300);
  const pickedLabel = await A.textContent('#fk-list [data-fk-add="pl-example"]').catch(() => '');
  await A.click('#fk-done'); await A.waitForTimeout(600);
  data = await lib(A);
  const subNow = data.state.folders.find(f => f.id === sub.id), otherNow = data.state.folders.find(f => f.id === other.id);
  const subCards = await A.$$eval('#view .folder-cards .card', x => x.map(e => e.dataset.open));
  await shot(A, 'nested-folder');
  check(fAddOpts.join('|') === 'Add Playlists|New Folder Here' && nestedOk && pathTxt.includes('华语'), 'a folder can hold folders, with a path back up', JSON.stringify({ fAddOpts, nestedOk, pathTxt }));
  check(pickLabel === 'Move Here' && pickedLabel === 'Added' && subNow.ids.includes('pl-example') && !otherNow.ids.includes('pl-example') && subCards.includes('playlist:pl-example'), 'the folder + button picks playlists to put inside', JSON.stringify({ pickLabel, pickedLabel, subNow }));
  // the preview of a folder opens a preview of each folder inside it, beside it
  await A.mouse.move(5, 5); await A.hover(`#side-list [data-open="folder:${fd.id}"]`); await A.waitForTimeout(600);
  await A.hover(`#folder-pop .fp-row[data-open="folder:${sub.id}"]`); await A.waitForTimeout(500);
  const nest = await A.evaluate(() => { const p = [...document.querySelectorAll('.folder-pop.sub')].find(x => !x.hidden); return p ? [p.querySelector('.fp-head b').textContent, [...p.querySelectorAll('.fp-row')].map(r => r.dataset.open), Math.round(p.getBoundingClientRect().left - document.getElementById('folder-pop').getBoundingClientRect().right)] : null; });
  await shot(A, 'nested-peek');
  await A.mouse.move(1000, 720); await A.waitForTimeout(600);
  const nestGone = await A.evaluate(() => [...document.querySelectorAll('.folder-pop')].every(x => x.hidden));
  check(!!nest && nest[0] === 'Sub Folder' && nest[1].includes('playlist:pl-example') && nest[2] >= 0 && nestGone, 'hovering a folder inside a folder preview opens its own preview beside it', JSON.stringify({ nest, nestGone }));
  await A.click('.fd-path .link'); await A.waitForTimeout(500);
  const parentCards = await A.$$eval('#view .folder-cards .card', x => x.map(e => e.dataset.open));
  // on a folder page, drop a playlist card onto a folder card to put it inside
  await A.click('.folder-head [data-folder-add]'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("Add Playlists")'); await A.waitForTimeout(400);
  await A.click(`#fk-list [data-fk-add="${madeId}"]`); await A.waitForTimeout(300);
  await A.click('#fk-done'); await A.waitForTimeout(600);
  {
    const c = await (await A.$(`#view .folder-cards .card[data-open="playlist:${madeId}"]`)).boundingBox(), t = await (await A.$(`#view .folder-cards .card[data-open="folder:${sub.id}"]`)).boundingBox();
    await A.mouse.move(c.x + c.width / 2, c.y + 60); await A.mouse.down();
    await A.mouse.move(c.x + c.width / 2 - 20, c.y + 60, { steps: 4 });
    await A.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 12 }); await A.waitForTimeout(150);
    const lit = await A.$eval(`#view .folder-cards .card[data-open="folder:${sub.id}"]`, e => e.classList.contains('drop-into'));
    await A.mouse.up(); await A.waitForTimeout(800);
    data = await lib(A);
    check(lit && data.state.folders.find(f => f.id === sub.id).ids.includes(madeId) && !data.state.folders.find(f => f.id === fd.id).ids.includes(madeId), 'on a folder page, dropping a playlist on a folder card puts it inside', JSON.stringify({ lit }));
  }
  await A.click(`#view .card[data-open="folder:${sub.id}"]`); await A.waitForTimeout(500);
  await A.click('.folder-head [data-folder-more]'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("Delete Folder")'); await A.waitForTimeout(700);
  data = await lib(A);
  check(parentCards.includes('folder:' + sub.id) && data.state.folders.find(f => f.id === fd.id).ids.includes('pl-example') && (await A.textContent('#view h1')) === '华语', 'deleting a folder inside a folder moves what it held up a level', JSON.stringify(parentCards));
  await A.click(`#side-list [data-open="folder:${other.id}"]`); await A.waitForTimeout(500);
  await A.click('.folder-head [data-folder-more]'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("Delete Folder")'); await A.waitForTimeout(600);
  await A.click(`#side-list [data-open="folder:${fd.id}"]`); await A.waitForTimeout(500);
  await A.click('.folder-head [data-folder-more]'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("Delete Folder")'); await A.waitForTimeout(600);
  await A.click('#side-list [data-open="playlist:pl-example"]'); await A.waitForTimeout(500);
  await A.click('#side-list [data-open="playlist:' + madeId + '"]'); await A.waitForTimeout(500);
  check(cardsPerRow >= 1, 'folder page shows its playlists as cards', String(cardsPerRow));
  // a fresh folder for the remove-from-folder check
  await A.click('.actions [data-ctx-more]'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("Move to Folder")'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("New Folder")'); await A.waitForTimeout(400);
  await A.fill('#fd-name', 'Second Folder'); await A.keyboard.press('Enter'); await A.waitForTimeout(800);
  await A.click(`#view .card[data-open="playlist:${madeId}"]`); await A.waitForTimeout(500);
  await A.click('.actions [data-ctx-more]'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("Move to Folder")'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("Remove from Folder")'); await A.waitForTimeout(600);
  check(!!(await A.$(`#side-list [data-open="playlist:${madeId}"]`)), 'a playlist can be taken back out of its folder');
  await A.click(`#side-list [data-open="playlist:pl-example"]`); await A.waitForTimeout(600);

  // --- the Add to Playlist submenu stays where the menu opened
  for (const pos of ['first', 'last']) {
    const row = pos === 'first' ? '#view .tl .tr >> nth=0' : '#view .tl .tr >> nth=-1';
    await A.click(`${row} >> .more`, { force: true }); await A.waitForTimeout(250);
    await shot(A, 'submenu-' + pos);
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
  check(sideKinds.every(k => k === 'liked' || k === 'playlist' || k === 'folder') && (await A.textContent('.sl-head h2')) === 'My Playlists' && !(await A.$('[data-sl-chip]')), 'My Playlists shows only Liked Songs, playlists and folders, no filters');
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
  await A.click('#side-list .li-create'); await A.waitForTimeout(300);
  await A.click('#menu .mi:has-text("Playlist")'); await A.waitForTimeout(400);
  await A.fill('#pe-name', 'Newest In Test'); await A.click('#pe-save'); await A.waitForTimeout(800);
  const newestId = (await lib(A)).state.playlists.find(p => p.name === 'Newest In Test').id;
  const sideTop = await A.$$eval('#side-list .li[data-open]', x => x.map(e => e.dataset.open));
  // the column menu covers the whole cover when it opens upward over it
  await A.click('#side-list [data-open="liked"]'); await A.waitForTimeout(600);
  await A.setViewportSize({ width: 1440, height: 640 }); await A.waitForTimeout(300);
  await A.click('#view [data-cols]'); await A.waitForTimeout(300);
  const covered = await A.evaluate(() => { const m = document.getElementById('menu').getBoundingClientRect(), a = document.querySelector('#view .vhead .art').getBoundingClientRect(); return [Math.round(m.left - a.left), Math.round(m.top - a.top), m.right >= a.right - 1, m.bottom >= a.bottom - 1]; });
  await shot(A, 'cols-over-cover');
  await A.keyboard.press('Escape'); await A.setViewportSize({ width: 1440, height: 900 }); await A.waitForTimeout(300);
  check(covered[0] === 0 && covered[1] === 0 && covered[2] && covered[3], 'the column menu covers the whole cover when it opens over it', JSON.stringify(covered));
  check(sideTop[0] === 'liked' && sideTop[1] === 'playlist:' + newestId, 'a new playlist goes right under Liked Songs, even in Custom Sort', JSON.stringify(sideTop.slice(0, 3)));

  // --- clicking the page you are already on refreshes it
  await A.click('.nav-btn[data-nav="home"]'); await A.waitForTimeout(500);
  await A.evaluate(() => { window.__marker = document.querySelector('#view h1'); });
  await A.click('.nav-btn[data-nav="home"]'); await A.waitForTimeout(600);
  check(await A.evaluate(() => window.__marker !== document.querySelector('#view h1') && document.querySelector('#view').classList.contains('enter-fwd')), 'clicking the current page refreshes it');
  await A.hover('.logo'); await A.waitForTimeout(300);
  check(await A.$eval('.logo', e => getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)'), 'Allegro logo shows hover on the Home page');

  // --- the search box sits in the top right on every page, next to the profile button
  // The app draws its own slim scroll bars, which take up room like Windows ones do, so this checks the real case.
  const gutter = await A.$eval('#main', m => m.offsetWidth - m.clientWidth);
  check(gutter === 14, 'the main panel uses the slim scroll bar', String(gutter));
  const boxes = [], boxX = [];
  for (const n of ['home', 'search', 'library', 'uploads']) {
    await A.click(`.nav-btn[data-nav="${n}"]`); await A.waitForTimeout(350);
    await shot(A, 'nav-' + n);
    boxX.push(await A.$eval('#search-box', b => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)].join('-'); }));
    boxes.push(await A.evaluate(() => { const b = document.getElementById('search-box').getBoundingClientRect(), a = document.getElementById('acct-btn').getBoundingClientRect(); return b.width > 200 && b.height > 0 && b.right <= a.left && a.left - b.right < 20; }));
  }
  await A.fill('#search-input', 'Some');
  await A.waitForTimeout(500);
  const searched = await A.evaluate(() => [...document.querySelectorAll('#view .t-name')].map(e => e.textContent));
  check(new Set(boxX).size === 1, 'search box stays in the same spot on every page, long or short', JSON.stringify(boxX));
  const boxStyle = await A.$eval('#search-box', b => [getComputedStyle(b).backgroundColor, getComputedStyle(b).borderTopWidth]);
  check(boxStyle[0] === 'rgb(236, 236, 236)' && boxStyle[1] === '0px', 'search box is light gray with no outline while typing', JSON.stringify(boxStyle));
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
  const rowFit = await A.evaluate(() => { const r = document.getElementById('se-remove').getBoundingClientRect(), a = document.getElementById('se-album').getBoundingClientRect(), v = document.getElementById('se-view').getBoundingClientRect(), c = document.getElementById('se-cover').getBoundingClientRect();
    return [Math.round((r.top + r.height / 2) - (a.top + a.height / 2)), Math.round(r.left - c.left), Math.round(v.top - r.bottom), Math.round(v.left - c.left)]; });
  check(Math.abs(rowFit[0]) <= 2 && rowFit[1] === 0 && rowFit[3] === 0 && rowFit[2] >= 10, 'Remove Photo lines up with the Album box, buttons left-aligned and spaced apart', JSON.stringify(rowFit));
  await A.fill('#se-name', 'Sunny Day'); await A.fill('#se-artist', 'Edited Artist'); await A.fill('#se-album', 'Edited Album');
  await A.fill('#se-date', 'someday'); await A.click('#se-save'); await A.waitForTimeout(300);
  const dateErr = (await A.textContent('#se-err')).includes('release date') && await A.isVisible('#song-edit');
  await A.fill('#se-date', '4/11/2024');
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
  check(!(await A.$('#se-bpm')) && !(await A.$('#se-key')), 'the song editor has no BPM or Key boxes');
  check(dateErr && ed.released === '2024-04-11' && ed.year === '2024', 'release date is checked and saved from 4/11/2024 as 2024-04-11', JSON.stringify([dateErr, ed.released, ed.year]));
  check(seOpen && ed.title === 'Sunny Day' && ed.artist === 'Edited Artist' && ed.album === 'Edited Album' && ed.coverV > 0 && edImg.includes('?v=') && !!edDims && edDims[0] === edDims[1], 'editing a song saves its name, artist, album and new square art', JSON.stringify({ ed, edImg, edDims }));
  // Find Info Online in the editor fills everything in from the pick
  await A.click(`#view [data-edit-song="${tagged.id}"]`); await A.waitForTimeout(400);
  const shownDate = await A.inputValue('#se-date');
  check(shownDate === 'Apr 11, 2024', 'the editor shows the release date as Apr 11, 2024', shownDate);
  await A.fill('#se-name', 'Nightcore - Mock Hit (Official Audio)'); await A.fill('#se-artist', '');
  await A.click('#se-search');
  await A.waitForSelector('#se-results .se-hit', { timeout: 10000 }).catch(() => {});
  await shot(A, 'editor-search');
  await A.click('#se-results .se-hit >> nth=0').catch(() => {});
  await shot(A, 'editor-filled');
  const filled = [await A.inputValue('#se-name'), await A.inputValue('#se-artist'), await A.inputValue('#se-album'), await A.inputValue('#se-date')];
  await A.click('#se-save');
  await A.waitForFunction(() => document.getElementById('song-edit').hidden, null, { timeout: 10000 }).catch(() => {});
  data = await lib(A);
  const hit = data.songs.find(s => s.id === tagged.id);
  check(filled.join('|') === 'Mock Hit|Mock Artist|Mock Hit Album|Feb 2, 2021' && hit.album === 'Mock Hit Album' && hit.year === '2021' && hit.released === '2021-02-02' && hit.coverV > ed.coverV, 'Find Info Online fills in the song from the search', JSON.stringify({ filled, hit }));
  await A.click(`#view .tr[data-id="${tagged.id}"] [data-go-album]`); await A.waitForTimeout(500);
  const albumDate = await A.textContent('.vhead .meta .released').catch(() => '');
  check(albumDate === 'Feb. 2, 2021', 'album page shows the full release date', albumDate);
  await A.click('.nav-btn[data-nav="uploads"]'); await A.waitForTimeout(400);
  // when Apple turns the server away, Deezer still answers
  const dz = await A.evaluate(async () => (await fetch('/api/lookup?term=deezer%20song')).json());
  const dzHit = dz.results && dz.results.find(r => r.title === 'Deezer Song');
  const dzArt = dzHit ? await A.evaluate(async u => (await fetch('/api/art?url=' + encodeURIComponent(u))).status, dzHit.art) : 0;
  check(!!dzHit && dzHit.artist === 'Deezer Band' && dzHit.album === 'Deezer Album' && /403/.test(dz.sources.apple) && dzArt === 200, 'song search falls back to Deezer when Apple refuses', JSON.stringify({ dz, dzArt }));
  // artists show a blank picture until you choose one; songs never set it
  await A.click('.nav-btn[data-nav="library"]'); await A.waitForTimeout(400);
  await A.click('[data-chip="artists"]'); await A.waitForTimeout(300);
  const blankCard = await A.$eval('#view .card[data-open="artist:Mock Artist"] .card-art', c => !!c.querySelector('.artist-ph') && !c.querySelector('img')).catch(() => false);
  await A.click('#view .card[data-open="artist:Mock Artist"]'); await A.waitForTimeout(500);
  await A.hover('.vhead .art'); await A.waitForTimeout(300);
  await shot(A, 'artist-hover');
  const arDim = await A.$eval('.vhead .art', a => getComputedStyle(a, '::after').opacity === '1');
  const arPen = await A.$eval('.vhead .art [data-artist-pen]', e => getComputedStyle(e).opacity === '1').catch(() => false);
  const noLabel = !(await A.$('.vhead .eyebrow'));
  const fromFont = await A.$eval('.s-from .eyebrow', e => [getComputedStyle(e).fontFamily, getComputedStyle(e).textTransform]);
  check(noLabel && fromFont[0].startsWith('Onest') && fromFont[1] === 'none', 'page headers have no type label, and Playing From uses the site font', JSON.stringify(fromFont));
  check(blankCard && arDim && arPen, 'artists start blank, and the artist picture dims and shows a pen on hover', JSON.stringify([blankCard, arDim, arPen]));
  const arChooser = A.waitForEvent('filechooser');
  await A.click('.vhead .art [data-artist-pen]');
  await (await arChooser).setFiles(join(fixtures, 'wide.png')); await A.waitForTimeout(600);
  await A.click('#crop-apply'); await A.waitForTimeout(1500);
  data = await lib(A);
  const pic = (data.state.artistPics || []).find(x => x.name === 'Mock Artist');
  const arImg = await A.$eval('.vhead .art img', i => i.complete && i.naturalWidth > 0 && i.naturalWidth === i.naturalHeight).catch(() => false);
  const otherBlank = (await B.evaluate(async () => (await (await fetch('/api/library')).json()).state.artistPics.length)) === 1;
  check(!!pic && arImg && otherBlank, 'choosing an artist photo crops, saves online and shows it', JSON.stringify({ pic, arImg }));
  await A.click('.actions [data-ctx-more]'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("Remove Artist Photo")'); await A.waitForTimeout(800);
  data = await lib(A);
  check(!(data.state.artistPics || []).some(x => x.name === 'Mock Artist') && !!(await A.$('.vhead .art .artist-ph')), 'an artist photo can be removed');

  // the menu offers Edit Song in Uploads but not elsewhere
  await A.click('.nav-btn[data-nav="uploads"]'); await A.waitForTimeout(400);
  await A.click(`#view .tr[data-id="${tagged.id}"] .more`, { force: true }); await A.waitForTimeout(250);
  const upMenu = await A.$$eval('#menu .mi', x => x.map(e => e.textContent.trim()));
  await A.keyboard.press('Escape');
  await A.click('.nav-btn[data-nav="library"]'); await A.waitForTimeout(400);
  await A.click('[data-chip="songs"]'); await A.waitForTimeout(300);
  await A.click(`#view .tr[data-id="${tagged.id}"] .more`, { force: true }); await A.waitForTimeout(250);
  const songsMenu = await A.$$eval('#menu .mi', x => x.map(e => e.textContent.trim()));
  await A.keyboard.press('Escape');
  check(upMenu.includes('Edit Song') && !songsMenu.includes('Edit Song'), 'Edit Song is in the menu only in Uploads');

  // --- column picker at the left of the list header: each list keeps its own columns, saved online
  await A.click('.nav-btn[data-nav="uploads"]'); await A.waitForTimeout(400);
  await A.click('#view [data-cols]'); await A.waitForTimeout(250);
  const colOpts = await A.$$eval('#menu [data-col-opt]', x => x.map(e => e.textContent.trim()));
  for (const c of ['album', 'duration']) { await A.click(`#menu [data-col-opt="${c}"]`); await A.waitForTimeout(250); }
  const stillOpen = await A.isVisible('#menu') && (await A.$$eval('#menu [data-col-opt][aria-checked="true"]', x => x.map(e => e.dataset.colOpt))).join() === 'cover,title,artist,date';
  await shot(A, 'columns-menu');
  const menuInPanel = await A.evaluate(() => document.getElementById('menu').getBoundingClientRect().left >= document.getElementById('main').getBoundingClientRect().left);
  await A.keyboard.press('Escape'); await A.waitForTimeout(200);
  const upHead = await A.$$eval('#view .tl-head > span', x => x.map(e => e.textContent.trim()).filter(Boolean));
  const relCells = await A.$$eval('#view .tr .c-added', x => x.map(e => e.textContent));
  const relHead = upHead.includes('Date Released') && !upHead.includes('Date Added');
  const durCells = await A.$$eval('#view .tr .c-dur', x => x.length);
  const upAlbums = await A.$$eval('#view .tr .c-album', x => x.length);
  const colsLeft = await A.evaluate(() => { const b = document.querySelector('#view .col-btn').getBoundingClientRect(), n = [...document.querySelectorAll('#view .tl-head .c-n span')].pop().getBoundingClientRect(); return b.right <= n.left; });
  check(colOpts.join('|') === 'Song Cover|Title|Artist|Album|Date Released|Duration' && stillOpen && colsLeft && menuInPanel, 'column menu sits left of # and lists Song Cover, Title, Artist, Album, Date Released and Duration (no BPM or Key)', JSON.stringify(colOpts));
  check(upAlbums === 0 && !upHead.includes('Album') && durCells === 0 && !(await A.$('#view .tl-head .c-dur')), 'checked columns show and unchecked ones hide', JSON.stringify({ upHead, durCells, upAlbums }));
  const fonts = await A.evaluate(() => { const d = document.querySelector('#view .tr .c-dur') || document.querySelector('.prog span'), a = document.querySelector('#view .tr .c-added'); return [getComputedStyle(d).fontFamily, getComputedStyle(a).fontFamily]; });
  check(fonts[0] === fonts[1] && fonts[0].startsWith('Onest'), 'durations use the same font as the rest of the row', JSON.stringify(fonts));
  check(relHead && relCells.includes('Feb. 2, 2021') && relCells.includes('Jan. 1, 2019'), 'the date column shows when each song was released', JSON.stringify(relCells));
  await A.click('.nav-btn[data-nav="library"]'); await A.waitForTimeout(400); await A.click('[data-chip="songs"]'); await A.waitForTimeout(300);
  const libCols = [await A.$$eval('#view .tr .c-album', x => x.length), !!(await A.$('#view .tr .c-dur'))];
  data = await lib(A);
  const savedCols = (data.state.listCols || []).find(x => x.key === 'uploads');
  await A.reload(); await A.waitForTimeout(2000);
  await A.click('.nav-btn[data-nav="uploads"]'); await A.waitForTimeout(500);
  const afterReload = [!!(await A.$('#view .tr .c-album')), !!(await A.$('#view .tr .c-dur')), !!(await A.$('#view .tr .c-added'))];
  await B.reload(); await B.waitForTimeout(2000);
  const onB = await B.evaluate(() => JSON.stringify((JSON.parse(localStorage.getItem('waxwing.state.v1') || '{}').listCols || []).find(x => x.key === 'uploads') || null));
  check(afterReload.join() === 'false,false,true' && onB && !onB.includes('duration') && onB.includes('date'), 'column choices stay after reloading, and on other devices', JSON.stringify({ afterReload, onB }));
  // Song Cover can be switched off for one list
  await A.click('.nav-btn[data-nav="uploads"]'); await A.waitForTimeout(500);
  const coversBefore = await A.$$eval('#view .tr .c-title img', x => x.length);
  await A.click('#view [data-cols]'); await A.waitForTimeout(250);
  await A.click('#menu [data-col-opt="cover"]'); await A.waitForTimeout(300);
  await A.keyboard.press('Escape'); await A.waitForTimeout(200);
  const coversAfter = await A.$$eval('#view .tr .c-title img', x => x.length), titlesAfter = await A.$$eval('#view .tr .t-name', x => x.length);
  await A.click('.nav-btn[data-nav="library"]'); await A.waitForTimeout(400); await A.click('[data-chip="songs"]'); await A.waitForTimeout(300);
  const libCovers = await A.$$eval('#view .tr .c-title img', x => x.length);
  check(coversBefore > 0 && coversAfter === 0 && titlesAfter > 0 && libCovers > 0, 'Song Cover can be hidden for one list and stays on elsewhere', JSON.stringify({ coversBefore, coversAfter, titlesAfter, libCovers }));
  await A.click('.nav-btn[data-nav="library"]'); await A.waitForTimeout(400); await A.click('[data-chip="songs"]'); await A.waitForTimeout(500);
  const wantTop = await A.evaluate(() => { const m = document.getElementById('main'); m.scrollTop = 120; return m.scrollTop; }); await A.waitForTimeout(500);
  await A.reload(); await A.waitForTimeout(2500);
  const stayed = [await A.textContent('#view h1').catch(() => ''), await A.evaluate(() => document.getElementById('main').scrollTop)];
  check(stayed[0] === 'My Library' && wantTop > 20 && Math.abs(stayed[1] - wantTop) <= 4, 'reloading keeps you on the same page and scroll spot', JSON.stringify([...stayed, wantTop]));
  check(libCols[0] > 0 && libCols[1] && !!savedCols && savedCols.cols.join() === 'cover,title,artist,date', 'each list keeps its own columns, saved online', JSON.stringify({ libCols, savedCols }));
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

  // --- no drag-and-drop uploading: dropping a file on the page does nothing
  const songsBefore = (await lib(A)).songs.length;
  const dropped = await A.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(2000)], 'x.mp3', { type: 'audio/mpeg' }));
    for (const t of ['dragenter', 'dragover', 'drop']) document.querySelector('#view').dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
    return !document.getElementById('drop') && document.querySelector('img') ? getComputedStyle(document.querySelector('img')).webkitUserDrag : 'overlay'; });
  await A.waitForTimeout(1500);
  check(dropped === 'none' && (await lib(A)).songs.length === songsBefore, 'no Drop to Add: dropped files are ignored and pictures cannot be dragged', String(dropped));

  // --- Settings: in the account menu above "Allegro Account"; demo songs switch; change password
  await A.click('#acct-btn'); await A.waitForTimeout(250);
  const acctMenu = await A.$$eval('#menu > *', x => x.map(e => e.textContent.trim()).filter(Boolean));
  await A.click('#menu .mi:has-text("Settings")'); await A.waitForTimeout(500);
  const setH1 = await A.textContent('#view h1');
  await shot(A, 'settings');
  check(acctMenu.join('|') === 'Settings|Allegro Account|Sign Out' && setH1 === 'Settings', 'Settings sits above Allegro Account and opens the Settings page', JSON.stringify(acctMenu));
  await A.click('#set-demos'); await A.waitForTimeout(800);
  data = await lib(A);
  const demoOff = [(data.state.prefs || []).includes('hideDemos'), await A.evaluate(() => document.querySelector('#set-demos').getAttribute('aria-checked'))];
  await A.click('.nav-btn[data-nav="library"]'); await A.waitForTimeout(400); await A.click('[data-chip="songs"]'); await A.waitForTimeout(300);
  const demoTagsOff = await A.$$eval('#view .demo-tag', x => x.length);
  await A.click('#acct-btn'); await A.waitForTimeout(250); await A.click('#menu .mi:has-text("Settings")'); await A.waitForTimeout(400);
  await A.click('#set-demos'); await A.waitForTimeout(800);
  await A.click('.nav-btn[data-nav="library"]'); await A.waitForTimeout(400); await A.click('[data-chip="songs"]'); await A.waitForTimeout(300);
  const demoTagsOn = await A.$$eval('#view .demo-tag', x => x.length);
  check(demoOff[0] && demoOff[1] === 'false' && demoTagsOff === 0 && demoTagsOn > 0, 'Show Demo Songs hides and brings back the demo songs, saved online', JSON.stringify({ demoOff, demoTagsOff, demoTagsOn }));
  await A.click('#acct-btn'); await A.waitForTimeout(250); await A.click('#menu .mi:has-text("Settings")'); await A.waitForTimeout(400);
  await A.fill('#pw-cur', 'wrong password!'); await A.fill('#pw-new', 'brand new pass 1'); await A.fill('#pw-new2', 'brand new pass 1');
  await A.click('#pw-save'); await A.waitForFunction(() => document.getElementById('pw-msg').textContent.trim(), null, { timeout: 8000 }).catch(() => {});
  const pwBad = await A.textContent('#pw-msg');
  await A.fill('#pw-cur', PASSWORD); await A.fill('#pw-new', 'brand new pass 1'); await A.fill('#pw-new2', 'brand new pass 1');
  await A.click('#pw-save'); await A.waitForFunction(() => document.getElementById('pw-msg').textContent.includes('changed'), null, { timeout: 8000 }).catch(() => {});
  const pwGood = await A.textContent('#pw-msg');
  const stillIn = (await A.evaluate(async () => (await fetch('/api/library')).status)) === 200;
  const loginNew = await (await browser.newContext()).request.post(URL + 'api/login', { data: { password: 'brand new pass 1' } }).then(r => r.status());
  check(pwBad.includes('not right') && pwGood.includes('changed') && stillIn && loginNew === 200, 'Settings can change the password', JSON.stringify({ pwBad, pwGood, stillIn, loginNew }));

  // --- playlist version history: see every change, preview an old version, restore it
  await A.click('#side-list [data-open="playlist:pl-example"]'); await A.waitForTimeout(600);
  await A.click('.actions [data-ctx-more]'); await A.waitForTimeout(250);
  await A.click('#menu .mi:has-text("Version History")');
  await A.waitForSelector('#view .vh-item', { timeout: 10000 }).catch(() => {});
  const vhItems = await A.$$eval('#view .vh-item', x => x.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  const vhAll = vhItems.join(' | ');
  await shot(A, 'version-history');
  check(vhItems.length >= 3 && vhItems[0].includes('Current Version') && vhAll.includes('Renamed from “Late Night Study” to “Renamed In Test”') && vhAll.includes('Created the playlist') && vhAll.includes('Changed the song order'), 'Version History lists each change to the playlist', JSON.stringify(vhItems.slice(0, 6)));
  await A.click('#view .vh-item >> nth=-1'); await A.waitForTimeout(300);
  const oldName = await A.textContent('.vh-head h2');
  await A.click('[data-vh-restore]'); await A.waitForTimeout(2500);
  data = await lib(A);
  const restored = data.state.playlists.find(p => p.id === 'pl-example');
  await A.waitForTimeout(500);
  const vhTop = await A.$eval('#view .vh-item', e => e.textContent).catch(() => '');
  check(oldName === 'Late Night Study' && restored.name === 'Late Night Study' && vhTop.includes('Restored the version from'), 'an old version can be restored, and the restore is listed too', JSON.stringify({ oldName, restoredName: restored.name, vhTop: vhTop.slice(0, 120) }));

  // --- Appearance: dark mode and languages
  await A.click('#acct-btn'); await A.waitForTimeout(250); await A.click('#menu .mi:has-text("Settings")'); await A.waitForTimeout(500);
  await A.click('[data-theme-opt="dark"]'); await A.waitForTimeout(400);
  const darkNow = await A.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('.main')).backgroundColor]);
  await shot(A, 'settings-dark');
  await A.reload(); await A.waitForTimeout(1500);
  const darkKept = await A.evaluate(() => document.documentElement.dataset.theme);
  check(darkNow[0] === 'dark' && darkNow[1] === 'rgb(11, 11, 12)' && darkKept === 'dark', 'dark mode turns on from Settings and stays after reloading', JSON.stringify([...darkNow, darkKept]));
  await A.click('[data-lang-opt="zh-Hans"]'); await A.waitForTimeout(2500);
  const zh = await A.evaluate(() => [document.querySelector('.nav-btn[data-nav="home"] span').textContent, document.querySelector('#view h1').textContent, document.documentElement.lang, document.querySelector('#search-input').placeholder, document.querySelector('#side-list .li-create .li-name').textContent, document.querySelector('#side-list [data-open="liked"] .li-name').textContent]);
  await shot(A, 'settings-zh');
  await A.click('.nav-btn[data-nav="library"]'); await A.waitForTimeout(400); await A.click('[data-chip="songs"]'); await A.waitForTimeout(400);
  const zhLib = await A.evaluate(() => [document.querySelector('[data-chip="songs"]').textContent, [...document.querySelectorAll('#view .t-name')].map(e => e.textContent)]);
  check(zh[0] === '首页' && zh[1] === '设置' && zh[2] === 'zh-Hans' && zh[3] === '搜索' && zh[4] === '新建' && zh[5] === '喜欢的歌曲' && zhLib[0] === '歌曲' && zhLib[1].includes('Rain on Glass'), 'switching to 简体中文 translates Allegro but not your song names', JSON.stringify({ zh, chip: zhLib[0] }));
  await A.click('#acct-btn'); await A.waitForTimeout(250); await A.click('#menu .mi >> nth=0'); await A.waitForTimeout(500);
  await A.click('[data-lang-opt="zh-Hant"]'); await A.waitForTimeout(2500);
  const zht = await A.evaluate(() => [document.querySelector('.nav-btn[data-nav="home"] span').textContent, document.querySelector('#view h1').textContent]);
  await A.click('[data-lang-opt="en"]'); await A.waitForTimeout(2500);
  await A.click('[data-theme-opt="light"]'); await A.waitForTimeout(300);
  const backEn = await A.evaluate(() => [document.querySelector('.nav-btn[data-nav="home"] span').textContent, document.documentElement.dataset.theme]);
  check(zht[0] === '首頁' && zht[1] === '設定' && backEn.join() === 'Home,light', '繁體中文 works too, and switching back restores English and light mode', JSON.stringify({ zht, backEn }));

  // --- Now Playing: tilting cover, and Wiki / Lyrics / Comments on the right
  await A.click('.nav-btn[data-nav="uploads"]'); await A.waitForTimeout(500);
  await A.click(`#view .tr[data-id="${tagged.id}"] .t-name`); await A.waitForTimeout(800);
  await A.click('#p-cover'); await A.waitForTimeout(800);
  const np = await A.evaluate(() => [getComputedStyle(document.getElementById('s-panel')).display, [...document.querySelectorAll('[data-sp-tab]')].map(b => b.textContent).join('|'), (document.querySelector('.w-title') || {}).textContent, [...document.querySelectorAll('.w-row .w-k')].map(e => e.textContent).join('|')]);
  const bar = await A.evaluate(() => { const pl = document.getElementById('player').getBoundingClientRect(), sh = document.getElementById('sheet'), art = document.getElementById('s-art').getBoundingClientRect(), tab = document.querySelector('.sp-tab').getBoundingClientRect();
    const top = document.elementFromPoint(pl.left + pl.width / 2, pl.top + pl.height / 2);
    return [!!top && !!top.closest('#player'), getComputedStyle(document.querySelector('.s-ctrls')).display, art.bottom <= pl.top, Math.round(tab.height), getComputedStyle(document.querySelector('#player .p-title')).color]; });
  const sizes = await A.evaluate(() => { const a = document.getElementById('s-art').getBoundingClientRect(), p = document.getElementById('s-panel').getBoundingClientRect(); return [Math.round(a.height), Math.round(p.height), Math.round(a.top), Math.round(p.top), Math.round(a.width)]; });
  check(Math.abs(sizes[0] - sizes[1]) <= 2 && Math.abs(sizes[2] - sizes[3]) <= 2 && sizes[0] === sizes[4] && sizes[0] > 300, 'the cover and the panel are the same size, side by side', JSON.stringify(sizes));
  check(bar[0] && bar[1] === 'none' && bar[2] && bar[3] <= 28 && bar[4] === 'rgb(255, 255, 255)', 'on desktop, the play controls stay in the bar along the bottom, in white; the tabs are compact', JSON.stringify(bar));
  check(np[0] === 'flex' && np[1] === 'Wiki|Queue|Lyrics|Comments' && np[2] === 'Mock Hit' && np[3].startsWith('Singer|Album'), 'Now Playing shows Wiki, Queue, Lyrics and Comments beside the cover, Wiki first', JSON.stringify(np));
  { const b = await (await A.$('#s-art')).boundingBox(); await A.mouse.move(b.x + b.width * .2, b.y + b.height * .3); await A.mouse.move(b.x + b.width * .25, b.y + b.height * .3, { steps: 3 }); await A.waitForTimeout(200); }
  const tilt = await A.evaluate(() => { const bg = getComputedStyle(document.querySelector('.s-shine')).backgroundImage, m = bg.match(/at ([\d.]+)% ([\d.]+)%/); return [document.getElementById('s-art').style.transform, document.getElementById('s-art').classList.contains('tilting'), bg.includes('radial') && !!m && +m[1] > 50 && +m[2] > 50]; });
  await shot(A, 'now-playing-wiki');
  check(/rotateX/.test(tilt[0]) && tilt[1] && tilt[2], 'the cover eases toward the mouse, with the light on the far side', JSON.stringify(tilt));
  const gapNp = await A.evaluate(() => [Math.round(document.getElementById('player').getBoundingClientRect().top - document.getElementById('s-art').getBoundingClientRect().bottom), !document.querySelector('#player [data-act="sheet"]'), !document.getElementById('s-qtoggle'), getComputedStyle(document.querySelector('#p-cover .p-exp')).display]);
  check(gapNp[0] >= 40 && gapNp[1] && gapNp[2] && gapNp[3] === 'grid', 'a wider gap above the player bar; the expand and queue buttons are gone, the bar cover has the arrows instead', JSON.stringify(gapNp));
  await A.click('[data-sp-tab="queue"]'); await A.waitForTimeout(300);
  const qTab = await A.evaluate(() => [document.querySelectorAll('#sp-body .sp-queue .qrow.now').length, (document.querySelector('#sp-body .q-sec') || {}).textContent]);
  check(qTab[0] === 1, 'the queue is a page of the Now Playing panel', JSON.stringify(qTab));
  await A.click('[data-sp-tab="wiki"]'); await A.waitForTimeout(200);
  await A.click('[data-w-edit]'); await A.waitForTimeout(200);
  await A.fill('#w-lyricist', 'Writer A'); await A.fill('#w-composer', 'Composer B'); await A.fill('#w-about', 'A song about tests.');
  await A.click('[data-w-save]'); await A.waitForTimeout(1200);
  const wiki = await A.evaluate(() => [document.querySelector('.w-credits') && document.querySelector('.w-credits').textContent, document.querySelector('.w-about p').textContent]);
  data = await lib(A);
  const wm = data.songs.find(x => x.id === tagged.id);
  check(wiki[0].includes('Writer A') && wiki[0].includes('Composer B') && wiki[1] === 'A song about tests.' && wm.lyricist === 'Writer A' && wm.about === 'A song about tests.', 'Wiki credits and About can be written and are saved online', JSON.stringify(wiki));
  await A.mouse.move(5, 5);
  await A.click('[data-sp-tab="lyrics"]');
  await A.waitForSelector('#ly .ly-line', { timeout: 10000 }).catch(() => {});
  await A.waitForTimeout(1500);
  const ly = await A.evaluate(() => [...document.querySelectorAll('#ly .ly-line')].map(e => [e.textContent, e.className]));
  await shot(A, 'now-playing-lyrics');
  const onVis = await A.evaluate(() => { const on = document.querySelector('#ly .ly-line.on .ly-t'); if (!on) return null; const st = getComputedStyle(on, '::after'); return [st.content, st.color]; });
  check(!!onVis && onVis[0].length > 2 && onVis[1] === 'rgb(255, 255, 255)', 'the line being sung shows in white as it fills', JSON.stringify(onVis));
  check(ly.length === 5 && !/side/.test(ly[0][1]) && /side-1/.test(ly[2][1]) && ly[2][0].startsWith('Guest Singer') && /side-c/.test(ly[4][1]) && ly.some(l => / on/.test(l[1])), 'lyrics load with timing; a duet partner sings on the right, together lines in the middle', JSON.stringify(ly));
  await A.click('#ly .ly-line >> nth=3'); await A.waitForTimeout(400);
  const jumped = await A.evaluate(() => document.querySelector('#ly .ly-line.on') && document.querySelector('#ly .ly-line.on').dataset.lyI);
  check(jumped === '3' || jumped === '4', 'clicking a lyric line jumps there', String(jumped));
  await A.click('[data-sp-tab="comments"]'); await A.waitForTimeout(800);
  await A.fill('#cm-text', 'This chorus is great'); await A.click('#cm-form [type="submit"]');
  await A.waitForSelector('.cm-text', { timeout: 8000 }).catch(() => {});
  await A.click('[data-cm-like]'); await A.waitForTimeout(800);
  const cmList = await A.evaluate(async id => (await (await fetch('/api/comments/' + id)).json()).comments, tagged.id);
  await shot(A, 'now-playing-comments');
  check(cmList.length === 1 && cmList[0].text === 'This chorus is great' && cmList[0].liked === 1 && (await A.textContent('.cm-text')) === 'This chorus is great', 'comments can be posted and liked, saved online', JSON.stringify(cmList));
  await A.click('#p-cover'); await A.waitForTimeout(80);
  const closingNp = await A.evaluate(() => [document.getElementById('sheet').hidden, document.getElementById('sheet').classList.contains('closing')]);
  await A.waitForTimeout(450);
  const closedNp = await A.evaluate(() => document.getElementById('sheet').hidden);
  await A.click('#p-cover'); await A.waitForTimeout(600);
  const reopened = await A.evaluate(() => !document.getElementById('sheet').hidden);
  check(closingNp.join() === 'false,true' && closedNp && reopened, 'clicking the bar cover closes Now Playing smoothly and opens it again', JSON.stringify([closingNp, closedNp, reopened]));
  await A.keyboard.press('Escape'); await A.waitForTimeout(450);

  // --- lyrics with no times get timed to the song by AI
  await A.click('.nav-btn[data-nav="uploads"]'); await A.waitForTimeout(500);
  const swId = await A.evaluate(() => [...document.querySelectorAll('#view .tr')].find(r => r.querySelector('.t-name').textContent === 'Swapped Song').dataset.id);
  await A.click(`#view .tr[data-id="${swId}"] .t-name`); await A.waitForTimeout(800);
  await A.click('#p-cover'); await A.waitForTimeout(700);
  await A.click('[data-sp-tab="lyrics"]'); await A.waitForSelector('[data-ly-edit]', { timeout: 8000 }).catch(() => {});
  await A.click('[data-ly-edit]'); await A.waitForTimeout(200);
  await A.fill('#ly-edit', 'Hello there\nSecond line\nThird line'); await A.click('[data-ly-save]');
  await A.waitForSelector('#ly .ly-line', { timeout: 15000 }).catch(() => {});
  await A.waitForTimeout(400);
  const aiLines = await A.evaluate(() => [...document.querySelectorAll('#ly .ly-line')].map(e => e.textContent));
  const aiSaved = await A.evaluate(async id => (await (await fetch('/api/lyrics?id=' + id)).json()).synced, swId);
  await shot(A, 'lyrics-ai-timed');
  check(aiLines.length === 3 && /^\[00:00\.3\d\]Hello there\n\[00:01\.[78]\d\]Second line\n\[00:03\.[34]\d\]Third line$/.test(aiSaved || '') && transcribed.length >= 1 && transcribed[0].prompt.includes('Hello there') && transcribed[0].bytes > 1000,
    'plain lyrics get timed to the song with AI and saved', JSON.stringify({ aiSaved, aiLines, transcribed: transcribed.map(x => ({ ...x, prompt: x.prompt.slice(0, 40) })) }));
  await A.keyboard.press('Escape'); await A.waitForTimeout(450);

  // --- the play queue floats under the search bar, lined up with it, and fades in and out
  await A.locator('#view .tr').first().locator('.t-name').click(); await A.waitForTimeout(800);
  const mainW = await A.evaluate(() => document.getElementById('main').getBoundingClientRect().width);
  await A.click('#q-btn'); await A.waitForTimeout(60);
  const qMid = await A.evaluate(() => +getComputedStyle(document.getElementById('queue-panel')).opacity);
  await A.waitForTimeout(500);
  const qp = await A.evaluate(() => { const q = document.getElementById('queue-panel').getBoundingClientRect(), s = document.getElementById('search-box').getBoundingClientRect(), a = document.getElementById('acct-btn').getBoundingClientRect(), pl = document.getElementById('player').getBoundingClientRect();
    return { dl: Math.round(q.left - s.left), dr: Math.round(q.right - a.right), below: q.top > s.bottom, abovePlayer: q.bottom <= pl.top, op: getComputedStyle(document.getElementById('queue-panel')).opacity, main: document.getElementById('main').getBoundingClientRect().width,
      secs: [...document.querySelectorAll('#queue-list .q-sec')].map(e => e.textContent.trim()), now: document.querySelectorAll('#queue-list .qrow.now').length, next: document.querySelectorAll('#queue-list .qrow.next').length, past: document.querySelectorAll('#queue-list .qrow.past').length }; });
  await shot(A, 'queue-open');
  check(qMid < 1 && qp.op === '1' && qp.dl >= -4 && qp.dl <= 0 && qp.dr >= 0 && qp.dr <= 5 && qp.below && qp.abovePlayer && Math.abs(qp.main - mainW) < 1, 'the queue fades in as a card under the search bar, the same width as the search bar and account button, over the page', JSON.stringify({ qMid, ...qp, mainW }));
  check(qp.secs[0] === 'History' && /^Playing from: /.test(qp.secs[1]) && /Clear$/.test(qp.secs[1]) && /^Next Up from: /.test(qp.secs[2]) && qp.now === 1 && qp.past >= 1 && qp.next >= 1, 'the queue shows History, Playing from (with Clear) and Next Up', JSON.stringify(qp.secs));
  const nextN = qp.next;
  await A.click('[data-qclear]'); await A.waitForTimeout(300);
  const cleared = await A.evaluate(() => document.querySelectorAll('#queue-list .qrow.next').length);
  await A.click('#toast-act'); await A.waitForTimeout(300);
  const undone = await A.evaluate(() => document.querySelectorAll('#queue-list .qrow.next').length);
  check(cleared === 0 && undone === nextN, 'Clear empties what is coming up, and Undo brings it back', JSON.stringify([nextN, cleared, undone]));
  await A.click('#queue-panel [data-act="queue"]'); await A.waitForTimeout(60);
  const qOut = await A.evaluate(() => [+getComputedStyle(document.getElementById('queue-panel')).opacity, getComputedStyle(document.getElementById('queue-panel')).visibility]);
  await A.waitForTimeout(450);
  const qGone = await A.evaluate(() => [getComputedStyle(document.getElementById('queue-panel')).opacity, getComputedStyle(document.getElementById('queue-panel')).visibility, document.getElementById('queue-panel').inert]);
  check(qOut[0] > 0 && qOut[1] === 'visible' && qGone.join() === '0,hidden,true', 'closing the queue fades it out smoothly', JSON.stringify([qOut, qGone]));

  // --- nothing is reachable without a session
  const anon = await (await browser.newContext()).newPage();
  check((await anon.goto(URL + 'api/library')).status() === 401, 'library needs sign-in');
  check((await anon.goto(URL + 'api/audio/' + tagged.id)).status() === 401, 'song files need sign-in');
  check((await anon.goto(URL + 'api/playlist-cover/pl-example')).status() === 401, 'playlist covers need sign-in');

  check(pageErrors.length === 0, 'no JavaScript errors', pageErrors.join(' | '));
} catch (e) {
  failures++;
  console.error('FAIL  test crashed:', e && e.stack);
  console.error('page errors:', pageErrors.join(' | '));
  gh(`test crashed: ${e && e.message}`);
} finally {
  await browser.close();
  server.kill(); mock.close();
  rmSync(testConfig, { force: true });
  if (madeDevVars) rmSync(devVars, { force: true });
  rmSync(state, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
