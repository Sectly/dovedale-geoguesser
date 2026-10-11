# Dovedale GeoGuesser

A GeoGuesser-style game for the [Dovedale Railway](https://play.dovedale.uk) Roblox game. Players identify locations across the railway from in-game screenshots, compete on leaderboards, and challenge friends to real-time duels.

Hosted at [dovedalegeoguesser.com](https://dovedalegeoguesser.com).

Source: [github.com/Sectly/dovedale-geoguesser](https://github.com/Sectly/dovedale-geoguesser)

## Features

- **Solo play:** 3, 5 or 10 rounds with a time limit of your choice, no login required
- **Daily challenge:** One location per day with streak tracking
- **Duels:** Real-time 1v1 location guessing via shareable room links, with spectating and a list of live duels
- **Specials:** A login-only hub of side modes, mini-games and seasonal events (see below)
- **Leaderboards:** Solo, duels, and daily rankings
- **Location submissions:** Upload new screenshots with map pins; suggest hints, corrections, or new screenshots for existing locations
- **Moderation:** Staff panel with location approval, suggestion review, tickets, and a per-user moderation history where every warning, limit and ban carries a reason and can be overturned
- **Notifications:** An inbox for submission, suggestion, ticket and moderation updates, with badges in the header; staff see what is waiting for review
- **Sound effects:** Generated in the browser, on by default, switchable in settings
- **Profiles:** Public player profiles with stats; shareable via `/u/:username`

### Specials

Everything in Specials is for fun: nothing counts on the leaderboards, and anything can change or go.

| Special       | What it is                                                               | When                |
| ------------- | ------------------------------------------------------------------------ | ------------------- |
| Team Duels    | Two against two; a team scores its best guess and sees each other's pins | Always              |
| Blitz         | Five rounds of fifteen seconds with a time bonus                         | Always              |
| Memory Match  | Find the pairs of screenshots                                            | Always              |
| Signal Reflex | A reaction-time game                                                     | Always              |
| Night Shift   | The screenshot is dark apart from a torch that follows the pointer       | 24 October to 2 Nov |
| Snowed In     | The screenshot is under snow, and only so much can be wiped away         | 1 December to 5 Jan |

Seasonal events come round every year by themselves. Before one starts it is listed as "Starts in
N days", and staff can already play it.

The homepage (and only the homepage) also dresses up for the time of year, behind the page content:
New Year and Bonfire Night (fireworks), Valentine's Day (hearts), Easter (eggs; the date is worked out
each year), Halloween (bats and pumpkins) and Christmas (snow). When a seasonal special is running it
gets a card there too. A short tilted line on the title ("Happy Halloween!") says why, and the title
takes the season's colours. It all follows the calendar; nothing has to be switched on. The dates are `SEASONS` in `src/specials.ts`, the drawings are in
`public/js/home.js` and `public/css/seasonal.css`, and `/?season=easter` (or any other theme) previews
one on any day.

To add a special, add an entry to `SPECIALS` in `src/specials.ts`. A twist on solo only needs its
rules in `SPECIAL_MODES` (and optionally an `effect` drawn by `public/js/photo-effects.js`); anything
else points at its own page.

### Staff roles

| Role       | Can do                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Moderator  | Review submissions and suggestions, answer tickets, warn, limit and temporarily ban                                                                |
| Supervisor | The above, plus permanent bans, overturning warnings, limits and temporary bans, appointing moderators, the audit log, and locking a moderator out |
| Operator   | Everything, plus overturning permanent bans, deleting records, correcting or resetting a player's scores, and the System tab                       |

Operators are set with `OPERATOR_IDS`. Locking a member of staff out suspends their panel access and
staff powers at once (for a compromised or misused account) without removing their role.

## Stack

- **Runtime:** [Bun](https://bun.sh)
- **Framework:** [Hono](https://hono.dev)
- **Realtime:** [WebWire](https://github.com/Sectly/webwire) (duel rooms)
- **Database:** SQLite via `bun:sqlite`
- **Auth:** Discord OAuth 2.0
- **Images:** [sharp](https://sharp.pixelplumbing.com) for upload validation, WebP conversion, OG image generation

## Setup

```bash
bun install
cp .env.example .env
# fill in .env values, or set AUTH_DEV=true to skip Discord locally
bun run seed   # optional: placeholder locations for an empty local database
bun run dev
```

Visit `http://localhost:4000`.

| Command             | What it does                                                     |
| ------------------- | ---------------------------------------------------------------- |
| `bun run dev`       | Start the server and restart on changes                          |
| `bun test`          | Run the test suite against a throwaway database                  |
| `bun run typecheck` | Type-check the server and tests                                  |
| `bun run build`     | Format with Prettier, compile the stylesheet, make the app icons |
| `bun run build:css` | The same without formatting (what deploys run)                   |
| `bun run format`    | Format everything with Prettier                                  |
| `bun run vapid`     | Generate Web Push keys for `.env`                                |
| `bun run seed`      | Add placeholder locations to an empty database                   |
| `bun run sync-map`  | Refresh map settings from the upstream Dovedale map              |

### Styles

Pages use Tailwind classes. `bun run build` compiles just the classes in use into
`public/css/tailwind.css`, which is a build product and is not committed. The server builds it on
startup if it is missing, and rebuilds on change while `AUTH_DEV=true`.

### Push notifications (optional)

Run `bun run vapid` and put the two keys in `.env`. With them set, players who switch on desktop
notifications receive them even when the site is closed. Without them, desktop notifications only
appear while a tab is open.

## Project layout

```
server.ts              Entry point: startup tasks, then serves src/app.ts
src/
  app.ts               Assembles the Hono app: headers, maintenance mode, routes, error pages
  config.ts            Environment, paths, limits and game rules in one place
  db.ts                SQLite connection, schema, migrations and the pre-upgrade backup
  backups.ts           Database backups and their limits
  moderation.ts        Warnings, limits and bans: one record per action
  evasion.ts           Flags accounts that may belong to a banned player, for staff to judge
  notifications.ts     Per-user inbox, preferences and the staff review queue counts
  specials.ts          The Specials registry, seasons and special solo rules
  push.ts              Web Push delivery (optional)
  styles.ts            Compiles the Tailwind stylesheet
  auth/                Discord OAuth, sessions, role guards
  game/
    round.ts           The shared round engine: clock, hints, scoring
    solo.ts            Solo: a run of rounds, held in memory
    daily.ts           Daily: one persisted round per player per day
    duels/             Duels: rooms, matchmaking and the WebSocket handlers
    teams.ts           Team Duels: polled rooms on a server-side clock
  routes/              One file per feature; routes/admin/ for the staff panel
  system/              Maintenance mode and the panel updater
  lib/                 Small helpers: HTTP, uploads, rate limits, audit log, webhook, server log
  jobs/cleanup.ts      Periodic pruning, daily backups and in-memory housekeeping
public/
  *.html               Pages (no build step)
  css/shared.css       Styles shared by every page
  css/seasonal.css     Homepage decoration for seasonal events
  js/shared.js         Header, account area, API client, toasts
  js/sounds.js         Sound effects, synthesised with Web Audio
  js/round.js          The round screen used by solo, daily, duels and team duels
  js/map-canvas.js     The interactive map
  js/<page>.js         One script per page; js/admin/ for the staff panel
tests/                 bun:test suites that call the app in-process, plus an upgrade test
```

### How the game modes fit together

Solo, daily and duels all play the same thing: a `Round` from `src/game/round.ts`. A round owns the
location, the clock (including pausing and waiting for the screenshot to load), the hints and the
scoring. Each mode is a thin layer on top with its own rules:

- **Solo** runs several rounds in a row for one player and saves the total if they are logged in.
- **Daily** is a single round whose start time and hints are stored, so a reload resumes it.
- **Duels** run each round for two players at once, add a time bonus, and handle disconnects by
  pausing the duel until the player is back.

Changing how scoring, hints or timing work means changing `round.ts` (or the rule sets at the bottom
of it), and every mode picks it up. The browser mirrors this with `public/js/round.js`.

Scores are always computed on the server. The correct position is only sent once a guess is in.

## Environment variables

See `.env.example` for all options. Required for production:

| Variable                | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `DISCORD_CLIENT_ID`     | Discord OAuth app client ID                             |
| `DISCORD_CLIENT_SECRET` | Discord OAuth app client secret                         |
| `DISCORD_REDIRECT_URI`  | Must match what's registered in the Discord dev portal  |
| `OPERATOR_IDS`          | Comma-separated Discord user IDs with full admin access |
| `SITE_URL`              | Public-facing URL; also switches on Secure cookies/HSTS |

Optional: `DISCORD_WEBHOOK_URL` and `WEBHOOK_EVENTS` (staff notifications in Discord), `VAPID_*`
(push notifications), `DATA_DIR` and `UPLOADS_DIR` (where data lives), `PANEL_UPDATES` and
`UPDATE_BRANCH` (updates from the staff panel). Never set `AUTH_DEV=true` in production: it replaces
Discord login with a built-in operator account.

## Map tiles

The interactive map uses 16 PNG tiles in `public/images/`. On startup, `src/tile-images.ts` generates
medium and low quality WebP variants into `public/images/generated/` for adaptive loading.

## Deployment

First time:

```bash
bun install
bun run build:css
pm2 start pm2.config.js
```

After that, `./deploy.sh` pulls, installs, rebuilds the stylesheet and restarts. Operators can do the
same from the System tab of the staff panel.

The lockfile is not tracked, so installs do not use `--frozen-lockfile`.

**Coming from a release before the restructure:** do that one deploy by hand, because the old
`deploy.sh` stops at its frozen install (this release adds dependencies):

```bash
git pull origin main
bun install
bun run build:css
pm2 restart dovedale-geoguesser
```

The database is backed up and upgraded on that first start; nothing else needs doing. The data
(`data/`) and screenshots (`public/uploads/`) stay where they are.

Behind a proxy, make sure it passes WebSocket upgrades for `/api/duels/wire` and sets
`X-Forwarded-For` (or `CF-Connecting-IP`), which the rate limits use.

### Upgrading and backups

The database upgrades itself when the server starts. Nothing needs to be run by hand.

- **Backups** live in `data/backups/` and are trimmed automatically: the last 7 daily (`daily-…`), 3 made before a release changes existing data (`upgrade-…`), 3 made before a panel update (`update-…`) and 5 made by hand (`manual-…`).
- **Before an upgrade:** if the backup cannot be made, the server stops without changing anything.
- **Damaged database:** the server refuses to start rather than begin with an empty one. Restore the newest backup over `data/geoguesser.sqlite`, or move the damaged file away to start empty.
- **Restarts:** the server can be stopped or killed at any time. Games in progress are lost (unfinished duels are marked abandoned); accounts, scores and everything else in the database are not.

To restore a backup, stop the server, copy the backup over `data/geoguesser.sqlite`, delete any `geoguesser.sqlite-wal` and `-shm` files beside it, and start again.

### The System tab (operators)

The staff panel has a System tab that only operators can open:

- **Maintenance mode:** locks everyone but staff out and shows them a maintenance screen with your message. It survives restarts.
- **Updates:** lists the commits waiting on `origin/main` (change the branch with `UPDATE_BRANCH`). "Update and restart" backs up the database, fast-forwards, installs dependencies, rebuilds the stylesheet and restarts. It refuses to run if files on the server were edited by hand. Restarting needs PM2. Set `PANEL_UPDATES=off` to remove the feature.
- **Backups:** make, download and delete backups. Downloads are recorded in the audit log.
- **Server log:** warnings and errors from the server, kept for 30 days (3,000 entries at most).
