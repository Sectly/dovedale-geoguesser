# Dovedale GeoGuesser

A GeoGuesser-style game for the [Dovedale Railway](https://play.dovedale.uk) Roblox game. Players identify locations across the railway from in-game screenshots, compete on leaderboards, and challenge friends to real-time duels.

Hosted at [dovedalegeoguesser.com](https://dovedalegeoguesser.com).

Source: [github.com/Sectly/dovedale-geoguesser](https://github.com/Sectly/dovedale-geoguesser)

## Features

- **Solo play** - 5 rounds, 90 seconds each, no login required
- **Daily challenge** - one location per day with streak tracking
- **Duels** - real-time 1v1 location guessing via shareable room links
- **Leaderboards** - solo, duels, and daily rankings
- **Location submissions** - upload new screenshots with map pins; suggest hints, corrections, or new screenshots for existing locations
- **Moderation** - admin panel with location approval, user bans, suggestion review, and support tickets
- **Profiles** - public player profiles with stats; shareable via `/u/:username`

## Stack

- **Runtime:** [Bun](https://bun.sh)
- **Framework:** [Hono](https://hono.dev)
- **Realtime:** [WebWire](https://github.com/webwirejs/webwire) (duel rooms)
- **Database:** SQLite via `bun:sqlite`
- **Auth:** Discord OAuth 2.0
- **Images:** [sharp](https://sharp.pixelplumbing.com) - upload validation, WebP conversion, OG image generation

## Setup

```bash
bun install
cp .env.example .env
# fill in .env values
bun run dev
```

Visit `http://localhost:4000`.

## Environment variables

See `.env.example` for all options. Required for production:

| Variable                | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `DISCORD_CLIENT_ID`     | Discord OAuth app client ID                             |
| `DISCORD_CLIENT_SECRET` | Discord OAuth app client secret                         |
| `DISCORD_REDIRECT_URI`  | Must match what's registered in the Discord dev portal  |
| `OPERATOR_IDS`          | Comma-separated Discord user IDs with full admin access |
| `SITE_URL`              | Public-facing URL (used for OG image embeds)            |

## Map tiles

The interactive map uses 16 PNG tiles in `public/images/`. On startup, `tile-images.ts` generates medium and low quality WebP variants into `public/images/generated/` for adaptive loading.

## Deployment

```bash
pm2 start pm2.config.js
```
