import type { WireConnection } from "@webwirejs/server";
import { db, type Location } from "../../db";
import { GAME } from "../../config";
import { auditLog } from "../../lib/audit";
import { pickLocations } from "../locations";
import { DUEL_RULES, Round, outcomeJson, recordOutcome, type Guess, type RoundOutcome } from "../round";
import { checkDuel, checkRound } from "../../achievements";
import { reviewGuess } from "../../fairplay";
import { features } from "../../system/features";
import { getRated, rateDuel, ratingOf, ratingStakes, winStreak, type RatingChange } from "./rating";

/** A duel: two players, the same locations, higher total wins. Rooms live in memory; results are saved each round. */

export type DuelPlayer = {
	userId: number;
	username: string;
	displayName: string;
	avatarUrl: string;
	conn: WireConnection;
	/** False while the player's socket is down and they may still come back. */
	connected: boolean;
	disconnects: number;
	totalScore: number;
	lastEmoteAt?: number;
	/** Quick Play: their win streak when they sat down. */
	streak?: number;
};

export type RoundKind = "comeback" | "sudden_death";

/** The single pending step of a game, kept so it can be put on hold and picked up again. */
type Phase = { run: () => void; dueAt: number; timer: ReturnType<typeof setTimeout> | null; remainingMs: number };

export type DuelRoom = {
	code: string;
	dbId: number;
	rounds: number;
	quickplay: boolean;
	/** Listed under "Live duels" for anyone to watch. Quickplay duels always are. */
	listed: boolean;
	/** A tournament match starts by itself, plays Quick Play's special rounds and always has a winner. */
	tournament: { id: number; matchId: number } | null;
	status: "waiting" | "in_progress" | "finished";
	/** The player who created the room; they are the host whenever they are present. */
	creatorId: number;
	/** Seated players, host first. */
	players: DuelPlayer[];
	spectators: Set<WireConnection>;
	ready: Set<number>;
	locations: Location[];
	/** Quick Play: one more location, held back for a sudden-death round. */
	spare: Location | null;
	roundNumber: number;
	roundKind: RoundKind | null;
	/** Whose points count double in a comeback round, in this round and as decided for the next. */
	comebackFor: number | null;
	nextComebackFor: number | null;
	/** Set once a sudden-death round has been played: who took it, or null if nobody did. */
	suddenDeath: { winnerId: number | null } | null;
	round: Round | null;
	outcomes: Map<number, RoundOutcome>;
	loaded: Set<number>;
	/** Unsubmitted pins, for spectators who arrive mid-round. */
	previews: Map<number, Guess>;
	/** True from the moment a round is sent out until its clock starts. */
	awaitingLoad: boolean;
	starting: boolean;
	/** The one pending step of the game: countdown, round timeout or the pause between rounds. */
	phase: Phase | null;
	paused: { timer: ReturnType<typeof setTimeout> | null; resuming: boolean } | null;
	/** The last round's results, replayed to anyone who connects between rounds. */
	lastResult: Record<string, unknown> | null;
	/** Every finished round's results, sent with the final result for the end-screen replay. */
	history: Record<string, unknown>[];
	rematchRequests: Set<number>;
	rematchTimer: ReturnType<typeof setTimeout> | null;
	/** The running score across rematches between the same two players. Gone once either leaves. */
	series: { wins: Record<number, number>; games: number };
	/** In a rematch: who won the duel before this one, or null if nobody did. */
	previousWinnerId: number | null;
	winnerId: number | null;
	createdAt: number;
};

export type JoinResult = "ok" | "not_found" | "gone" | "full" | "in_progress";

export const duelRooms = new Map<string, DuelRoom>();

export type DuelEnd = "finished" | "abandoned" | "closed";

let duelEnded: ((room: DuelRoom, winnerId: number | null, how: DuelEnd) => void) | null = null;

/** Told whenever a tournament match ends, however it ends. */
export function onTournamentDuelEnd(fn: typeof duelEnded) {
	duelEnded = fn;
}

let roundChanged: ((room: DuelRoom, userIds: number[]) => void) | null = null;
/** Told when a tournament player's round starts, they guess, or the round ends, since chat closes and opens then. */
export function onTournamentRoundChange(fn: typeof roundChanged) {
	roundChanged = fn;
}

function reportRound(room: DuelRoom, userIds = room.players.map((p) => p.userId)) {
	if (room.tournament) roundChanged?.(room, userIds);
}

function reportEnd(room: DuelRoom, winnerId: number | null, how: DuelEnd) {
	if (!room.tournament || !duelEnded) return;
	try {
		duelEnded(room, winnerId, how);
	} catch (err) {
		console.error(`[duels] Tournament hook failed for room ${room.code}:`, err);
	}
}

/** Quick Play and tournament duels get comeback and sudden-death rounds. */
const specialRounds = (room: DuelRoom) => room.quickplay || !!room.tournament;

/** Set while a restart is counting down: rooms stay open, but no new duel may begin. */
let closing = false;

export function setDuelsClosing(value: boolean) {
	closing = value;
}

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

/** The reactions on offer, or none when staff have switched them off. */
export const offeredEmotes = () => (features().duel_emotes ? GAME.duel.emotes : []);

/** A guess as spectators see it on their map. */
const pinMessage = (player: DuelPlayer, guess: { x: number; y: number }) => ({
	user_id: player.userId,
	username: player.username,
	display_name: player.displayName,
	avatar_url: player.avatarUrl,
	world_x: guess.x,
	world_y: guess.y,
});

function rankedDetails(room: DuelRoom) {
	if (!room.quickplay) return new Map<number, object>();
	const rated = room.players.map((p) => getRated(p.userId));
	return new Map(
		room.players.map((p, i) => {
			const own = rated[i];
			const other = rated[1 - i];
			return [
				p.userId,
				{
					rating: own ? ratingOf(own) : null,
					rated_games: own?.duel_rated_games ?? 0,
					streak: p.streak ?? 0,
					stakes: own && other && room.status === "waiting" ? ratingStakes(own, other) : null,
				},
			];
		})
	);
}

export function roomState(room: DuelRoom) {
	const hostId = room.players[0]?.userId;
	const ranked = rankedDetails(room);
	return {
		code: room.code,
		status: room.status,
		rounds: room.rounds,
		quickplay: room.quickplay,
		listed: room.listed,
		emotes: offeredEmotes(),
		spectators: room.spectators.size,
		players: room.players.map((p) => ({
			user_id: p.userId,
			username: p.username,
			display_name: p.displayName,
			avatar_url: p.avatarUrl,
			is_host: p.userId === hostId,
			is_ready: p.userId === hostId || room.ready.has(p.userId),
			...ranked.get(p.userId),
		})),
	};
}

export function broadcastState(room: DuelRoom) {
	broadcast(room, "room_state", roomState(room));
}

/** The current round as a late joiner or spectator should see it, or null between rounds. */
export function roundStartMessage(room: DuelRoom) {
	if (!room.round) return null;
	return {
		round: room.roundNumber,
		total_rounds: room.rounds,
		kind: room.roundKind,
		comeback_for: room.comebackFor,
		...room.round.view(),
	};
}

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
					send(conn, "player_pin", pinMessage(player, outcome.guess));
				}
			}
			for (const [userId, guess] of room.previews) {
				const player = room.players.find((p) => p.userId === userId);
				if (player && !room.outcomes.has(userId)) send(conn, "pin_preview", pinMessage(player, guess));
			}
		}
	} else if (room.lastResult) {
		const waitMs = room.phase ? (room.phase.timer ? room.phase.dueAt - Date.now() : room.phase.remainingMs) : 0;
		send(conn, "round_result", { ...room.lastResult, next_in: Math.max(0, Math.ceil(waitMs / 1000)) });
	}
	if (room.paused?.resuming) send(conn, "resuming", { seconds: GAME.duel.resumeCountdown });
	else if (room.paused) send(conn, "paused", pausedMessage(room));
}

export function createRoom(
	creatorId: number,
	rounds: number,
	quickplay = false,
	listed = quickplay,
	tournament: DuelRoom["tournament"] = null
): DuelRoom {
	const code = generateRoomCode();
	const result = db.run(
		"INSERT INTO duel_games (room_code, rounds, created_by, quickplay, tournament_id) VALUES (?, ?, ?, ?, ?)",
		[code, rounds, creatorId, quickplay ? 1 : 0, tournament?.id ?? null]
	);
	const room: DuelRoom = {
		code,
		dbId: Number(result.lastInsertRowid),
		rounds,
		quickplay,
		listed,
		tournament,
		status: "waiting",
		creatorId,
		players: [],
		spectators: new Set(),
		ready: new Set(),
		locations: [],
		spare: null,
		roundNumber: 0,
		roundKind: null,
		comebackFor: null,
		nextComebackFor: null,
		suddenDeath: null,
		round: null,
		outcomes: new Map(),
		previews: new Map(),
		loaded: new Set(),
		awaitingLoad: false,
		starting: false,
		phase: null,
		paused: null,
		lastResult: null,
		history: [],
		rematchRequests: new Set(),
		rematchTimer: null,
		series: { wins: {}, games: 0 },
		previousWinnerId: null,
		winnerId: null,
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
	/** A game that never started leaves nothing worth keeping. */
	db.run("DELETE FROM duel_games WHERE id = ? AND status = 'waiting'", [room.dbId]);
}

/** Takes a player out of a room that has not started. An empty room is deleted. */
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
	if (closing) return "The server is about to restart. Start your duel once it is back.";
	if (room.players.length < 2) return "Waiting for another player to join";

	const locations = pickLocations(room.rounds + (specialRounds(room) ? 1 : 0));
	if (locations.length < room.rounds) return "Not enough locations yet for a duel this long. Try fewer rounds.";

	room.locations = locations.slice(0, room.rounds);
	room.spare = locations[room.rounds] ?? null;
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
	room.comebackFor = room.nextComebackFor;
	room.nextComebackFor = null;
	room.roundKind = room.roundNumber > room.rounds ? "sudden_death" : room.comebackFor !== null ? "comeback" : null;
	room.outcomes = new Map();
	room.previews = new Map();
	room.loaded = new Set();
	room.awaitingLoad = true;
	room.lastResult = null;
	/** The clock waits until both players have the screenshot, so a slow connection costs nobody time. */
	room.round = Round.loading(room.locations[room.roundNumber - 1], DUEL_RULES);
	reportRound(room);
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
	reportRound(room, [userId]);

	for (const other of room.players) {
		if (other.userId !== userId) send(other.conn, "opponent_guessed", { round: room.roundNumber });
	}
	if (outcome.guess) {
		sendToSpectators(room, "player_pin", pinMessage(player, outcome.guess));
	}
	if (room.outcomes.size >= room.players.length) endRound(room);
}

/** Fastest a moving pin is passed on to spectators. */
const PIN_PREVIEW_MS = 150;
const pinPreviewAt = new WeakMap<DuelPlayer, number>();

/** Sent to spectators only, never to the other player. */
export function previewPin(room: DuelRoom, player: DuelPlayer, guess: Guess | null) {
	if (!room.tournament || !guess || room.status !== "in_progress" || !room.round || room.awaitingLoad) return;
	if (room.paused || room.outcomes.has(player.userId)) return;
	const now = Date.now();
	if (now - (pinPreviewAt.get(player) ?? 0) < PIN_PREVIEW_MS) return;
	pinPreviewAt.set(player, now);
	room.previews.set(player.userId, guess);
	sendToSpectators(room, "pin_preview", pinMessage(player, guess));
}

function endRound(room: DuelRoom) {
	const round = room.round;
	if (room.status !== "in_progress" || !round) return;
	clearPhase(room);
	room.round = null;
	reportRound(room);

	const kind = room.roundKind;
	const comebackFor = room.comebackFor;
	const results = room.players.map((player) => {
		const outcome = room.outcomes.get(player.userId) ?? round.score(null);
		/** The stored round score stays as guessed; the doubling only reaches the duel total. */
		const bonus = comebackFor === player.userId ? outcome.score : 0;
		player.totalScore += outcome.score + bonus;
		recordOutcome(round.location, outcome);
		/** Tournament matches earn no achievements and stay off profiles and leaderboards. */
		if (!room.tournament) checkRound(player.userId, outcome, DUEL_RULES.timeLimit);
		reviewGuess(player.userId, "duel", round.location.id, outcome);
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
			bonus,
			total_score: player.totalScore,
		};
	});

	if (kind === "sudden_death") {
		const [first, second] = results;
		room.suddenDeath = {
			winnerId:
				!second || first.score === second.score
					? null
					: first.score > second.score
						? first.user_id
						: second.user_id,
		};
	}
	const gap = specialRoundGap(room);
	room.nextComebackFor =
		gap && room.roundNumber === room.rounds - 1 && gap.points >= GAME.duel.comebackGap ? gap.trailing.userId : null;
	const suddenDeathNext =
		!!gap && !!room.spare && room.roundNumber === room.rounds && gap.points <= GAME.duel.suddenDeathMargin;
	if (suddenDeathNext) room.locations.push(room.spare!);

	const isLast = room.roundNumber >= room.rounds && !suddenDeathNext;
	const delay = isLast ? GAME.duel.finalResultDelay : GAME.duel.resultDelay;
	room.lastResult = {
		round: room.roundNumber,
		total_rounds: room.rounds,
		...round.answer(),
		results,
		is_last: isLast,
		kind,
		comeback_for: comebackFor,
		comeback_next: room.nextComebackFor,
		sudden_death_next: suddenDeathNext,
	};
	room.history.push(room.lastResult);
	broadcast(room, "round_result", { ...room.lastResult, next_in: delay });
	setPhase(room, delay, () => (isLast ? endGame(room) : startRound(room)));
}

function specialRoundGap(room: DuelRoom) {
	if (!specialRounds(room) || room.players.length !== 2) return null;
	const [leading, trailing] = [...room.players].sort((a, b) => b.totalScore - a.totalScore);
	return { trailing, points: leading.totalScore - trailing.totalScore };
}

function finish(room: DuelRoom, winnerId: number | null) {
	clearPhase(room);
	clearPause(room);
	room.status = "finished";
	room.round = null;
	room.winnerId = winnerId;
	room.series.games++;
	if (winnerId !== null) room.series.wins[winnerId] = (room.series.wins[winnerId] ?? 0) + 1;
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

/** Quick Play duels move their players' ratings; private rooms never do. */
function rate(room: DuelRoom, winnerId: number | null): RatingChange[] | null {
	if (!room.quickplay) return null;
	try {
		return rateDuel(
			room.dbId,
			room.players.map((p) => p.userId),
			winnerId
		);
	} catch (err) {
		console.error(`[duels] Could not rate room ${room.code}:`, err);
		return null;
	}
}

/** True when this player outscored the other in every round of a duel of three rounds or more. */
function tookEveryRound(room: DuelRoom, userId: number): boolean {
	if (room.history.length < 3) return false;
	return room.history.every((round) => {
		const results = round.results as { user_id: number; score: number }[];
		const mine = results.find((r) => r.user_id === userId)?.score ?? 0;
		return results.every((r) => r.user_id === userId || r.score < mine);
	});
}

export function sendEmote(room: DuelRoom, userId: number, emote: unknown) {
	if (!features().duel_emotes || room.status === "waiting") return;
	if (typeof emote !== "string" || !GAME.duel.emotes.includes(emote)) return;
	const player = room.players.find((p) => p.userId === userId);
	const now = Date.now();
	if (!player || now - (player.lastEmoteAt ?? 0) < GAME.duel.emoteCooldownMs) return;
	player.lastEmoteAt = now;
	broadcast(room, "emote", { user_id: userId, emote });
}

/** Level on points: closer guesses overall win, then quicker ones, then a coin toss. */
function tiebreakWinner(room: DuelRoom): number {
	const totals = new Map(room.players.map((p) => [p.userId, { distance: 0, time: 0 }]));
	for (const round of room.history) {
		for (const r of round.results as { user_id: number; distance: number | null; time_taken: number }[]) {
			const total = totals.get(r.user_id);
			if (!total) continue;
			total.distance += r.distance ?? Number.MAX_SAFE_INTEGER / 100;
			total.time += r.time_taken ?? DUEL_RULES.timeLimit;
		}
	}
	const [a, b] = room.players.map((p) => ({ id: p.userId, ...totals.get(p.userId)! }));
	if (a.distance !== b.distance) return a.distance < b.distance ? a.id : b.id;
	if (a.time !== b.time) return a.time < b.time ? a.id : b.id;
	return Math.random() < 0.5 ? a.id : b.id;
}

const crowdEmoteAt = new Map<number, number>();
/** Slower than players, so a big crowd can't fill the screen. */
const CROWD_EMOTE_COOLDOWN_MS = 4000;

export function sendCrowdEmote(room: DuelRoom, userId: number, emote: unknown) {
	if (!room.tournament || !features().duel_emotes || room.status === "waiting") return;
	if (typeof emote !== "string" || !GAME.duel.emotes.includes(emote)) return;
	const now = Date.now();
	if (now - (crowdEmoteAt.get(userId) ?? 0) < CROWD_EMOTE_COOLDOWN_MS) return;
	crowdEmoteAt.set(userId, now);
	if (crowdEmoteAt.size > 5000) crowdEmoteAt.clear();
	broadcast(room, "crowd_emote", { emote });
}

function endGame(room: DuelRoom) {
	if (room.status !== "in_progress") return;
	const scores = scoreboard(room);
	/** Sudden death goes to whoever took that round, whatever the totals. If nobody did, the totals decide. */
	const decider = room.suddenDeath?.winnerId ?? null;
	const level = scores.length > 1 && scores[0].total_score === scores[1].total_score;
	const tiebreak = decider === null && level && !!room.tournament && room.players.length === 2;
	const winnerId = decider ?? (tiebreak ? tiebreakWinner(room) : level ? null : scores[0].user_id);
	const winner = scores.find((p) => p.user_id === winnerId) ?? null;
	const isTie = winner === null;

	finish(room, winner?.user_id ?? null);
	const ratings = rate(room, winner?.user_id ?? null);
	const streaks = streaksAfter(room);
	const loser = scores.find((p) => p.user_id !== winner?.user_id);
	for (const player of room.tournament ? [] : room.players) {
		const won = winner?.user_id === player.userId;
		checkDuel(player.userId, {
			won,
			sweep: won && tookEveryRound(room, player.userId),
			rating: ratings?.find((r) => r.user_id === player.userId)?.rating ?? null,
			margin: (winner?.total_score ?? 0) - (loser?.total_score ?? 0),
			lostLast: room.previousWinnerId !== null && room.previousWinnerId !== player.userId,
			streak: streaks?.[player.userId] ?? 0,
		});
	}
	auditLog(null, "duel_end", {
		targetType: "duel",
		targetId: room.dbId,
		details: `${
			winner
				? `winner: ${winner.username} (${scores.map((p) => p.total_score).join(" vs ")}${decider !== null ? ", sudden death" : ""})`
				: `tie: ${scores.map((p) => `${p.username} ${p.total_score}`).join(" / ")}`
		}, ${describe(room)}`,
	});
	broadcast(room, "game_end", {
		scores,
		winner: winner
			? { user_id: winner.user_id, username: winner.username, display_name: winner.display_name }
			: null,
		is_tie: isTie,
		rounds: room.history,
		ratings,
		series: room.series,
		sudden_death: !!room.suddenDeath,
		tiebreak,
		streaks,
		tournament: room.tournament?.id ?? null,
	});
	reportEnd(room, winner?.user_id ?? null, "finished");
}

function streaksAfter(room: DuelRoom): Record<number, number> | null {
	if (!room.quickplay) return null;
	return Object.fromEntries(room.players.map((p) => [p.userId, winStreak(p.userId)]));
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

/** A player dropped mid-duel. The game pauses to let them return; if they do not, they forfeit. */
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
	/** Whether this is the first drop or one during the resume countdown, the wait starts over. */
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
	/** Walking out of a rated duel is a loss, or leaving would be the way to dodge one. */
	const ratings = winner ? rate(room, winner.userId) : null;
	auditLog(null, "duel_abandon", {
		targetType: "duel",
		targetId: room.dbId,
		details: `${leaver?.username ?? "unknown"} left mid-game, ${describe(room)}`,
	});
	broadcast(room, "opponent_disconnected", {
		player_id: leaverId,
		winner: winner ? { user_id: winner.userId, username: winner.username, display_name: winner.displayName } : null,
		scores: scoreboard(room),
		rounds: room.history,
		ratings,
		series: room.series,
		streaks: streaksAfter(room),
		tournament: room.tournament?.id ?? null,
	});
	reportEnd(room, winner?.userId ?? null, "abandoned");
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

/** Rooms that are waiting to start or being played, not ones kept around for a rematch. */
export function activeDuelRooms(): number {
	return [...duelRooms.values()].filter((room) => room.status !== "finished").length;
}

export function duelsInProgress(): number {
	return [...duelRooms.values()].filter((room) => room.status === "in_progress").length;
}

export function broadcastToDuels(event: string, data: unknown) {
	for (const room of duelRooms.values()) broadcast(room, event, data);
}

/** Closes every room before the server stops. Cut-short duels are recorded as abandoned. */
export function closeAllDuels(message: string) {
	for (const room of [...duelRooms.values()]) {
		clearPhase(room);
		clearPause(room);
		if (room.rematchTimer) clearTimeout(room.rematchTimer);
		if (room.status === "in_progress") {
			db.run("UPDATE duel_games SET status = 'abandoned' WHERE id = ?", [room.dbId]);
			auditLog(null, "duel_abandon", {
				targetType: "duel",
				targetId: room.dbId,
				details: `closed for a server restart, ${describe(room)}`,
			});
		} else if (room.status === "waiting") {
			db.run("DELETE FROM duel_games WHERE id = ? AND status = 'waiting'", [room.dbId]);
		}
		room.status = "finished";
		room.round = null;
		duelRooms.delete(room.code);
		broadcast(room, "server_restart", { message });
		reportEnd(room, null, "closed");
	}
}

/** Ends a room on staff's say-so. A running duel is recorded as abandoned with no winner, so nothing changes for either player. The reason stays in the audit log. */
export function closeDuelByStaff(code: string): DuelRoom | null {
	const room = duelRooms.get(code);
	if (!room || room.status === "finished") return null;
	clearPhase(room);
	clearPause(room);
	if (room.rematchTimer) clearTimeout(room.rematchTimer);
	if (room.status === "in_progress") db.run("UPDATE duel_games SET status = 'abandoned' WHERE id = ?", [room.dbId]);
	else db.run("DELETE FROM duel_games WHERE id = ? AND status = 'waiting'", [room.dbId]);
	room.status = "finished";
	room.round = null;
	duelRooms.delete(room.code);
	broadcast(room, "closed_by_staff", {});
	reportEnd(room, null, "closed");
	return room;
}

export function allOpenDuels() {
	return [...duelRooms.values()]
		.filter((room) => room.status !== "finished")
		.map((room) => ({
			code: room.code,
			status: room.status,
			round: room.roundNumber,
			rounds: room.rounds,
			quickplay: room.quickplay,
			listed: room.listed,
			spectators: room.spectators.size,
			players: room.players.map((p) => ({
				user_id: p.userId,
				username: p.username,
				total_score: p.totalScore,
				connected: p.connected,
			})),
		}));
}

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
