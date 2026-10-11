#!/bin/bash
set -e

# Braces: bash reads the whole block first, so the pull can replace this file mid-run.
{
	git pull origin main
	bun install
	bun run build:css
	pm2 restart dovedale-geoguesser
	exit 0
}
