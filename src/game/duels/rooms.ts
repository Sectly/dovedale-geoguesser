import type { WireConnection } from "@webwirejs/server";
import { db, type Location } from "../../db";
import { GAME } from "../../config";
import { auditLog } from "../../lib/audit";
import { pickLocations } from "../locations";
import { DUEL_RULES, Round, outcomeJson, type Guess, type RoundOutcome } from "../round";

/**
 * A duel is the shared round engine played by two people at once: both guess the
 * same location, the round ends when both have guessed or the clock runs out, and
 * the higher total after the last round wins. Rooms live in memory; results are
 * written to the database as each round ends.
 */

export type DuelPlayer = {
	userId: number;
	username: string;
	displayName: string;
	avatarUrl: string;
	conn: WireConnection;
	/** False while the player's socket is down and they may still come back. */
	connected: boolean;
	/** Times this player has dropped out of the current duel. */
	disconnects: number;
	totalScore: number;
};

/** The single pending step of a game, kept so it can be put on hold and picked up again. */
type Phase = { run: () => void; dueAt: number; timer: ReturnType<typeof setTimeout> | null; remainingMs: number };

export type DuelRoom = {
	code: string;
	dbId: number;
	rounds: number;
	quickplay: boolean;
	/** Listed under "Live duels" for anyone to watch. Quickplay duels always are. */
	listed: boolean;
	status: "waiting" | "in_progress" | "finished";
	/** The player who created the room; they are the host whenever they are present. */
	creatorId: number;
	/** Seated players, host first. */
	players: DuelPlayer[];
	spectators: Set<WireConnection>;
	ready: Set<number>;
	locations: Location[];
	roundNumber: number;
	/** The round being guessed, or null between rounds. */
	round: Round | null;
	outcomes: Map<number, RoundOutcome>;
	/** Players whose browsers have the current round's screenshot loaded. */
	loaded: Set<number>;
	/** True from the moment a round is sent out until its clock starts. */
	awaitingLoad: boolean;
	/** True during the countdown before the first round. */
	starting: boolean;
	/** The one pending step of the game: countdown, round timeout or the pause between rounds. */
	phase: Phase | null;
	/** Set while the duel is on hold for a disconnected player. */
	paused: { timer: ReturnType<typeof setTimeout> | null; resuming: boolean } | null;
	/** The last round's results, replayed to anyone who connects between rounds. */
	lastResult: Record<string, unknown> | null;
	rematchRequests: Set<number>;
	rematchTimer: ReturnType<typeof setTimeout> | null;
	createdAt: number;
};

export type JoinResult = "ok" | "not_found" | "gone" | "full" | "in_progress";

export const duelRooms = new Map<string, DuelRoom>();

const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FINISHED_ROOM_TTL_MS = 5 * 60 * 1000;
const STALE_WAITING_MS = 10 * 60 * 1000;

function generateRoomCode(): string {
	let code: string;
	do {
		code = Array.from(
			{ length: 6 },
			() => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
		).join("");
	} while (duelRooms.has(code));
	return code;
}

function describe(room: DuelRoom): string {
	return `room ${room.code}${room.quickplay ? ", quickplay" : ""}`;
}

function armPhase(room: DuelRoom, phase: Phase, delayMs: number) {
	phase.dueAt = Date.now() + delayMs;
	phase.timer = setTimeout(() => {
		if (room.phase === phase) room.phase = null;
		try {
			phase.run();
		} catch (err) {
			console.error(`[duels] Room ${room.code} failed:`, err);
		}
	}, delayMs);
}

function setPhase(room: DuelRoom, seconds: number, run: () => void) {
	clearPhase(room);
	room.phase = { run, dueAt: 0, timer: null, remainingMs: 0 };
	armPhase(room, room.phase, seconds * 1000);
}

function clearPhase(room: DuelRoom) {
	if (room.phase?.timer) clearTimeout(room.phase.timer);
	room.phase = null;
}

function clearPause(room: DuelRoom) {
	if (room.paused?.timer) clearTimeout(room.paused.timer);
	room.paused = null;
}

export function send(conn: WireConnection, event: string, data: unknown) {
	try {
		conn.emit(event, data);
	} catch {}
}

export function broadcast(room: DuelRoom, event: string, data: unknown) {
	for (const player of room.players) send(player.conn, event, data);
	for (const conn of room.spectators) send(conn, event, data);
}

export function sendToPlayers(room: DuelRoom, event: string, data: unknown) {
	for (const player of room.players) send(player.conn, event, data);
}

export function sendToSpectators(room: DuelRoom, event: string, data: unknown) {
	for (const conn of room.spectators) send(conn, event, data);
}

export function roomState(room: DuelRoom) {
	const hostId = room.players[0]?.userId;
	return {
		code: room.code,
		status: room.status,
		rounds: room.rounds,
		quickplay: room.quickplay,
		listed: room.listed,
		spectators: room.spectators.size,
		players: room.players.map((p) => ({
			user_id: p.userId,
			username: p.username,
			display_name: p.displayName,
			avatar_url: p.avatarUrl,
			is_host: p.userId === hostId,
			is_ready: p.userId === hostId || room.ready.has(p.userId),
		})),
	};
}

export function broadcastState(room: DuelRoom) {
	broadcast(room, "room_state", roomState(room));
}

/** The current round as a late joiner or spectator should see it, or null between rounds. */
export function roundStartMessage(room: DuelRoom) {
	if (!room.round) return null;
	return { round: room.roundNumber, total_rounds: room.rounds, ...room.round.view() };
}

/**
 * Brings one connection fully up to date with a room: who is in it, and for a game
 * under way the round being played (or the result on screen) and whether it is paused.
 */
export function sendSnapshot(room: DuelRoom, conn: WireConnection, viewerId: number | null, spectating = false) {
	send(conn, "room_state", { ...roomState(room), spectating });
	if (room.status !== "in_progress") return;

	const round = roundStartMessage(room);
	if (round) {
		send(conn, room.awaitingLoad ? "round_loading" : "round_start", {
			...round,
			guessed: viewerId !== null && room.outcomes.has(viewerId),
			guessed_ids: [...room.outcomes.keys()],
		});
		if (spectating) {
			for (const [userId, outcome] of room.outcomes) {
				const player = room.players.find((p) => p.userId === userId);
				if (outcome.guess && player) {
					send(conn, "player_pin", {
						user_id: userId,
						username: player.username,
						display_name: player.displayName,
						avatar_url: player.avatarUrl,
						world_x: outcome.guess.x,
						world_y: outcome.guess.y,
					});
				}
			}
		}
	} else if (room.lastResult) {
		const waitMs = room.phase ? (room.phase.timer ? room.phase.dueAt - Date.now() : room.phase.remainingMs) : 0;
		send(conn, "round_result", { ...room.lastResult, next_in: Math.max(0, Math.ceil(waitMs / 1000)) });
	}
	if (room.paused?.resuming) send(conn, "resuming", { seconds: GAME.duel.resumeCountdown });
	else if (room.paused) send(conn, "paused", pausedMessage(room));
}

export function createRoom(creatorId: number, rounds: number, quickplay = false, listed = quickplay): DuelRoom {
	const code = generateRoomCode();
	const result = db.run("INSERT INTO duel_games (room_code, rounds, created_by, quickplay) VALUES (?, ?, ?, ?)", [
		code,
		rounds,
		creatorId,
		quickplay ? 1 : 0,
	]);
	const room: DuelRoom = {
		code,
		dbId: Number(result.lastInsertRowid),
		rounds,
		quickplay,
		listed,
		status: "waiting",
		creatorId,
		players: [],
		spectators: new Set(),
		ready: new Set(),
		locations: [],
		roundNumber: 0,
		round: null,
		outcomes: new Map(),
		loaded: new Set(),
		awaitingLoad: false,
		starting: false,
		phase: null,
		paused: null,
		lastResult: null,
		rematchRequests: new Set(),
		rematchTimer: null,
		createdAt: Date.now(),
	};
	db.run("INSERT INTO duel_participants (game_id, user_id) VALUES (?, ?)", [room.dbId, creatorId]);
	duelRooms.set(code, room);
	return room;
}

export function isParticipant(room: DuelRoom, userId: number): boolean {
	return !!db
		.query<{ id: number }, [number, number]>("SELECT id FROM duel_participants WHERE game_id = ? AND user_id = ?")
		.get(room.dbId, userId);
}

/** Reserves a seat in a waiting room. The player takes it by connecting over the socket. */
export function joinRoom(code: string, userId: number): JoinResult {
	const room = duelRooms.get(code);
	if (!room) {
		const known = db.query<{ id: number }, [string]>("SELECT id FROM duel_games WHERE room_code = ?").get(code);
		return known ? "gone" : "not_found";
	}
	if (isParticipant(room, userId)) return room.status === "finished" ? "gone" : "ok";
	if (room.status !== "waiting") return "in_progress";
	if (room.players.length >= 2) return "full";
	db.run("INSERT OR IGNORE INTO duel_participants (game_id, user_id) VALUES (?, ?)", [room.dbId, userId]);
	return "ok";
}

function deleteWaitingRoom(room: DuelRoom) {
	clearPhase(room);
	duelRooms.delete(room.code);
	// A game that never started leaves nothing worth keeping.
	db.run("DELETE FROM duel_games WHERE id = ? AND status = 'waiting'", [room.dbId]);
}

/**
 * Takes a player out of a room that has not started: frees their seat, stops any
 * countdown and tells whoever is left. An empty room is deleted.
 */
export function leaveWaitingRoom(room: DuelRoom, userId: number) {
	if (room.status !== "waiting") return;
	cancelCountdown(room);
	room.ready.delete(userId);
	room.players = room.players.filter((p) => p.userId !== userId);
	db.run("DELETE FROM duel_participants WHERE game_id = ? AND user_id = ?", [room.dbId, userId]);
	if (room.players.length === 0) deleteWaitingRoom(room);
	else broadcastState(room);
}

export function cancelCountdown(room: DuelRoom) {
	if (!room.starting) return;
	room.starting = false;
	clearPhase(room);
	broadcast(room, "countdown_cancelled", {});
}

/** Starts the countdown into round one. Returns an error message when the duel cannot start. */
export function startDuel(room: DuelRoom): string | null {
	if (room.status !== "waiting" || room.starting) return null;
	if (room.players.length < 2) return "Waiting for another player to join";

	const locations = pickLocations(room.rounds);
	if (locations.length < room.rounds) return "Not enough locations yet for a duel this long. Try fewer rounds.";

	room.locations = locations;
	room.starting = true;
	broadcast(room, "start_countdown", { seconds: GAME.duel.startCountdown });
	setPhase(room, GAME.duel.startCountdown, () => {
		room.starting = false;
		if (room.status !== "waiting" || room.players.length < 2 || !room.players.every((p) => p.connected)) return;
		room.status = "in_progress";
		db.run("UPDATE duel_games SET status = 'in_progress' WHERE id = ?", [room.dbId]);
		auditLog(null, "duel_start", {
			targetType: "duel",
			targetId: room.dbId,
			details: `${room.players.map((p) => p.username).join(" vs ")}, ${room.rounds} rounds${room.quickplay ? ", quickplay" : ""}`,
		});
		startRound(room);
	});
	return null;
}

function startRound(room: DuelRoom) {
	if (room.status !== "in_progress") return;
	room.roundNumber++;
	room.outcomes = new Map();
	room.loaded = new Set();
	room.awaitingLoad = true;
	room.lastResult = null;
	// The clock waits until both players have the screenshot, so a slow connection costs nobody time.
	room.round = Round.loading(room.locations[room.roundNumber - 1], DUEL_RULES);
	broadcast(room, "round_loading", roundStartMessage(room));
	setPhase(room, GAME.loadingWindow, () => beginRound(room));
}

function beginRound(room: DuelRoom) {
	const round = room.round;
	if (room.status !== "in_progress" || !round || !room.awaitingLoad) return;
	room.awaitingLoad = false;
	round.begin();
	broadcast(room, "round_start", roundStartMessage(room));
	setPhase(room, DUEL_RULES.timeLimit + GAME.lateGuessGrace, () => endRound(room));
}

/** A player's browser has the round on screen. The clock starts once every connected player has. */
export function playerLoaded(room: DuelRoom, userId: number) {
	if (!room.awaitingLoad || room.paused) return;
	room.loaded.add(userId);
	if (room.players.every((p) => room.loaded.has(p.userId) || !p.connected)) beginRound(room);
}

export function submitGuess(room: DuelRoom, userId: number, guess: Guess | null) {
	const round = room.round;
	if (room.status !== "in_progress" || !round || room.awaitingLoad || room.paused || room.outcomes.has(userId))
		return;
	const player = room.players.find((p) => p.userId === userId);
	if (!player) return;

	const outcome = round.score(guess);
	room.outcomes.set(userId, outcome);

	for (const other of room.players) {
		if (other.userId !== userId) send(other.conn, "opponent_guessed", { round: room.roundNumber });
	}
	if (outcome.guess) {
		sendToSpectators(room, "player_pin", {
			user_id: userId,
			username: player.username,
			display_name: player.displayName,
			avatar_url: player.avatarUrl,
			world_x: outcome.guess.x,
			world_y: outcome.guess.y,
		});
	}
	if (room.outcomes.size >= room.players.length) endRound(room);
}

function endRound(room: DuelRoom) {
	const round = room.round;
	if (room.status !== "in_progress" || !round) return;
	clearPhase(room);
	room.round = null;

	const results = room.players.map((player) => {
		const outcome = room.outcomes.get(player.userId) ?? round.score(null);
		player.totalScore += outcome.score;
		db.run(
			`INSERT INTO duel_round_scores
				(game_id, user_id, round_number, location_id, guessed_x, guessed_y, distance, time_taken, score)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				room.dbId,
				player.userId,
				room.roundNumber,
				round.location.id,
				outcome.guess?.x ?? null,
				outcome.guess?.y ?? null,
				outcome.distance,
				outcome.guess ? outcome.timeTaken : null,
				outcome.score,
			]
		);
		return {
			user_id: player.userId,
			username: player.username,
			display_name: player.displayName,
			avatar_url: player.avatarUrl,
			...outcomeJson(outcome),
			total_score: player.totalScore,
		};
	});

	const isLast = room.roundNumber >= room.rounds;
	const delay = isLast ? GAME.duel.finalResultDelay : GAME.duel.resultDelay;
	room.lastResult = {
		round: room.roundNumber,
		total_rounds: room.rounds,
		...round.answer(),
		results,
		is_last: isLast,
	};
	broadcast(room, "round_result", { ...room.lastResult, next_in: delay });
	setPhase(room, delay, () => (isLast ? endGame(room) : startRound(room)));
}

function finish(room: DuelRoom, winnerId: number | null) {
	clearPhase(room);
	clearPause(room);
	room.status = "finished";
	room.round = null;
	db.transaction(() => {
		db.run("UPDATE duel_games SET status = 'finished', winner_id = ?, finished_at = unixepoch() WHERE id = ?", [
			winnerId,
			room.dbId,
		]);
		for (const player of room.players) {
			db.run("UPDATE duel_participants SET total_score = ? WHERE game_id = ? AND user_id = ?", [
				player.totalScore,
				room.dbId,
				player.userId,
			]);
		}
	})();
	setTimeout(() => {
		if (room.rematchTimer) clearTimeout(room.rematchTimer);
		if (duelRooms.get(room.code) === room) duelRooms.delete(room.code);
	}, FINISHED_ROOM_TTL_MS);
}

function scoreboard(room: DuelRoom) {
	return [...room.players]
		.sort((a, b) => b.totalScore - a.totalScore)
		.map((p) => ({
			user_id: p.userId,
			username: p.username,
			display_name: p.displayName,
			avatar_url: p.avatarUrl,
			total_score: p.totalScore,
		}));
}

function endGame(room: DuelRoom) {
	if (room.status !== "in_progress") return;
	const scores = scoreboard(room);
	const isTie = scores.length > 1 && scores[0].total_score === scores[1].total_score;
	const winner = isTie ? null : scores[0];

	finish(room, winner?.user_id ?? null);
	auditLog(null, "duel_end", {
		targetType: "duel",
		targetId: room.dbId,
		details: `${
			winner
				? `winner: ${winner.username} (${winner.total_score} vs ${scores[1]?.total_score ?? 0})`
				: `tie: ${scores.map((p) => `${p.username} ${p.total_score}`).join(" / ")}`
		}, ${describe(room)}`,
	});
	broadcast(room, "game_end", {
		scores,
		winner: winner
			? { user_id: winner.user_id, username: winner.username, display_name: winner.display_name }
			: null,
		is_tie: isTie,
	});
}

function pausedMessage(room: DuelRoom) {
	return {
		players: room.players
			.filter((p) => !p.connected)
			.map((p) => ({ user_id: p.userId, username: p.username, display_name: p.displayName })),
		timeout: GAME.duel.reconnectWindow,
		resuming: !!room.paused?.resuming,
	};
}

/**
 * A player's connection dropped mid-duel. The game is put on hold (round clock
 * included) to give them a chance to come back; if they do not, they forfeit.
 */
export function playerDisconnected(room: DuelRoom, userId: number) {
	const player = room.players.find((p) => p.userId === userId);
	if (room.status !== "in_progress" || !player) return;
	if (++player.disconnects > GAME.duel.maxDisconnects) return abandonDuel(room, userId);

	if (!room.paused) {
		room.paused = { timer: null, resuming: false };
		room.round?.pause();
		if (room.phase?.timer) {
			clearTimeout(room.phase.timer);
			room.phase.timer = null;
			room.phase.remainingMs = Math.max(0, room.phase.dueAt - Date.now());
		}
	}
	// Whether this is the first drop or one during the resume countdown, the wait starts over.
	if (room.paused.timer) clearTimeout(room.paused.timer);
	room.paused.resuming = false;
	room.paused.timer = setTimeout(() => {
		const missing = room.players.filter((p) => !p.connected);
		if (room.status === "in_progress" && missing.length) abandonDuel(room, missing[0].userId);
	}, GAME.duel.reconnectWindow * 1000);
	broadcast(room, "paused", pausedMessage(room));
}

/** A player is back. Once everyone is, count down and carry on from where the duel stopped. */
export function playerReconnected(room: DuelRoom) {
	const pause = room.paused;
	if (room.status !== "in_progress" || !pause || pause.resuming) return;
	if (!room.players.every((p) => p.connected)) return broadcast(room, "paused", pausedMessage(room));

	if (pause.timer) clearTimeout(pause.timer);
	pause.resuming = true;
	broadcast(room, "resuming", { seconds: GAME.duel.resumeCountdown });
	pause.timer = setTimeout(() => {
		if (room.paused !== pause || room.status !== "in_progress") return;
		room.paused = null;
		room.round?.resume();
		if (room.phase) armPhase(room, room.phase, room.phase.remainingMs);
		const waitMs = room.phase?.remainingMs ?? 0;
		for (const p of room.players) {
			send(p.conn, "resumed", {
				round: roundStartMessage(room),
				guessed: room.outcomes.has(p.userId),
				next_in: Math.ceil(waitMs / 1000),
			});
		}
		sendToSpectators(room, "resumed", {
			round: roundStartMessage(room),
			guessed: false,
			next_in: Math.ceil(waitMs / 1000),
		});
	}, GAME.duel.resumeCountdown * 1000);
}

/** Ends a running duel because a player left for good; whoever is still here wins. */
export function abandonDuel(room: DuelRoom, leaverId: number) {
	if (room.status !== "in_progress") return;
	const leaver = room.players.find((p) => p.userId === leaverId);
	const stayed = room.players.filter((p) => p.userId !== leaverId && p.connected);
	const winner = stayed.length === 1 ? stayed[0] : null;

	finish(room, winner?.userId ?? null);
	auditLog(null, "duel_abandon", {
		targetType: "duel",
		targetId: room.dbId,
		details: `${leaver?.username ?? "unknown"} left mid-game, ${describe(room)}`,
	});
	broadcast(room, "opponent_disconnected", {
		player_id: leaverId,
		winner: winner ? { user_id: winner.userId, username: winner.username, display_name: winner.displayName } : null,
		scores: scoreboard(room),
	});
}

/** Takes a player out of every duel they are in: a running one is forfeited, a waiting one is left. */
export function removeFromDuels(userId: number) {
	for (const room of [...duelRooms.values()]) {
		const player = room.players.find((p) => p.userId === userId);
		if (!player) continue;
		if (room.status === "in_progress") abandonDuel(room, userId);
		else leaveWaitingRoom(room, userId);
		send(player.conn, "rejected", { message: "Your account has been banned." });
		try {
			player.conn.close(1008, "Banned");
		} catch {}
	}
}

/** Duels under way that anyone may watch, busiest first. */
export function liveDuels() {
	return [...duelRooms.values()]
		.filter((room) => room.status === "in_progress" && room.listed)
		.map((room) => ({
			code: room.code,
			round: room.roundNumber,
			rounds: room.rounds,
			quickplay: room.quickplay,
			spectators: room.spectators.size,
			players: room.players.map((p) => ({
				username: p.username,
				display_name: p.displayName,
				avatar_url: p.avatarUrl,
				total_score: p.totalScore,
			})),
		}))
		.sort((a, b) => b.spectators - a.spectators)
		.slice(0, 20);
}

/** Marks games that were cut off by a restart and clears rooms nobody can reach any more. */
export function resetDuelsOnStartup() {
	db.run("UPDATE duel_games SET status = 'abandoned' WHERE status = 'in_progress'");
	db.run("DELETE FROM duel_games WHERE status = 'waiting'");
}

export function pruneDuelRooms() {
	const now = Date.now();
	for (const room of duelRooms.values()) {
		if (room.status !== "waiting" || room.starting) continue;
		const nobodyHere = !room.players.some((p) => p.connected);
		if (nobodyHere && now - room.createdAt > STALE_WAITING_MS) deleteWaitingRoom(room);
	}
}
