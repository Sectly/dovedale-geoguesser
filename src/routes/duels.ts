import { Hono } from "hono";
import type { Context } from "hono";
import { createBunWebSocket } from "hono/bun";
import { webwire } from "@webwirejs/hono";
import type { User } from "../db";
import { GAME } from "../config";
import { requirePlayer, requireUser } from "../auth/guards";
import { cancelQuickplay, quickplay } from "../game/duels/matchmaking";
import { createRoom, duelRooms, joinRoom, liveDuels } from "../game/duels/rooms";
import { db } from "../db";
import { wireServer } from "../game/duels/wire";
import { auditLog } from "../lib/audit";
import { clampInt, fail, idParam, readJson } from "../lib/http";
import { requireFeature } from "../system/features";
import { checkUserRateLimit } from "../lib/rate-limit";
import { HOUR } from "../lib/time";
import { displayName, notify } from "../lib/webhook";

export const { upgradeWebSocket, websocket } = createBunWebSocket();

export const duelRoutes = new Hono();

function requireDuelist(c: Context): User {
	const user = requirePlayer(c);
	if (user.duel_limited) fail(403, "Your duel ability has been temporarily limited");
	return user;
}

const NEW_DUELS_OFF = "New duels are paused for now. Please try again later.";

const canCreateRoom = (user: User) => checkUserRateLimit(user, "room", 10, HOUR * 1000);

/** The server sets the length, so a page loaded before a change cannot queue for one nobody else is in. */
duelRoutes.post("/quickplay", (c) => {
	const user = requireDuelist(c);
	requireFeature("new_duels", user, NEW_DUELS_OFF);
	const match = quickplay(user, GAME.duel.quickplayRounds, () => canCreateRoom(user));
	if (!match) fail(429, "Too many rooms created. Try again later.");
	return c.json(match);
});

duelRoutes.delete("/quickplay", (c) => {
	cancelQuickplay(requireUser(c).id);
	return c.json({ success: true });
});

duelRoutes.post("/rooms", async (c) => {
	const user = requireDuelist(c);
	requireFeature("new_duels", user, NEW_DUELS_OFF);
	if (!canCreateRoom(user)) fail(429, "Too many rooms created. Try again later.");
	const body = await readJson<{ rounds: number; listed: boolean }>(c);
	const rounds = clampInt(body.rounds, GAME.duel.defaultRounds, GAME.duel.minRounds, GAME.duel.maxRounds);
	const room = createRoom(user.id, rounds, false, body.listed === true);
	auditLog(user, "duel_room_create", {
		targetType: "duel",
		targetId: room.dbId,
		details: `${room.code}, ${room.rounds} rounds`,
	});
	notify(
		"duels",
		`**Duel room created**: \`${room.code}\` by **${displayName(user)}** (${room.rounds} rounds)`,
		"/admin#duels"
	);
	return c.json({ code: room.code });
});

duelRoutes.post("/rooms/:code/join", (c) => {
	const user = requireDuelist(c);
	const code = c.req.param("code").toUpperCase();
	const room = duelRooms.get(code);
	if (room?.quickplay && !room.players.some((p) => p.userId === user.id))
		fail(409, "Quick Play duels can't be joined by code, but you can watch them.");

	const result = joinRoom(code, user.id);
	if (result === "not_found") fail(404, "Room not found. Check the code and try again.");
	if (result === "gone") fail(410, "This room has closed.");
	if (result === "full") fail(409, "Room is full");
	if (result === "in_progress") fail(409, "Game already in progress");
	if (room) auditLog(user, "duel_join", { targetType: "duel", targetId: room.dbId, details: `joined room ${code}` });
	return c.json({ success: true });
});

duelRoutes.get("/live", (c) => c.json(liveDuels()));

/** Round-by-round results of a finished duel. No guess positions: only how each player scored. */
duelRoutes.get("/history/:id", (c) => {
	const gameId = idParam(c);
	const game = db
		.query<
			{ id: number; rounds: number; finished_at: number | null; winner_id: number | null; quickplay: number },
			[number]
		>("SELECT id, rounds, finished_at, winner_id, quickplay FROM duel_games WHERE id = ? AND status = 'finished'")
		.get(gameId);
	if (!game) fail(404, "Duel not found");
	const rows = db
		.query(
			`SELECT rs.round_number, rs.score, ROUND(rs.distance) AS distance, rs.time_taken,
				u.username, u.display_name, l.label
			FROM duel_round_scores rs
			JOIN users u ON u.id = rs.user_id
			LEFT JOIN locations l ON l.id = rs.location_id
			WHERE rs.game_id = ? ORDER BY rs.round_number, rs.score DESC`
		)
		.all(gameId);
	return c.json({ ...game, rounds_played: rows });
});

duelRoutes.route("/wire", webwire(wireServer, upgradeWebSocket));
