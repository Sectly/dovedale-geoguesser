#!/bin/bash
set -e

git pull origin main
bun install --frozen-lockfile
pm2 restart dovedale-geoguesser
