# Working on Allegro (notes for AI coding agents)

Two AI agents work on this repo for the owner: **Claude** (Anthropic) and **ChatGPT / Codex** (OpenAI).
These notes keep us from stepping on each other. Read them before changing anything.

## Who works where

- **Claude** commits straight to `main` (every push runs the tests and deploys).
- **ChatGPT / Codex** works on its own branch and opens a **pull request** into `main`. The tests run on the pull
  request too; the owner merges it once they pass. Nothing on a branch goes live until it is merged.
- Before starting, pull the latest `main`. Before opening a pull request, merge or rebase on the latest `main` so it
  includes the other agent's work.
- Keep each change to one feature or fix. Small pull requests are easy to merge; big ones collide.
- If a task touches the same area someone else is changing (an open pull request, or recent commits), say so to the
  owner instead of guessing.

## The project

A private, single-user music website, in the style of Spotify and Tidal. Live at https://allegro.allegro-music.workers.dev

| Path | What it is |
|---|---|
| `public/index.html` | The whole web app: one file of HTML, CSS and vanilla JavaScript, no build step and no framework. |
| `src/worker.js` | The Cloudflare Worker behind `/api/*`: login, uploads, streaming, library sync, lookups, lyrics, AI. |
| `migrations/` | D1 (SQLite) schema. Add a new numbered file for changes; never edit an old one. |
| `tests/e2e.mjs` | End-to-end tests (Playwright + `wrangler dev`, with stand-ins for every outside service). |
| `public/vendor/` | Third-party browser libraries (pinyin-pro, opencc-js), with their licenses. |
| `.github/workflows/deploy.yml` | Runs the tests on every push and pull request; deploys from `main` only. |

Storage: R2 bucket `allegro-music` (`audio/`, `cover/`, `cover-sm/`, `plcover/`, `arphoto/`, `lyrics/`, `lyrics-x/`)
and D1 database `allegro` (`songs`, `kv`, `playlist_versions`, `song_comments`). Workers AI is bound as `AI`.

## Rules

- **Never put secrets in the repo, a commit, a pull request or a chat.** Keys live in Cloudflare (Worker secrets) and
  GitHub (Actions secrets) only.
- **Tests must pass.** Run `npm test` (it starts a local Worker and a headless Chromium). Every new feature gets a
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
npm test             # the full end-to-end suite (about 8 minutes)
```
