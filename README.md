# Dovedale GeoGuesser

A GeoGuesser-style game for the [Dovedale Railway](https://play.dovedale.uk) Roblox game. You are shown a screenshot from somewhere on the railway and have to pin where it was taken on the map.

Play it at [dovedalegeoguesser.com](https://dovedalegeoguesser.com).

## What's in it

- **Solo:** 3, 5 or 10 rounds at your own pace. No login needed.
- **Daily challenge:** one location a day, with a streak to keep going.
- **Duels:** real-time 1v1 by invite link or quick play. Anyone can watch.
- **Tournaments:** knockout brackets for game nights, run by staff. Early rounds can play all at once, then one match at a time so everyone watches the same duel. Spectators can chat, with a word filter and staff moderation.
- **Specials:** side modes, mini-games and seasonal events, just for fun.
- **Leaderboards and profiles:** for solo, duels and the daily.
- **Submissions:** players add their own screenshots and suggest fixes; staff review them.
- **Staff panel:** review queues, tickets, a staff chat, moderation with a full history, and site tools for operators.

## Run it locally

You need [Bun](https://bun.sh).

```bash
bun install
cp .env.example .env
bun run seed
bun run dev
```

Then open `http://localhost:4000`.

Set `AUTH_DEV=true` in `.env` to skip Discord and log in as a built-in operator account. `bun run seed` adds placeholder locations so there is something to play.

| Command             | What it does                                                           |
| ------------------- | ---------------------------------------------------------------------- |
| `bun run dev`       | Start the server and restart on changes                                |
| `bun run test`      | Run the tests, each file on its own throwaway database                 |
| `bun run typecheck` | Type-check the server and tests                                        |
| `bun run build`     | Format the code and compile the stylesheet                             |
| `bun run build:css` | Compile the stylesheet only (run after pulling if pages look unstyled) |
| `bun run vapid`     | Generate keys for push notifications (optional)                        |
| `bun run sync-map`  | Refresh map settings from the Dovedale map                             |
| `bun run tiles`     | Build the map tiles in every size and format (`--force` redoes all)    |

## Configuration

Everything is set in `.env`; `.env.example` explains each option. For a real site you need:

| Variable                | What it is                                             |
| ----------------------- | ------------------------------------------------------ |
| `DISCORD_CLIENT_ID`     | From your Discord OAuth app                            |
| `DISCORD_CLIENT_SECRET` | From your Discord OAuth app                            |
| `DISCORD_REDIRECT_URI`  | Must match the one registered with Discord             |
| `OPERATOR_IDS`          | Discord user IDs with full access, separated by commas |
| `SITE_URL`              | The public address, e.g. `https://example.com`         |

Never set `AUTH_DEV=true` on a live site.

## Deploying

First time:

```bash
bun install
bun run build:css
bun run tiles
pm2 start pm2.config.js
```

After that, run `./deploy.sh`, or use the System tab in the staff panel.

The chat filter downloads word lists from the web (a default list from GitHub is added on first start), so the server needs outgoing HTTPS.

If you sit behind a proxy, it needs to pass WebSocket connections through (duels use them), not buffer `/api/events` (live updates, tournament pages included), and set `X-Forwarded-For`.

> **Upgrading from a version before the restructure?** Do that one deploy by hand, because the old `deploy.sh` will stop partway:
>
> ```bash
> git pull origin main
> bun install
> bun run build:css
> pm2 restart dovedale-geoguesser
> ```
>
> Your database is backed up and upgraded by itself on that first start.

## Looking after it

The server is built to be left running.

- **Upgrades are automatic.** The database updates itself on start, after taking a backup.
- **Backups are automatic.** One a day goes into `data/backups/`, and old ones are cleared out.
- **Restarts are safe.** Solo games carry on afterwards and a running tournament waits for staff to continue; only duels being played are lost.
- **A damaged database stops the server** rather than starting empty. To recover, stop the server, copy the newest backup over `data/geoguesser.sqlite`, delete any `-wal` and `-shm` files beside it, and start again.

Operators also get a **System** tab in the staff panel to switch on maintenance mode, install updates and restart, manage backups, and read the server log.

## Staff roles

Each role can do everything the one above it can. The Staff tab in the staff panel has the full list.

| Role          | Adds                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Helper        | Review submissions and suggested changes. A player, not counted as staff                                                                           |
| Curator       | Browse and edit locations, see every review, staff chat and announcements                                                                          |
| Moderator     | Answer tickets, warn, limit and temporarily ban, review ban-evasion and fair-play flags, run tournaments and their chat                            |
| Supervisor    | Ban permanently, overturn most actions, manage moderators and below, read the audit log, create, start and cancel tournaments, add chat word lists |
| Administrator | Correct scores and ratings, send announcements, delete locations, watch or close duels                                                             |
| Operator      | Everything, including exporting or deleting player data and the System tab. Set in .env                                                            |

## Specials and seasons

Specials are for fun and never count on the leaderboards. Night Shift (around Halloween) and Snowed In (December) come round every year by themselves, and the homepage dresses up for those and a few other dates.

To preview a season on any day, add `?season=halloween` to the homepage address (also `christmas`, `newyear`, `valentines`, `easter`, `bonfire`).

To add a special or change the dates, see `src/specials.ts`.

## How it's built

[Bun](https://bun.sh), [Hono](https://hono.dev), SQLite, [WebWire](https://github.com/Sectly/webwire) for duels, one server-sent event stream per page for live updates, Discord login, and plain JavaScript modules with Tailwind in the browser.

```
server.ts     Entry point
src/          The server: config, database, auth, game logic, routes
public/       Pages and styles; js/ has one module per page, and js/lib/ the parts every page shares
tests/        Test suites
scripts/      Build, seed and map tools
```

Solo, daily, duels, Team Duels and tournaments all run on one round engine (`src/game/round.ts`), so a change to scoring, hints or timing there applies everywhere. Tournaments are built on duels (`src/game/tournaments.ts`). Scores are always worked out on the server, and the answer is only sent once a guess is in.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bugs and ideas are welcome on [GitHub Issues](https://github.com/Sectly/dovedale-geoguesser/issues).

Map data and tiles come from the [Dovedale Live Map](https://github.com/dovedalerailway/dovedale-map). Licensed under the terms in [LICENSE](LICENSE).
