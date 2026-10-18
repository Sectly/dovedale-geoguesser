#!/bin/bash
set -e

# Braces: bash reads the whole block first, so the pull can replace this file mid-run.
{
	git pull origin main
	bun install
	bun run build:css
	bun run tiles
	bun run icons
	pm2 sendSignal SIGUSR2 dovedale-geoguesser || pm2 restart dovedale-geoguesser
	exit 0
}
