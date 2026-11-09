// Fast check (a few seconds) for small changes: wording, translations, CSS.
// It catches the mistakes those edits actually cause. Behavior changes still need `npm test`,
// and GitHub runs the full suite before every deploy either way.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
let failures = 0;
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

// 1. The app script and the Worker parse. A syntax error here blanks the whole site.
const tmp = mkdtempSync(join(tmpdir(), 'allegro-check-'));
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const appJs = join(tmp, 'app.js');
writeFileSync(appJs, scripts.join('\n;\n'));
for (const [file, label] of [[appJs, 'the app script in public/index.html parses'], [join(root, 'src', 'worker.js'), 'src/worker.js parses']]) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); check(true, label); }
  catch (e) { check(false, label, String(e.stderr || e.message).split('\n').slice(0, 6).join(' | ')); }
}

// 2. The translation table. A missing comma between two rows does not break parsing:
// it turns the next row into an index, so a row quietly becomes `undefined` and the Chinese UI breaks.
const start = html.indexOf('const I18N = [');
const end = html.indexOf('\n];', start);
check(start > -1 && end > start, 'found the I18N table');
if (start > -1 && end > start) {
  const body = html.slice(start + 'const I18N = ['.length, end);
  let rows = null;
  try { rows = new Function(`return [${body}\n];`)(); } catch (e) { check(false, 'the I18N table evaluates', e.message); }
  if (rows) {
    const bad = rows.map((r, i) => [r, i]).filter(([r]) => !Array.isArray(r) || r.length !== 3 || r.some(x => typeof x !== 'string' || !x.trim()));
    // A row that comes out wrong is the one missing its comma at the end; name the row before it so it is easy to find.
    const near = bad.slice(0, 3).map(([r, i]) => `row ${i + 1}${i > 0 && Array.isArray(rows[i - 1]) ? ` (after '${rows[i - 1][0]}')` : ''}: ${JSON.stringify(r)}`);
    check(bad.length === 0, `every I18N row is ['English', '简体', '繁體'] (${rows.length} rows)`, near.join(' ; '));
    const seen = new Map(), dup = [];
    for (const r of rows) if (Array.isArray(r)) { if (seen.has(r[0]) && JSON.stringify(seen.get(r[0])) !== JSON.stringify(r)) dup.push(r[0]); seen.set(r[0], r); }
    check(dup.length === 0, 'no English text has two different translations', JSON.stringify(dup.slice(0, 5)));
    const dashes = rows.filter(r => Array.isArray(r) && r.some(x => typeof x === 'string' && x.includes('—'))).map(r => r[0]);
    check(dashes.length === 0, 'no em dashes in interface text', JSON.stringify(dashes.slice(0, 5)));
  }
  // Every row line ends with a comma (the rule in CLAUDE.md), so the next added row is safe.
  const lines = body.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));
  const noComma = lines.filter(l => !l.endsWith(','));
  check(noComma.length === 0, 'every line of the I18N table ends with a comma', noComma.slice(0, 3).map(l => l.slice(0, 60)).join(' ; '));
}

// 3. The PAT table (text with numbers or names). A missing comma there turns a row into an index the same way,
// and the whole language switch then throws.
{
  const ps = html.indexOf('const PAT = ['), pe = html.indexOf('\n];', ps);
  let pats = null;
  try { pats = new Function('const pickL = (a, b) => a, tr1 = x => x;' + html.slice(ps, pe + 3) + '\nreturn PAT;')(); } catch (e) { check(false, 'the PAT table evaluates', e.message); }
  if (pats) {
    const bad = pats.map((r, i) => [r, i]).filter(([r]) => !Array.isArray(r) || r.length !== 2 || !(r[0] instanceof RegExp) || typeof r[1] !== 'function');
    check(bad.length === 0, `every PAT row is [/pattern/, m => ...] (${pats.length} rows)`, bad.slice(0, 3).map(([, i]) => `row ${i + 1}${i > 0 ? ` (after ${pats[i - 1] && pats[i - 1][0]})` : ''}`).join(' ; '));
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll fast checks passed');
process.exit(failures ? 1 : 0);
