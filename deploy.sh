#!/bin/bash
set -e

# Braces: bash reads the whole block first, so the pull can replace this file mid-run.
{
	git pull origin main
	bun install
	bun run build:css
	# Ask the server to restart itself: players get a countdown and open games are closed first.
	# PM2 starts it again when it exits. Falls back to a plain restart if the signal cannot be sent.
	pm2 sendSignal SIGUSR2 dovedale-geoguesser || pm2 restart dovedale-geoguesser
	exit 0
}
