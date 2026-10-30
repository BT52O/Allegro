# Allegro

A private, single-user music library for your own audio files, in the style of Spotify. It runs entirely on Cloudflare's free tier.

**Live:** https://allegro.allegro-music.workers.dev

## Stack

| Part | What it is |
|---|---|
| `public/index.html` | The whole web app: vanilla JS, no build step. Playback, library views, playlists, queue, ID3 tag reading, uploads. |
| `src/worker.js` | Cloudflare Worker serving `/api/*`: password login, uploads, streaming with byte ranges, library sync. |
| R2 bucket `allegro-music` | Song files (`audio/<id>`), embedded album art (`cover/<id>`), playlist photos (`plcover/<id>`). |
| D1 database `allegro` | `songs` (metadata per song) and `kv` (password hash, playlists and likes). Schema lives in `migrations/`. |

Limits: 100 MB per song file (Cloudflare's request size on the free plan), 10 MB per image, 10 GB of R2 storage free.

## Deploying

Every push to `main` runs the end-to-end tests and, if they pass, applies D1 migrations and deploys with Wrangler (`.github/workflows/deploy.yml`).

The workflow needs two repository secrets (**Settings > Secrets and variables > Actions**):

- `CLOUDFLARE_API_TOKEN`: a token made from the **Edit Cloudflare Workers** template, plus **Account > D1 > Edit**.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.

The Worker's own secrets (`SESSION_SECRET`, `SETUP_CODE`) live in Cloudflare and are not in this repo. Set them once with `npx wrangler secret put <NAME>`; deploys leave them alone.

## Local development

```sh
npm install
printf 'SETUP_CODE=dev-code\nSESSION_SECRET=dev-secret\n' > .dev.vars
npm run dev            # local Worker with local R2 + D1 at http://127.0.0.1:8787
```

On first visit, enter the setup code from `.dev.vars` and choose a password.

## Tests

```sh
npx playwright install chromium
npm test
```

`tests/e2e.mjs` starts the Worker locally with throwaway storage and drives Chromium through setup, sign-in, MP3 upload with tag reading, streaming, two-device sync, playlist editing and reordering, removal, and the sign-in requirement on every API route.
