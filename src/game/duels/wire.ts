import { WebWireServer, type WireConnection } from "@webwirejs/server";
import { db } from "../../db";
import { GAME } from "../../config";
import { sessionIdFromCookies, userFromSessionId } from "../../auth/sessions";
import { parseGuess } from "../round";
import { leaveQuickplayRoom, markConnected } from "./matchmaking";
import { winStreak } from "./rating";
import {
	abandonDuel,
	broadcast,
	broadcastState,
	cancelCountdown,
	createRoom,
	duelRooms,
	isParticipant,
	joinRoom,
	playerDisconnected,
	playerLoaded,
	playerReconnected,
	previewPin,
	send,
	sendCrowdEmote,
	sendEmote,
	sendSnapshot,
	sendToSpectators,
	startDuel,
	submitGuess,
	type DuelPlayer,
	type DuelRoom,
} from "./rooms";

/** How long a player in a waiting room may be disconnected before losing their seat. */
const RECONNECT_GRACE_MS = 30_000;
const REMATCH_TIMEOUT_MS = 30_000;
const QUICKPLAY_START_DELAY_MS = 1000;

type WireAuth = { userId: number | null };

/** Spectators may be anonymous; only logged-in, unbanned users get a user id. */
export const wireServer = new WebWireServer({
	authenticate: async ({ request }: { request?: unknown }): Promise<WireAuth> => {
		const cookies = request instanceof Request ? request.headers.get("Cookie") : null;
		const user = userFromSessionId(sessionIdFromCookies(cookies));
		return { userId: user && !user.is_banned ? user.id : null };
	},
});

const rooms = new WeakMap<WireConnection, DuelRoom>();

function reject(conn: WireConnection, message: string) {
	send(conn, "rejected", { message });
	conn.close(1008, message);
}

function handler<T>(name: string, fn: (data: T) => void): (data: T) => void {
	return (data) => {
		try {
			fn(data);
		} catch (err) {
			console.error(`[duels] Error in "${name}" handler:`, err);
		}
	};
}

function roomCode(data: unknown): string {
	const code = (data as { room?: unknown } | null)?.room;
	return typeof code === "string" ? code.toUpperCase() : "";
}

function clearRematch(room: DuelRoom) {
	if (room.rematchTimer) clearTimeout(room.rematchTimer);
	room.rematchTimer = null;
	room.rematchRequests.clear();
}

wireServer.on("connection", (conn: WireConnection) => {
	const userId = (conn.auth as WireAuth | null)?.userId ?? null;

	function seat(): { room: DuelRoom; player: DuelPlayer } | null {
		const room = rooms.get(conn);
		const player = room?.players.find((p) => p.conn === conn);
		return room && player ? { room, player } : null;
	}

	conn.on(
		"join",
		handler("join", (data) => {
			if (userId === null) return reject(conn, "Log in to play duels");
			const room = duelRooms.get(roomCode(data));
			if (!room) return reject(conn, "Room not found");
			if (room.status === "finished") return reject(conn, "Game already finished");
			if (!isParticipant(room, userId)) return reject(conn, "You haven't joined this room");

			const existing = room.players.find((p) => p.userId === userId);
			if (existing) {
				/** A second tab or a reconnect takes over the seat; the old socket just goes quiet. */
				if (existing.conn !== conn)
					send(existing.conn, "rejected", { message: "You joined this duel from another tab or device." });
				existing.conn = conn;
				existing.connected = true;
			} else {
				if (room.status !== "waiting") return reject(conn, "Game already in progress");
				if (room.players.length >= 2) return reject(conn, "Room is full");
				const user = db
					.query<{ username: string; display_name: string | null; avatar_url: string | null }, [number]>(
						"SELECT username, display_name, avatar_url FROM users WHERE id = ?"
					)
					.get(userId);
				if (!user) return reject(conn, "Account not found");
				/** The creator always takes the host seat, whoever happens to connect first. */
				room.players[userId === room.creatorId ? "unshift" : "push"]({
					userId,
					username: user.username,
					displayName: user.display_name || user.username,
					avatarUrl: user.avatar_url || "",
					conn,
					connected: true,
					disconnects: 0,
					totalScore: 0,
					streak: room.quickplay ? winStreak(userId) : 0,
				});
			}
			rooms.set(conn, room);
			markConnected(userId);
			broadcastState(room);
			sendSnapshot(room, conn, userId);
			playerReconnected(room);

			/** Quick Play and tournament rooms have no host to press start. */
			if ((room.quickplay || room.tournament) && room.status === "waiting" && room.players.length === 2) {
				setTimeout(() => {
					if (room.players.length === 2 && room.players.every((p) => p.connected)) startDuel(room);
				}, QUICKPLAY_START_DELAY_MS);
			}
		})
	);

	conn.on(
		"spectate",
		handler("spectate", (data) => {
			const room = duelRooms.get(roomCode(data));
			if (!room || room.status === "finished") return reject(conn, "Room not found or already finished");
			/** Everyone watches a tournament match. */
			if (!room.tournament && room.spectators.size >= GAME.duel.maxSpectators)
				return reject(conn, "This duel has too many spectators");

			room.spectators.add(conn);
			rooms.set(conn, room);
			sendSnapshot(room, conn, userId, true);
			broadcast(room, "spectators", { count: room.spectators.size });
		})
	);

	conn.on(
		"ready",
		handler("ready", () => {
			const s = seat();
			if (!s || s.room.status !== "waiting") return;
			s.room.ready.add(s.player.userId);
			broadcastState(s.room);
		})
	);

	conn.on(
		"start",
		handler("start", () => {
			const s = seat();
			if (!s || s.room.status !== "waiting" || s.room.players[0] !== s.player) return;
			const opponent = s.room.players[1];
			if (!opponent) return send(conn, "notice", { message: "Waiting for another player to join" });
			if (!s.room.quickplay && !s.room.ready.has(opponent.userId)) {
				return send(conn, "notice", { message: "Waiting for your opponent to ready up" });
			}
			const problem = startDuel(s.room);
			if (problem) send(conn, "notice", { message: problem });
		})
	);

	conn.on(
		"loaded",
		handler("loaded", () => {
			const s = seat();
			if (s) playerLoaded(s.room, s.player.userId);
		})
	);

	conn.on(
		"guess",
		handler("guess", (data) => {
			const s = seat();
			if (!s) return;
			const body = data as { world_x?: unknown; world_y?: unknown } | null;
			submitGuess(s.room, s.player.userId, parseGuess(body?.world_x, body?.world_y));
		})
	);

	conn.on(
		"pin_move",
		handler("pin_move", (data) => {
			const s = seat();
			const body = data as { world_x?: unknown; world_y?: unknown } | null;
			if (s) previewPin(s.room, s.player, parseGuess(body?.world_x, body?.world_y));
		})
	);

	/** Not named "emote" like the event sent back: this library also fires handlers on connections the server sends that event to, so every receiver would appear to send it too. */
	conn.on(
		"send_emote",
		handler("send_emote", (data) => {
			const s = seat();
			const emote = (data as { emote?: unknown } | null)?.emote;
			if (s) return sendEmote(s.room, s.player.userId, emote);
			const room = rooms.get(conn);
			if (room?.spectators.has(conn) && userId !== null) sendCrowdEmote(room, userId, emote);
		})
	);

	conn.on(
		"leave",
		handler("leave", () => {
			const s = seat();
			if (!s) return;
			rooms.delete(conn);
			if (s.room.status === "in_progress") abandonDuel(s.room, s.player.userId);
			else if (s.room.status === "waiting") leaveQuickplayRoom(s.room, s.player.userId);
			else declineRematch(s.room, s.player);
		})
	);

	conn.on(
		"play_again",
		handler("play_again", () => {
			const s = seat();
			if (!s || s.room.status !== "finished" || s.room.tournament) return;
			const { room, player } = s;
			const opponent = room.players.find((p) => p !== player);
			if (!opponent?.connected) return send(conn, "play_again_declined", {});

			room.rematchRequests.add(player.userId);
			if (room.rematchRequests.size < 2) {
				send(conn, "play_again_waiting", {});
				send(opponent.conn, "play_again_incoming", {});
				if (room.rematchTimer) clearTimeout(room.rematchTimer);
				room.rematchTimer = setTimeout(() => {
					clearRematch(room);
					send(conn, "play_again_expired", {});
					send(opponent.conn, "play_again_expired", {});
				}, REMATCH_TIMEOUT_MS);
				return;
			}

			clearRematch(room);
			const [host, guest] = room.players;
			const rematch = createRoom(host.userId, room.rounds, room.quickplay, room.listed);
			/** The same two players again, so the running score between them carries on. */
			rematch.series = { wins: { ...room.series.wins }, games: room.series.games };
			rematch.previousWinnerId = room.winnerId;
			joinRoom(rematch.code, guest.userId);
			send(host.conn, "play_again_match", { code: rematch.code, is_host: true });
			send(guest.conn, "play_again_match", { code: rematch.code, is_host: false });
			sendToSpectators(room, "play_again_available", { code: rematch.code });
		})
	);

	function declineRematch(room: DuelRoom, player: DuelPlayer) {
		const hadRequest = room.rematchRequests.size > 0;
		clearRematch(room);
		const opponent = room.players.find((p) => p !== player);
		if (hadRequest && opponent) send(opponent.conn, "play_again_declined", {});
	}

	conn.on(
		"play_again_decline",
		handler("play_again_decline", () => {
			const s = seat();
			if (s?.room.status === "finished") declineRematch(s.room, s.player);
		})
	);

	conn.on(
		"disconnect",
		handler("disconnect", () => {
			const room = rooms.get(conn);
			if (!room) return;
			rooms.delete(conn);
			if (room.spectators.delete(conn)) broadcast(room, "spectators", { count: room.spectators.size });

			const player = room.players.find((p) => p.conn === conn);
			if (!player) return;
			player.connected = false;

			if (room.status === "in_progress") return playerDisconnected(room, player.userId);
			if (room.status === "finished") return declineRematch(room, player);

			/** Still in the lobby: hold the seat briefly in case this was a reload or a network blip. */
			cancelCountdown(room);
			broadcastState(room);
			setTimeout(() => {
				if (room.status === "waiting" && !player.connected && room.players.includes(player)) {
					leaveQuickplayRoom(room, player.userId);
				}
			}, RECONNECT_GRACE_MS);
		})
	);
});
