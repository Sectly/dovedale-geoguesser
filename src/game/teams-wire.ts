import { WebWireServer, type WireConnection } from "@webwirejs/server";
import { sessionIdFromCookies, userFromSessionId } from "../auth/sessions";
import { HttpError } from "../lib/http";
import { liveSpecial } from "../specials";
import { onTeamRoomChanged, setTeamPresence, teamRoomStateFor } from "./teams";

/** Team Duels socket: actions stay on the REST routes, and each page is sent its room's state whenever it changes. */

type WireAuth = { userId: number | null };

type Watcher = { code: string; userId: number; here: boolean };

export const teamWireServer = new WebWireServer({
	authenticate: async ({ request }: { request?: unknown }): Promise<WireAuth> => {
		const cookies = request instanceof Request ? request.headers.get("Cookie") : null;
		const user = userFromSessionId(sessionIdFromCookies(cookies));
		const allowed = user && !user.is_banned && !user.duel_limited && liveSpecial("teams", user);
		return { userId: allowed ? user.id : null };
	},
});

const watchers = new Map<WireConnection, Watcher>();

function sendState(conn: WireConnection, watcher: Watcher) {
	try {
		conn.emit("team_state", teamRoomStateFor(watcher.code, watcher.userId));
	} catch (err) {
		if (!(err instanceof HttpError)) return console.error("[teams] Could not send room state:", err);
		forget(conn);
		try {
			conn.emit("team_closed", { message: err.message });
		} catch {}
	}
}

function forget(conn: WireConnection) {
	const watcher = watchers.get(conn);
	if (!watcher) return;
	watchers.delete(conn);
	if (watcher.here) setTeamPresence(watcher.code, watcher.userId, false);
}

onTeamRoomChanged((code) => {
	for (const [conn, watcher] of watchers) if (watcher.code === code) sendState(conn, watcher);
});

teamWireServer.on("connection", (conn: WireConnection) => {
	const userId = (conn.auth as WireAuth | null)?.userId ?? null;

	conn.on("team_watch", (data: unknown) => {
		const body = data as { room?: unknown; here?: unknown } | null;
		if (userId === null || typeof body?.room !== "string") return;
		forget(conn);
		const watcher = { code: body.room.toUpperCase(), userId, here: body.here !== false };
		watchers.set(conn, watcher);
		if (watcher.here) setTeamPresence(watcher.code, userId, true);
		sendState(conn, watcher);
	});

	/** The page was hidden or shown again; a hidden page does not keep its player from being away. */
	conn.on("team_here", (data: unknown) => {
		const watcher = watchers.get(conn);
		const here = (data as { here?: unknown } | null)?.here === true;
		if (!watcher || watcher.here === here) return;
		watcher.here = here;
		setTeamPresence(watcher.code, watcher.userId, here);
	});

	conn.on("disconnect", () => forget(conn));
});
