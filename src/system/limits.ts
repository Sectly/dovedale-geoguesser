import { readFileSync } from "fs";
import { GAME } from "../config";

/** Files kept free for everything but spectators. */
const RESERVED_FILES = 256;

/** Soft limit from /proc/<pid>/limits; Infinity when unlimited. */
export function parseOpenFileLimit(limits: string): number | null {
	const line = limits.split("\n").find((l) => l.startsWith("Max open files"));
	const soft = line?.split(/\s{2,}/)[1]?.trim();
	if (!soft) return null;
	if (soft === "unlimited") return Infinity;
	const n = Number(soft);
	return Number.isFinite(n) ? n : null;
}

let fileLimit: number | null | undefined;

/** Null off Linux. */
export function openFileLimit(): number | null {
	if (fileLimit !== undefined) return fileLimit;
	try {
		fileLimit = parseOpenFileLimit(readFileSync("/proc/self/limits", "utf8"));
	} catch {
		fileLimit = null;
	}
	return fileLimit;
}

/** The configured cap, lowered to fit the file limit (two files per spectator). */
export function spectatorCap(limit = openFileLimit()): number {
	if (limit === null) return GAME.tournament.maxSpectators;
	return Math.max(0, Math.min(GAME.tournament.maxSpectators, Math.floor((limit - RESERVED_FILES) / 2)));
}

export function spectatorCapNote(limit = openFileLimit()): { title: string; detail: string } | null {
	const cap = spectatorCap(limit);
	if (limit === null || cap >= GAME.tournament.maxSpectators) return null;
	const needed = GAME.tournament.maxSpectators * 2 + RESERVED_FILES;
	return {
		title: `Up to ${cap.toLocaleString("en-GB")} spectators per tournament`,
		detail: `Set by the open file limit (${limit.toLocaleString("en-GB")}). Raising it to ${needed.toLocaleString("en-GB")} or more (LimitNOFILE in the process manager's systemd unit, then a restart) allows the full ${GAME.tournament.maxSpectators.toLocaleString("en-GB")}.`,
	};
}
