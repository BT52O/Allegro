# Working on Allegro (notes for AI coding agents)

Two AI agents work on this repo for the owner: **Claude** (Anthropic) and **ChatGPT / Codex** (OpenAI).
These notes keep us from stepping on each other. Read them before changing anything.

## Who works where

- **Claude and ChatGPT / Codex** may commit and push directly to `main` after the required tests pass.
  No pull request or manual merge is needed unless the owner explicitly requests one. Every push to `main`
  runs the GitHub Actions tests and deploys only if those tests pass.
- Before starting, pull the latest `main`. Before pushing, fetch and integrate the latest `main` so the other
  agent's work is preserved. If integration changes the tested code, rerun the relevant tests. Never force-push `main`.
- Keep each change to one feature or fix. Small commits are easier to review and less likely to collide.
- If a task touches the same area someone else is changing (an open pull request, or recent commits), say so to the
  owner instead of guessing.

## The project

A private music website in the style of Spotify and Tidal, shared with friends through profiles (see CLAUDE.md). Live at https://allegro.allegro-music.workers.dev

| Path | What it is |
|---|---|
| `public/index.html` | The whole web app: one file of HTML, CSS and vanilla JavaScript, no build step and no framework. |
| `src/worker.js` | The Cloudflare Worker behind `/api/*`: login, uploads, streaming, library sync, lookups, lyrics, AI. |
| `migrations/` | D1 (SQLite) schema. Add a new numbered file for changes; never edit an old one. |
| `tests/e2e.mjs` | End-to-end tests (Playwright + `wrangler dev`, with stand-ins for every outside service). |
| `public/vendor/` | Third-party browser libraries (pinyin-pro, opencc-js), with their licenses. |
| `.github/workflows/deploy.yml` | Runs the tests on every push and pull request; deploys from `main` only. |

Storage: R2 bucket `allegro-music` (`audio/`, `cover/`, `cover-sm/`, `plcover/`, `arphoto/`, `pfphoto/`, `lyrics/`, `lyrics-x/`)
and D1 database `allegro` (`songs`, `kv`, `playlist_versions`, `song_comments`, `profiles`). Workers AI is bound as `AI`.

## Rules

- **Never put secrets in the repo, a commit, a pull request or a chat.** Keys live in Cloudflare (Worker secrets) and
  GitHub (Actions secrets) only.
- **Tests must pass.** Small changes (wording, translations, CSS only) need just `npm run check` (a few seconds:
  script syntax and the translation table). Anything that changes behavior needs the full `npm test`. GitHub runs
  both before every deploy, so nothing reaches the live site untested. Run `npm test` (it starts a local Worker and a headless Chromium). Every new feature gets a
  check in `tests/e2e.mjs`; when you change behavior on purpose, update the check that covers it.
- Keep `public/index.html` a single self-contained file. Libraries go in `public/vendor/` (not from a CDN at runtime).
- **Interface text:** Title Case for buttons and headings, sentence case for messages, and no em dashes anywhere the
  owner can see. Every new piece of interface text also gets Simplified and Traditional Chinese entries in the `I18N`
  table near the top of the script (or a `PAT` pattern for text with numbers or names). Song, artist, album and
  playlist names must never be translated: they sit inside `NO_TR` selectors or `data-nt` elements.
- Look and feel: light and dark themes both work (colors come from CSS variables on `:root`); phones (under 760px)
  have their own layout; respect `prefers-reduced-motion`.
- Deleting anything asks first (`askDelete`) and offers Undo for 15 seconds (`UNDO_MS`).
- Comments explain *why*, in plain words.

## Running it

```sh
npm install
printf 'SETUP_CODE=dev-code\nSESSION_SECRET=dev-secret\n' > .dev.vars
npm run dev          # http://127.0.0.1:8787
npm run check        # fast check for wording, translation and CSS changes (seconds)
npm test             # the full end-to-end suite (several minutes)
```
