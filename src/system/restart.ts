import { GAME } from "../config";
import { db } from "../db";
import {
	activeDuelRooms,
	broadcastToDuels,
	closeAllDuels,
	duelsInProgress,
	setDuelsClosing,
} from "../game/duels/rooms";
import { saveSoloGames } from "../game/solo";
import { closeTeamRooms, teamGamesInProgress, teamRoomCount } from "../game/teams";
import { shutdown } from "../lib/lifecycle";
import { logInfo } from "../lib/logs";

/** A planned restart is announced first, then games close, solo games are saved and the process exits. */

const CLOSED_MESSAGE = "The server restarted for an update, so your game was ended. It won't count against you.";
/** Long enough for the goodbye messages to leave before the sockets go down with the process. */
const FLUSH_MS = 400;

/** Left in the database by a clean stop, so the next start knows it follows a planned restart. */
const CLEAN_STOP_KEY = "clean_stop";
/** How long after coming back the server keeps saying it has just restarted. */
const BACK_NOTICE_MS = 3 * 60 * 1000;

/** When this process started, if it follows a clean stop moments ago. Lets pages explain a restart. */
const startedAfterRestart = (() => {
	try {
		const row = db
			.query<{ value: string }, [string]>("SELECT value FROM app_settings WHERE key = ?")
			.get(CLEAN_STOP_KEY);
		if (!row) return null;
		db.run("DELETE FROM app_settings WHERE key = ?", [CLEAN_STOP_KEY]);
		return Date.now() - Number(row.value) < 5 * 60 * 1000 ? Date.now() : null;
	} catch {
		return null;
	}
})();

/** An id for the restart this server just came back from, for a few minutes; null otherwise. */
export function justRestarted(): number | null {
	return startedAfterRestart !== null && Date.now() - startedAfterRestart < BACK_NOTICE_MS
		? startedAfterRestart
		: null;
}

let restartChanged: (() => void) | null = null;
/** Called when a restart is announced, brought forward or called off. */
export function onRestartChanged(fn: () => void) {
	restartChanged = fn;
}

let dueAt: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Watches for the last game to finish during a long notice, so the restart need not wait it out. */
let watcher: ReturnType<typeof setInterval> | null = null;
const WATCH_MS = 2000;
let stopping = false;

export function restartIn(): number | null {
	return dueAt === null ? null : Math.max(0, Math.ceil((dueAt - Date.now()) / 1000));
}

/** Routes that would begin a multiplayer game nobody could finish before the restart. */
const GAME_STARTS = new Set(["/api/duels/rooms", "/api/duels/quickplay", "/api/teams/rooms"]);
const TEAM_GAME_START = /^\/api\/teams\/rooms\/[^/]+\/(start|again)$/;

export function blockedByRestart(method: string, path: string): boolean {
	return dueAt !== null && method === "POST" && (GAME_STARTS.has(path) || TEAM_GAME_START.test(path));
}

/** Announces a restart and carries it out. Returns the seconds of notice given. */
export function scheduleRestart(reason: string): number {
	const pending = restartIn();
	if (pending !== null) return pending;
	const busy = activeDuelRooms() + teamRoomCount() > 0;
	const seconds = busy ? GAME.restart.notice : GAME.restart.quietNotice;
	logInfo(`[server] Restarting in ${seconds}s: ${reason}`);
	setDuelsClosing(true);
	setDeadline(seconds, reason);
	/** No new game can start now, so once the current ones end there is nothing to wait for. */
	if (busy) {
		watcher = setInterval(() => {
			if (duelsInProgress() + teamGamesInProgress() > 0) return;
			stopWatching();
			if ((restartIn() ?? 0) > GAME.restart.quietNotice) {
				logInfo("[server] Every game has finished; restarting early");
				setDeadline(GAME.restart.quietNotice, reason);
			}
		}, WATCH_MS);
	}
	return seconds;
}

/** Sets (or brings forward) the moment of the restart and tells everyone in a duel room. */
function setDeadline(seconds: number, reason: string) {
	if (timer) clearTimeout(timer);
	dueAt = Date.now() + seconds * 1000;
	broadcastToDuels("server_restarting", { seconds });
	restartChanged?.();
	timer = setTimeout(() => stopCleanly(reason), seconds * 1000);
}

function stopWatching() {
	if (watcher) clearInterval(watcher);
	watcher = null;
}

/** Calls off an announced restart. Returns false when there was none. */
export function cancelRestart(): boolean {
	if (dueAt === null || stopping) return false;
	if (timer) clearTimeout(timer);
	timer = null;
	stopWatching();
	dueAt = null;
	setDuelsClosing(false);
	broadcastToDuels("server_restart_cancelled", {});
	restartChanged?.();
	logInfo("[server] The planned restart was called off");
	return true;
}

/** Closes every game, tells the players, and exits. Also used when the host stops us without warning. */
export function stopCleanly(reason: string) {
	if (stopping) return;
	stopping = true;
	stopWatching();
	dueAt ??= Date.now();
	try {
		closeAllDuels(CLOSED_MESSAGE);
		closeTeamRooms();
		saveSoloGames();
		db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)", [CLEAN_STOP_KEY, String(Date.now())]);
	} catch (err) {
		console.error("[server] Could not put every game away before stopping:", err);
	}
	setTimeout(() => shutdown(reason), FLUSH_MS);
}
