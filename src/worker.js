// Allegro server: password login, song files in R2, library data in D1.
// Static files (public/index.html) are served by Cloudflare before this code runs;
// everything under /api/ comes here.

const COOKIE = 'allegro_session';
const SESSION_DAYS = 365;
const MAX_AUDIO = 100 * 1024 * 1024;   // Cloudflare's request size limit on the free plan
const MAX_COVER = 10 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});
const fail = (status, error) => json({ error }, status);

/* ---------- crypto helpers ---------- */
const b64 = u8 => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = u8 => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))));
}
async function hashPassword(password, saltB64) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { salt: b64(salt), hash: b64(new Uint8Array(bits)) };
}

/* ---------- small key/value table in D1 ---------- */
async function kvGet(env, key) {
  const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first();
  return row ? JSON.parse(row.value) : null;
}
async function kvSet(env, key, value) {
  await env.DB.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value)).run();
}

/* ---------- sessions ---------- */
function getCookie(request, name) {
  const h = request.headers.get('cookie') || '';
  for (const part of h.split(/;\s*/)) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1); }
  return null;
}
// Sessions carry a short fingerprint of the stored password hash, so changing the password signs out every device.
const passwordTag = async (env, auth) => (await hmac(env.SESSION_SECRET, 'pw:' + auth.hash)).slice(0, 16);
async function newSessionCookie(env, auth) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const payload = `v1.${exp}.${await passwordTag(env, auth)}`;
  const value = payload + '.' + await hmac(env.SESSION_SECRET, payload);
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
async function isSignedIn(request, env) {
  const c = getCookie(request, COOKIE);
  if (!c || !env.SESSION_SECRET) return false;
  const i = c.lastIndexOf('.');
  if (i < 0) return false;
  const payload = c.slice(0, i), sig = c.slice(i + 1);
  if (!same(sig, await hmac(env.SESSION_SECRET, payload))) return false;
  const [v, exp, tag] = payload.split('.');
  if (v !== 'v1' || !(Number(exp) > Date.now())) return false;
  const auth = await kvGet(env, 'auth');
  return !!auth && same(tag, await passwordTag(env, auth));
}

/* ---------- song metadata ---------- */
const str = (v, max = 300) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
function cleanMeta(d) {
  return {
    title: str(d.title) || 'Untitled', artist: str(d.artist) || 'Unknown artist', albumArtist: str(d.albumArtist),
    album: str(d.album) || 'Unknown album', year: str(d.year, 10), trackNo: Number(d.trackNo) || 0, genre: str(d.genre, 80),
    duration: Number(d.duration) || 0, added: Number(d.added) || Date.now(), fileName: str(d.fileName),
    mime: str(d.mime, 60), cover: !!d.cover, coverV: Number(d.coverV) || 0,
    released: /^\d{4}(-\d{2}-\d{2})?$/.test(str(d.released, 10)) ? str(d.released, 10) : '',
    bpm: Number(d.bpm) > 0 && Number(d.bpm) < 1000 ? Math.round(Number(d.bpm) * 10) / 10 : 0, key: str(d.key, 12), tagsRead: !!d.tagsRead
  };
}

/* ---------- serving files from R2 ---------- */
async function serveObject(request, env, key, ranged) {
  const obj = await env.BUCKET.get(key, ranged ? { range: request.headers } : undefined);
  if (!obj) return fail(404, 'Not found');
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  if (!ranged) return new Response(obj.body, { headers });
  headers.set('accept-ranges', 'bytes');
  if (request.headers.has('range') && obj.range) {
    const r = obj.range;
    let start, end;
    if ('suffix' in r) { start = Math.max(0, obj.size - r.suffix); end = obj.size - 1; }
    else { start = r.offset || 0; end = r.length != null ? start + r.length - 1 : obj.size - 1; }
    headers.set('content-range', `bytes ${start}-${end}/${obj.size}`);
    headers.set('content-length', String(end - start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { headers });
}

async function putObject(request, env, key, max, typeOk) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!typeOk(type)) return fail(415, 'That file type is not supported.');
  const len = Number(request.headers.get('content-length'));
  if (!len) return fail(411, 'The upload was empty.');
  if (len > max) return fail(413, `File is too large (limit ${Math.round(max / 1048576)} MB).`);
  const obj = await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: type } });
  return json({ size: obj.size });
}

/* ---------- API ---------- */
async function api(request, env, path) {
  const method = request.method;

  if (path === 'session' && method === 'GET') {
    const auth = await kvGet(env, 'auth');
    return json({ signedIn: auth ? await isSignedIn(request, env) : false, needsSetup: !auth });
  }

  if (path === 'setup' && method === 'POST') {
    if (await kvGet(env, 'auth')) return fail(409, 'Already set up. Sign in with your password.');
    const { code, password } = await request.json().catch(() => ({}));
    if (!env.SETUP_CODE || !same(String(code || '').trim(), env.SETUP_CODE)) { await new Promise(r => setTimeout(r, 800)); return fail(403, 'That setup code is not right.'); }
    if (typeof password !== 'string' || password.length < 8) return fail(400, 'Use at least 8 characters.');
    const auth = await hashPassword(password);
    await kvSet(env, 'auth', auth);
    return json({ ok: true }, 200, { 'set-cookie': await newSessionCookie(env, auth) });
  }

  if (path === 'login' && method === 'POST') {
    const auth = await kvGet(env, 'auth');
    if (!auth) return fail(409, 'Not set up yet.');
    const { password } = await request.json().catch(() => ({}));
    const tryHash = await hashPassword(String(password || ''), auth.salt);
    if (!same(tryHash.hash, auth.hash)) { await new Promise(r => setTimeout(r, 800)); return fail(403, 'Wrong password.'); }
    return json({ ok: true }, 200, { 'set-cookie': await newSessionCookie(env, auth) });
  }

  if (path === 'logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': clearCookie });

  // Everything below needs a signed-in session.
  if (!(await isSignedIn(request, env))) return fail(401, 'Please sign in.');

  if (path === 'password' && method === 'POST') {
    const auth = await kvGet(env, 'auth');
    const { current, next } = await request.json().catch(() => ({}));
    const check = await hashPassword(String(current || ''), auth.salt);
    if (!same(check.hash, auth.hash)) return fail(403, 'Your current password is not right.');
    if (typeof next !== 'string' || next.length < 8) return fail(400, 'Use at least 8 characters.');
    const fresh = await hashPassword(next);
    await kvSet(env, 'auth', fresh);
    return json({ ok: true }, 200, { 'set-cookie': await newSessionCookie(env, fresh) });
  }

  if (path === 'library' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, data FROM songs ORDER BY added').all();
    const usage = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS songs FROM songs').first();
    return json({
      songs: results.map(r => ({ id: r.id, ...JSON.parse(r.data) })),
      state: await kvGet(env, 'state'),
      usage: { bytes: usage.bytes, songs: usage.songs }
    });
  }

  if (path === 'state' && (method === 'PUT' || method === 'PATCH')) {
    const text = await request.text();
    if (text.length > 512 * 1024) return fail(413, 'Library data is too large.');
    let body; try { body = JSON.parse(text); } catch (e) { return fail(400, 'Bad data.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Bad data.');
    const clean = {
      playlists: v => v,
      liked: v => v.filter(x => typeof x === 'string'),
      libOrder: v => v.filter(k => typeof k === 'string').slice(0, 5000),
      history: v => v.filter(h => h && typeof h.id === 'string' && typeof h.at === 'number').slice(0, 100),
      recent: v => v.filter(k => typeof k === 'string').slice(0, 50),
      folders: v => v.filter(f => f && ID_RE.test(f.id) && typeof f.name === 'string' && Array.isArray(f.ids)).slice(0, 500).map(f => ({ id: f.id, name: f.name.slice(0, 100), created: Number(f.created) || 0, ids: f.ids.filter(x => typeof x === 'string').slice(0, 2000) })),
      listCols: v => v.filter(x => x && typeof x.key === 'string' && Array.isArray(x.cols)).slice(0, 3000).map(x => ({ key: x.key.slice(0, 300), cols: x.cols.filter(c => typeof c === 'string').slice(0, 12) })),
      artistPics: v => v.filter(x => x && typeof x.name === 'string' && ID_RE.test(x.id) && typeof x.v === 'number').slice(0, 5000)
    };
    // PATCH changes only the parts it sends; PUT (older pages) replaces everything.
    const state = method === 'PATCH' ? ((await kvGet(env, 'state')) || {}) : {};
    for (const [k, fn] of Object.entries(clean)) {
      if (Array.isArray(body[k])) state[k] = fn(body[k]);
      else if (method === 'PUT') state[k] = [];
    }
    if (method === 'PATCH' && Array.isArray(body.history)) {
      // Plays from different devices are combined rather than replaced.
      const prev = (await kvGet(env, 'state') || {}).history || [];
      const seen = new Set(), merged = [];
      for (const h of [...state.history, ...prev].sort((a, b) => b.at - a.at)) { const key = h.id + '@' + h.at; if (!seen.has(key)) { seen.add(key); merged.push(h); } }
      state.history = merged.slice(0, 100);
    }
    state.updatedAt = Date.now();
    await kvSet(env, 'state', state);
    return json({ ok: true });
  }

  // Song info lookup: asks Apple's iTunes Search API and Deezer's public API at the same time, so one of them
  // being down or blocking Cloudflare doesn't stop it. Apple's results come first (they include year and genre).
  if (path === 'lookup' && method === 'GET') {
    const term = (new URL(request.url).searchParams.get('term') || '').trim().slice(0, 200);
    if (!term) return json({ results: [] });
    const getJSON = async (url, who) => {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Allegro/1.0 (personal music library)' } });
      if (!r.ok) throw new Error(`${who} ${r.status}`);
      try { return JSON.parse(await r.text()); } catch (e) { throw new Error(`${who} sent bad data`); }
    };
    const apple = getJSON((env.MUSIC_SEARCH_URL || 'https://itunes.apple.com/search') + '?' + new URLSearchParams({ term, media: 'music', entity: 'song', limit: '15', country: 'US' }), 'Apple')
      .then(d => (d.results || []).filter(x => x && x.trackName && x.artistName).map(x => ({
        title: str(x.trackName), artist: str(x.artistName), album: str(x.collectionName),
        albumArtist: x.collectionArtistName && x.collectionArtistName !== x.artistName ? str(x.collectionArtistName) : '',
        year: str(x.releaseDate, 4), released: str(x.releaseDate, 10), genre: str(x.primaryGenreName, 80), trackNo: Number(x.trackNumber) || 0,
        duration: (Number(x.trackTimeMillis) || 0) / 1000,
        art: typeof x.artworkUrl100 === 'string' ? x.artworkUrl100.replace(/\/\d+x\d+(bb)?\.(jpg|png|webp)$/i, '/600x600bb.jpg') : ''
      })));
    const deezer = getJSON((env.DEEZER_SEARCH_URL || 'https://api.deezer.com/search') + '?' + new URLSearchParams({ q: term, limit: '15' }), 'Deezer')
      .then(d => { if (d.error) throw new Error('Deezer ' + (d.error.message || 'error')); return d; })
      .then(d => (d.data || []).filter(x => x && x.title && x.artist && x.artist.name).map(x => ({
        title: str(x.title), artist: str(x.artist.name), album: str(x.album && x.album.title), albumArtist: '',
        year: '', released: '', genre: '', trackNo: 0, duration: Number(x.duration) || 0,
        art: str(x.album && (x.album.cover_xl || x.album.cover_big), 500)
      })));
    const [a, b] = await Promise.allSettled([apple, deezer]);
    if (a.status === 'rejected' && b.status === 'rejected') {
      console.error('lookup failed', a.reason && a.reason.message, b.reason && b.reason.message);
      return fail(502, `The music search isn't answering (${a.reason.message}, ${b.reason.message}). Try again in a minute.`);
    }
    const seen = new Set(), results = [];
    for (const r of [...(a.value || []), ...(b.value || [])]) {
      const key = [r.title, r.artist, r.album].join('|').toLowerCase();
      if (!seen.has(key)) { seen.add(key); results.push(r); }
    }
    return json({ results, sources: { apple: a.status === 'fulfilled' ? 'ok' : a.reason.message, deezer: b.status === 'fulfilled' ? 'ok' : b.reason.message } }, 200, { 'cache-control': 'private, max-age=3600' });
  }
  // Fetches album artwork from the search results so the page can save it as a song's cover.
  if (path === 'art' && method === 'GET') {
    let u; try { u = new URL(new URL(request.url).searchParams.get('url') || ''); } catch (e) { return fail(400, 'Bad image address.'); }
    const testHosts = [env.MUSIC_SEARCH_URL, env.DEEZER_SEARCH_URL].filter(Boolean).map(x => new URL(x).origin);
    const okHost = u.protocol === 'https:' && /(^|\.)(mzstatic\.com|dzcdn\.net|deezer\.com)$/.test(u.hostname);
    if (!(okHost || testHosts.includes(u.origin))) return fail(400, 'That image address is not allowed.');
    const r = await fetch(u.toString(), { headers: { 'user-agent': 'Allegro/1.0 (personal music library)' } }).catch(() => null);
    const type = r && (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!r || !r.ok || !/^image\/(jpeg|png|gif|webp)$/.test(type)) return fail(502, "Couldn't download that artwork.");
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_COVER) return fail(413, 'That artwork is too large.');
    return new Response(buf, { headers: { 'content-type': type, 'cache-control': 'no-store' } });
  }

  let m = path.match(/^audio\/([^/]+)$/);
  if (m && method === 'GET') return ID_RE.test(m[1]) ? serveObject(request, env, 'audio/' + m[1], true) : fail(404, 'Not found');
  m = path.match(/^cover\/([^/]+)$/);
  if (m && method === 'GET') return ID_RE.test(m[1]) ? serveObject(request, env, 'cover/' + m[1], false) : fail(404, 'Not found');

  m = path.match(/^artist-photo\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (!ID_RE.test(id)) return fail(400, 'Bad artist id.');
    if (method === 'GET') return serveObject(request, env, 'arphoto/' + id, false);
    if (method === 'PUT') return putObject(request, env, 'arphoto/' + id, MAX_COVER, t => /^image\/(jpeg|png|gif|webp)$/.test(t));
    if (method === 'DELETE') { await env.BUCKET.delete('arphoto/' + id); return json({ ok: true }); }
  }

  m = path.match(/^playlist-cover\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (!ID_RE.test(id)) return fail(400, 'Bad playlist id.');
    if (method === 'GET') return serveObject(request, env, 'plcover/' + id, false);
    if (method === 'PUT') return putObject(request, env, 'plcover/' + id, MAX_COVER, t => /^image\/(jpeg|png|gif|webp)$/.test(t));
    if (method === 'DELETE') { await env.BUCKET.delete('plcover/' + id); return json({ ok: true }); }
  }

  m = path.match(/^songs\/([^/]+)(?:\/(audio|cover))?$/);
  if (m) {
    const [, id, part] = m;
    if (!ID_RE.test(id)) return fail(400, 'Bad song id.');
    if (part === 'audio' && method === 'PUT') return putObject(request, env, 'audio/' + id, MAX_AUDIO, t => t.startsWith('audio/') || t === 'application/octet-stream' || t === 'video/mp4' || t === 'video/webm');
    if (part === 'cover' && method === 'PUT') return putObject(request, env, 'cover/' + id, MAX_COVER, t => /^image\/(jpeg|png|gif|webp)$/.test(t));
    if (!part && method === 'PUT') {
      const audio = await env.BUCKET.head('audio/' + id);
      if (!audio) return fail(409, 'Upload the song file first.');
      const meta = cleanMeta(await request.json().catch(() => ({})));
      const cover = meta.cover ? await env.BUCKET.head('cover/' + id) : null;
      if (!meta.cover) await env.BUCKET.delete('cover/' + id);   // photo removed, or the song never had one
      meta.cover = !!cover;
      meta.size = audio.size + (cover ? cover.size : 0);
      await env.DB.prepare('INSERT INTO songs (id, data, size, added) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, size = excluded.size')
        .bind(id, JSON.stringify(meta), meta.size, meta.added).run();
      return json({ id, ...meta });
    }
    if (!part && method === 'DELETE') {
      await env.BUCKET.delete(['audio/' + id, 'cover/' + id]);
      await env.DB.prepare('DELETE FROM songs WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }
  return fail(404, 'Not found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(request, env, url.pathname.slice(5)); }
      catch (e) { console.error(e); return fail(500, 'Something went wrong on the server. Try again.'); }
    }
    return env.ASSETS.fetch(request);
  }
};
