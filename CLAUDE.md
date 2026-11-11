# CLAUDE.md

Notes for Claude sessions working on **Allegro**. Read `AGENTS.md` too: it covers how Claude and ChatGPT/Codex share
this repo, and the rules for interface text, deleting, themes and phones.

## The owner and how to work with them

- Allegro is the owner's private music site in the style of Spotify and Tidal, shared with friends through profiles. They send screenshots
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
  - `audio-96/` and `audio-320/`: MP3 streaming copies (made in the browser, see `makeCopies`)
  - `cover/` and `cover-sm/` (600px)
  - `plcover/`, `arphoto/`, `pfphoto/` (profile photos)
  - `lyrics/`, `lyrics-x/` (cached translations and romanizations)
- D1 database `allegro`. The schema is in `migrations/`. Add a new numbered file; never edit an old one.
- Workers AI is bound as `AI`:
  - `@cf/openai/whisper-large-v3-turbo` for lyric timing.
  - `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for translation and romanization.
- Browser libraries live in `public/vendor/` with their licenses: pinyin-pro, opencc-js, and wasm-media-encoders (the
  LAME MP3 encoder as WASM). Nothing loads from a CDN at runtime.
- Live site: https://allegro.allegro-music.workers.dev. Repo: `BT52O/Allegro`.

## Profiles

- One shared password opens Allegro, then "Who's listening?" picks a profile. Friends share one music library;
  each profile has its own playlists, likes, history, folders and columns.
- `admin` is the owner's profile ("the Admin"), locked with a 6-digit PIN (kv `adminPin`, 6 wrong tries lock it for
  10 min). Only the Admin can delete songs, change the shared password, change the PIN, or delete other profiles.
  Anyone can upload and edit song info.
- Data: D1 `profiles` table; library state in kv `state` (the Admin, kept from before profiles) or `state:<id>`.
  `artistPics` is shared and always lives in `state`. Comments record `profile`.
- The session cookie (v2) carries the profile id and, for the Admin, a fingerprint of the PIN. Old v1 cookies are
  the owner's and are treated as the Admin.
- In the app, per-profile localStorage keys go through `pk()`: the Admin keeps the original key names, others get
  `@<id>`. The current profile on this device is `allegro.profile`. Opening a different profile reloads the page.
- Song deletes in the UI check `canDelete(t)`.

## Original song names

- Settings > Library > Original Song Names (pref `origNames`, synced per profile). `nm(t)` is the name to show: the
  song's `oTitle` when the switch is on, otherwise `title`. Use `nm(t)` anywhere a song name is displayed.
- `oTitle` and `oSeen` (already looked up, or set by hand) live in the song's shared info. `findOriginals` fills them
  in the background: it finds the song in Apple's US search, then asks `/api/store-names` for the same song in the
  Korean, Japanese and Taiwanese stores, and `pickOriginal` chooses. Artist and album names are not changed.

## Deploying

- `.github/workflows/deploy.yml` runs the tests on every push to `main` and on every pull request, but deploys only
  from `main`.
- Pushes to other branches are **not** tested unless a PR is open.
- Claude normally commits straight to `main` once the tests pass locally. A push to `main` goes live in about 10
  minutes.
- When CI fails, the logs host is blocked from the sandbox. Read the FAIL annotations instead:
  `gh api repos/BT52O/Allegro/check-runs/<job id>/annotations -q '.[].message'`

## Tests

- **Pick the right check.** Wording, translations and CSS only: run `npm run check` (half a second) and push.
  Anything that changes behavior: run the full suite below. GitHub runs both before every deploy anyway.
  `npm run check` parses the app script and the Worker and validates the `I18N` table (three strings per row,
  trailing commas, no duplicates, no em dashes).
- `tests/e2e.mjs` uses Playwright and `wrangler dev`. A mock server stands in for every outside service: LRCLIB,
  transcribe, LLM, search, Deezer and art.
- It writes `.wrangler-test.jsonc` (the config without `"ai"`, which would need remote auth) and passes `TRANSCRIBE_URL`,
  `LLM_URL`, `LYRICS_URL` and the search stand-in URLs as vars.
- There are about 150 checks, and a full run takes about 4 minutes in the sandbox. Run it in the background:

```sh
rm -f .dev.vars; SHOTS=/tmp/shots CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome timeout 590 npm test > /tmp/e2e.log 2>&1; echo "exit $?"
grep -n FAIL /tmp/e2e.log
```

- `SHOTS` sets the screenshot folder. The final line reports `PASS  no JavaScript errors`.
- Gotchas:
  - The `audio` element is not reachable from `page.evaluate`. Read the DOM instead: `#q-badge`, `.t-cur`,
    `.seek`, `#p-title`.
  - Use waitForFunction for anything animated or timed. CI is slower than the sandbox.
  - Pause with `settle(page, ms)`, not `page.waitForTimeout`: it returns once the page is quiet (no requests,
    no song still starting, no short timers, no animations) and never waits longer than `ms`. Keep
    `waitForTimeout` only where time itself must pass, such as the Undo window running out.
  - Reloads later in the run take 4 to 18 seconds each, in the old suite too (the server answers fast; the
    browser starts reading the page late). The cause is not known yet.
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
- **Playlist edit mode:** songs and page breaks on a playlist page drag only in edit mode (the Edit button, `plEdit`,
  `setPlEdit`). Edit Details opens from the cover or the ⋯ menu.
- **Popups:** the player bar's right side uses `prPop(wrap, {hover})` with white `.pr-pop` cards.
- **Order:** new items go at the front (`unshift`): folders, songs added to playlists.
- **Saving:** `save()` writes localStorage (`STORE_KEY`) and syncs state to the server through `pushState`.
  - Per-device settings use their own keys: `allegro.quality`, `allegro.qskip`, `allegro.theme`, `allegro.lang`.
    Per-profile ones go through `pk()`: `allegro.speed`, `allegro.lyx`, `allegro.pos`, `allegro.place.v1`.
- **Fonts and sizes:** the font is Roboto (`html{font-size:15px}`). Phones are under 760px.
- **Editing scripts:** big edits work best as a Python script with `assert s.count(old) == 1` before each replace.
  - Check the app script after editing: extract the `<script>` contents and run `node --check` on them.

## Open offers the owner hasn't answered (don't build unless asked)

- Podcasts through RSS feeds (the Podcasts tab on Home is an empty state).
- Hong Kong vs Taiwan Traditional Chinese for lyrics.
- Using the OpenAI API inside Allegro.
