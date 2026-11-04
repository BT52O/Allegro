# CLAUDE.md

Notes for Claude sessions working on **Allegro**. Read `AGENTS.md` too: it covers how Claude and ChatGPT/Codex share
this repo, and the rules for interface text, deleting, themes and phones.

## The owner and how to work with them

- Allegro is the owner's private, single-user music site in the style of Spotify and Tidal. They send screenshots
  (often of Tidal) and say "make it look like this". Match the reference closely, then show a screenshot of the result.
- Reply in English unless they write in Chinese.
- **No em dashes**, in replies or in anything they can see in the app. Use periods, commas, colons or parentheses.
- Ask questions as plain text in the chat, not pop-up pickers.
- If you're not sure, say so. Don't guess facts about outside services.
- Give short replies: what changed and what to check. No step-by-step recaps.
- **Secrets never go in chat, the repo or a commit.** The Cloudflare token and account ID live only in GitHub Actions
  secrets. Any future OpenAI API key goes only into a Cloudflare Worker secret, and the owner must not paste it into
  chat or code. Don't send the owner's email address to any service.

## Stack

- `public/index.html`: the whole app (HTML, CSS, vanilla JS in one IIFE). No build step, no framework, around 6,000+
  lines. Search with grep before editing.
- `src/worker.js`: Cloudflare Worker for `/api/*`.
- R2 bucket `allegro-music`, with these prefixes:
  - `audio/`: original files
  - `audio-96/` and `audio-320/`: MP3 streaming copies (on the wip branch, see below)
  - `cover/` and `cover-sm/` (600px)
  - `plcover/`, `arphoto/`
  - `lyrics/`, `lyrics-x/` (cached translations and romanizations)
- D1 database `allegro`. The schema is in `migrations/`. Add a new numbered file; never edit an old one.
- Workers AI is bound as `AI`:
  - `@cf/openai/whisper-large-v3-turbo` for lyric timing.
  - `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for translation and romanization.
- Browser libraries live in `public/vendor/` with their licenses: pinyin-pro, opencc-js, and wasm-media-encoders (the
  LAME MP3 encoder as WASM). Nothing loads from a CDN at runtime.
- Live site: https://allegro.allegro-music.workers.dev. Repo: `BT52O/Allegro`.

## Deploying

- `.github/workflows/deploy.yml` runs the tests on every push to `main` and on every pull request, but deploys only
  from `main`.
- Pushes to other branches are **not** tested unless a PR is open.
- Claude normally commits straight to `main` once the tests pass locally. A push to `main` goes live in about 10
  minutes.
- When CI fails, the logs host is blocked from the sandbox. Read the FAIL annotations instead:
  `gh api repos/BT52O/Allegro/check-runs/<job id>/annotations -q '.[].message'`

## Tests

- `tests/e2e.mjs` uses Playwright and `wrangler dev`. A mock server stands in for every outside service: LRCLIB,
  transcribe, LLM, search, Deezer and art.
- It writes `.wrangler-test.jsonc` (the config without `"ai"`, which would need remote auth) and passes `TRANSCRIBE_URL`,
  `LLM_URL`, `LYRICS_URL` and the search stand-in URLs as vars.
- There are about 140 checks, and a full run takes about 8 minutes. Run it in the background:

```sh
rm -f .dev.vars; SHOTS=/tmp/shots CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome timeout 590 npm test > /tmp/e2e.log 2>&1; echo "exit $?"
grep -n FAIL /tmp/e2e.log
```

- `SHOTS` sets the screenshot folder. The final line reports `PASS  no JavaScript errors`.
- Gotchas:
  - The `audio` element is not reachable from `page.evaluate`. Read the DOM instead: `#q-badge`, `.t-cur`,
    `.seek`, `#p-title`.
  - Use waitForFunction for anything animated or timed. CI is slower than the sandbox.
  - Delete confirmations need a click on `#cf-yes`.
  - The test MP3s are short: `tagged.mp3` is 8s at 128 kbps mono; `Some Band - Untagged Song.mp3` is 6s at 96 kbps.

## Conventions in the code

- **Translations:**
  - Every new piece of interface text needs a row in the `I18N` table as `['English', '简体', '繁體']`. Use `PAT` for
    text with numbers.
  - Names (songs, artists, albums, playlists) go inside `data-nt` or `NO_TR` selectors.
  - **Each row in `I18N` must end with a comma.** A missing comma turns the next row into an index and breaks the
    Chinese UI, and `node --check` does not catch it.
- **Deleting:** `askDelete(title, body, yes)` shows the confirm. After a delete, show a toast with Undo for `UNDO_MS`
  (15s).
- **Popups:** the player bar's right side uses `prPop(wrap, {hover})` with white `.pr-pop` cards.
- **Order:** new items go at the front (`unshift`): folders, songs added to playlists.
- **Saving:** `save()` writes localStorage (`STORE_KEY`) and syncs state to the server through `pushState`.
  - Per-device settings use their own keys: `allegro.speed`, `allegro.lyx`, `allegro.quality`, `allegro.pos`,
    `allegro.qskip`.
- **Fonts and sizes:** the font is Roboto (`html{font-size:15px}`). Phones are under 760px.
- **Editing scripts:** big edits work best as a Python script with `assert s.count(old) == 1` before each replace.
  - Check the app script after editing: extract the `<script>` contents and run `node --check` on them.

## Work in progress (as of 2026-11-04)

Branch **`wip/quality-and-resume`** is pushed but not merged. It contains:

1. **Resume:**
   - `lastSnap()` saves the queue and what the bar shows; `allegro.pos` saves the second.
   - `tryRestoreLast()` restores both; `showResumePos()` draws the saved spot on the seek bar.
   - `startCurrent` seeks to `resumeAt`.
   - The bar never shows "Nothing Playing" while songs exist. Test passes.
2. **Quality pill:** a glossy black pill. White means the original file, red means 320 kbps, gold means 96 kbps.
   - It opens a Max / 320 kbps / 96 kbps picker (`setQual`, `drawQuality`, `playSrc`, `playingCopy`).
3. **Streaming copies:**
   - `makeCopies` downloads the original, decodes it with OfflineAudioContext, and encodes MP3 in a blob Web Worker
     (`mp3Encode`).
   - It PUTs the result to `/api/songs/:id/audio-96|audio-320`, then re-PUTs the meta. The Worker sets
     `meta.q96`/`meta.q320` from the R2 heads.
   - Copies are made only on screens 760px and wider, and skipped when the original is already that small
     (`copyNeeded`).
   - "Prepare All Songs" in the popup backfills the library.
   - Copy creation passes its test.
4. **The badge no longer disappears:**
   - A failed header read is no longer cached.
   - The MP3 frame scan checks up to 64KB and validates the next frame.
   - The badge shows at 760–1080px widths, and is drawn for a restored song before play.

**Still failing:** "at 96 kbps the song plays from its copy with a gold pill". After the copy for `tagged.mp3` is made,
playing it again shows `128 kbps` (the original).
- The suspects:
  - the `audio` `error` handler, which falls back to the original and clears `t.meta.q96` if the copy fails to play;
  - or `t.meta.q96` not being set on the track object that `startCurrent` uses.
- Instrument `startCurrent` and the error handler, fix the bug, run the full suite, then merge to `main`.

## Open offers the owner hasn't answered (don't build unless asked)

- Podcasts through RSS feeds (the Podcasts tab on Home is an empty state).
- Hong Kong vs Taiwan Traditional Chinese for lyrics.
- Using the OpenAI API inside Allegro.
