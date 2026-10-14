# Contributing

Thanks for your interest in contributing to Dovedale GeoGuesser.

## How to contribute

1. Fork the repository and create a branch from `main`.
2. Make your changes and test them locally (`bun run dev`, `bun run test`). Set `AUTH_DEV=true` in `.env` to log in without Discord, and run `bun run seed` for placeholder locations.
3. **Format your code** before opening a PR (see below).
4. Open a pull request with a clear description of what you changed and why.

## Code formatting

This project uses [Prettier](https://prettier.io/) to enforce consistent formatting. **All PRs must pass the format check.** Run it before committing:

```bash
bun install          # installs prettier if you haven't already
bun run build        # formats all files and rebuilds the stylesheet (use this before committing)
bun run format       # formats all files in-place
bun run format:check # check only, exits non-zero if anything is unformatted
```

The config is in `.prettierrc`. Tabs, double quotes, semi-colons, 120-char print width. HTML uses 2-space indentation.

## Tests

```bash
bun run test         # each test file gets its own temporary database, never your local one
bun run typecheck
```

Please add or update a test in `tests/` when you change server behaviour.

## Guidelines

- Keep changes focused: one fix or feature per PR.
- Follow the existing code style (TypeScript, Hono, Bun).
- Do not commit `.env` files or any secrets.
- All PRs require approval from [@Sectly](https://github.com/Sectly) before merging.

## Reporting issues

Open a GitHub issue describing the bug or suggestion. Include steps to reproduce for bugs.
