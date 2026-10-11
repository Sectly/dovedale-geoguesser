import { db, type Location } from "./db";
import { randomBytes } from "crypto";
import type { WireConnection } from "@webwirejs/server";

function calcDistanceScore(distance: number): number {
	return Math.max(0, Math.round(5000 * Math.exp(-distance / 9322)));
}

function calcTimeBonus(timeTaken: number, timeLimit = 60): number {
	if (timeTaken >= timeLimit) return 0;
	return Math.max(0, Math.round(1000 * (1 - timeTaken / timeLimit)));
}

function worldDistance(x1: number, y1: number, x2: number, y2: number): number {
	return Math.hypot(x2 - x1, y2 - y1);
}

export function getRandomLocations(count: number): Location[] {
	const pool = db.query<Location, []>(`SELECT * FROM locations WHERE is_active = 1`).all();

	if (pool.length <= count) {
		for (let i = pool.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[pool[i], pool[j]] = [pool[j], pool[i]];
		}
		return pool;
	}

	const recentDaily = new Set(
		db
			.query<{ location_id: number }, []>(
				`SELECT location_id FROM daily_challenges WHERE date >= date('now', '-3 days')`
			)
			.all()
			.map((r) => r.location_id)
	);
	const recentDuels = new Set(
		db
			.query<{ location_id: number }, []>(
				`SELECT DISTINCT location_id FROM duel_round_scores WHERE created_at > unixepoch() - 7 * 86400`
			)
			.all()
			.map((r) => r.location_id)
	);

	const picked: Location[] = [];
	const remaining = [...pool];

	while (picked.length < count && remaining.length > 0) {
		let weights: number[];

		if (picked.length === 0) {
			weights = remaining.map((c) => {
				let w = 1.0;
				if (recentDaily.has(c.id)) w *= 0.25;
				if (recentDuels.has(c.id)) w *= 0.5;
				return w;
			});
		} else {
			weights = remaining.map((c) => {
				let minDist = Infinity;
				for (const p of picked) {
					const d = Math.hypot(c.world_x - p.world_x, c.world_y - p.world_y);
					if (d < minDist) minDist = d;
				}
				let w = minDist * minDist;
				if (recentDaily.has(c.id)) w *= 0.25;
				if (recentDuels.has(c.id)) w *= 0.5;
				return w;
			});
		}

		let total = weights.reduce((a, b) => a + b, 0);
		if (total <= 0) {
			weights = weights.map(() => 1);
			total = weights.length;
		}

		let r = Math.random() * total;
		let chosenIdx = weights.length - 1;
		for (let i = 0; i < weights.length; i++) {
			r -= weights[i];
			if (r <= 0) {
				chosenIdx = i;
				break;
			}
		}

		picked.push(remaining.splice(chosenIdx, 1)[0]);
	}

	for (let i = picked.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[picked[i], picked[j]] = [picked[j], picked[i]];
	}

	return picked;
}

export type DuelPlayer = {
	userId: number;
	username: string;
	displayName: string;
	avatarUrl: string;
	conn: WireConnection;
	totalScore: number;
};

type RoundGuess = {
	worldX: number;
	worldY: number;
	timeTaken: number;
	score: number;
	distance: number;
};

export type DuelRoom = {
	code: string;
	dbId: number;
	rounds: number;
	status: "waiting" | "in_progress" | "finished";
	players: DuelPlayer[];
	spectators: WireConnection[];
	readyPlayers: Set<number>;
	currentRound: number;
	locations: Location[];
	guesses: Map<number, RoundGuess>;
	roundTimer: ReturnType<typeof setTimeout> | null;
	roundStartTime: number;
	createdAt: number;
	quickplay: boolean;
	playAgainRequests: Set<number>;
	_playAgainTimer: ReturnType<typeof setTimeout> | null;
	_autoStartScheduled?: boolean;
	_countdownScheduled?: boolean;
	_countdownTimer?: ReturnType<typeof setTimeout> | null;
};

export const duelRooms = new Map<string, DuelRoom>();

type DuelAuditFn = (action: string, targetId: number, details: string) => void;
let _duelAudit: DuelAuditFn | null = null;
export function setDuelAuditCallback(fn: DuelAuditFn) {
	_duelAudit = fn;
}

function generateRoomCode(): string {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	let code: string;
	do {
		code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
	} while (duelRooms.has(code));
	return code;
}

export function createDuelRoom(creatorUserId: number, rounds: number): { code: string; dbId: number } {
	const code = generateRoomCode();
	const result = db.run("INSERT INTO duel_games (room_code, rounds, created_by) VALUES (?, ?, ?)", [
		code,
		rounds,
		creatorUserId,
	]);
	const dbId = result.lastInsertRowid as number;
	db.run("INSERT INTO duel_participants (game_id, user_id) VALUES (?, ?)", [dbId, creatorUserId]);
	duelRooms.set(code, {
		code,
		dbId,
		rounds,
		status: "waiting",
		players: [],
		spectators: [],
		readyPlayers: new Set(),
		currentRound: 0,
		locations: [],
		guesses: new Map(),
		roundTimer: null,
		roundStartTime: 0,
		createdAt: Date.now(),
		quickplay: false,
		playAgainRequests: new Set(),
		_playAgainTimer: null,
	});
	return { code, dbId };
}

export function joinDuelRoom(
	code: string,
	userId: number
): "ok" | "not_found" | "full" | "already_in" | "in_progress" | "abandoned" {
	const room = duelRooms.get(code);
	if (!room) {
		const dbRoom = db
			.query<{ status: string }, [string]>("SELECT status FROM duel_games WHERE room_code = ?")
			.get(code);
		return dbRoom ? "abandoned" : "not_found";
	}
	if (room.status !== "waiting") return "in_progress";
	if (room.players.some((p) => p.userId === userId)) return "already_in";
	if (room.players.length >= 2) return "full";

	try {
		db.run("INSERT OR IGNORE INTO duel_participants (game_id, user_id) VALUES (?, ?)", [room.dbId, userId]);
	} catch {}

	return "ok";
}

function broadcast(room: DuelRoom, event: string, data: unknown) {
	for (const player of room.players) {
		try {
			player.conn.emit(event, data);
		} catch {}
	}
	for (const conn of room.spectators) {
		try {
			conn.emit(event, data);
		} catch {}
	}
}

function sendTo(conn: WireConnection, event: string, data: unknown) {
	try {
		conn.emit(event, data);
	} catch {}
}

export function startDuel(room: DuelRoom) {
	if (room.players.length < 2 || room._countdownScheduled) return;
	const locations = getRandomLocations(room.rounds);

	if (locations.length < room.rounds) {
		broadcast(room, "error", {
			message: "Not enough locations in the database. Ask an operator to add more.",
		});
		return;
	}

	room._countdownScheduled = true;
	room.locations = locations;
	broadcast(room, "start_countdown", { seconds: 3 });
	room._countdownTimer = setTimeout(() => {
		room._countdownTimer = null;
		if (room.status !== "waiting" || room.players.length < 2) {
			room._countdownScheduled = false;
			return;
		}
		room.status = "in_progress";
		db.run("UPDATE duel_games SET status = 'in_progress' WHERE id = ?", [room.dbId]);
		_duelAudit?.(
			"duel_start",
			room.dbId,
			`${room.players.map((p) => p.username).join(" vs ")}, ${room.rounds} rounds${room.quickplay ? ", quickplay" : ""}`
		);
		startRound(room);
	}, 3000);
}

function startRound(room: DuelRoom) {
	room.currentRound++;
	room.guesses = new Map();
	room.roundStartTime = Date.now();

	const loc = room.locations[room.currentRound - 1];
	broadcast(room, "round_start", {
		round: room.currentRound,
		total_rounds: room.rounds,
		image_url: `/uploads/${loc.image_path}`,
		location_id: loc.id,
		time_limit: 60,
	});

	room.roundTimer = setTimeout(() => {
		endRound(room);
	}, 62_000); // 2s grace over the 60s limit
}

export function abandonDuel(room: DuelRoom, disconnectedUserId: number) {
	if (room.status === "finished") return;
	if (room.roundTimer) clearTimeout(room.roundTimer);
	if (room._countdownTimer) clearTimeout(room._countdownTimer);
	room.status = "finished";
	db.run("UPDATE duel_games SET status = 'finished', winner_id = ?, finished_at = unixepoch() WHERE id = ?", [
		room.players.find((p) => p.userId !== disconnectedUserId)?.userId ?? null,
		room.dbId,
	]);
	const winner = room.players.find((p) => p.userId !== disconnectedUserId);
	for (const player of room.players) {
		db.run("UPDATE duel_participants SET total_score = ? WHERE game_id = ? AND user_id = ?", [
			player.totalScore,
			room.dbId,
			player.userId,
		]);
	}
	const abandoner = room.players.find((p) => p.userId === disconnectedUserId);
	_duelAudit?.(
		"duel_abandon",
		room.dbId,
		`${abandoner?.username ?? "unknown"} left mid-game, room ${room.code}${room.quickplay ? ", quickplay" : ""}`
	);
	broadcast(room, "opponent_disconnected", {
		player_id: disconnectedUserId,
		winner: winner ? { user_id: winner.userId, username: winner.username } : null,
	});
	setTimeout(() => duelRooms.delete(room.code), 5 * 60 * 1000);
}

export function submitDuelGuess(room: DuelRoom, userId: number, worldX: number, worldY: number) {
	if (room.guesses.has(userId)) return;

	const loc = room.locations[room.currentRound - 1];
	const timeTaken = Math.min(60, (Date.now() - room.roundStartTime) / 1000);
	const distance = worldDistance(worldX, worldY, loc.world_x, loc.world_y);
	const distScore = calcDistanceScore(distance);
	const timeBonus = calcTimeBonus(timeTaken);
	const score = distScore + timeBonus;

	room.guesses.set(userId, { worldX, worldY, timeTaken, score, distance });

	const guesser = room.players.find((p) => p.userId === userId);
	for (const p of room.players) {
		if (p.userId !== userId) {
			sendTo(p.conn, "opponent_guessed", { round: room.currentRound });
		}
	}
	for (const spec of room.spectators) {
		sendTo(spec, "player_pin", {
			user_id: userId,
			username: guesser?.username ?? "",
			world_x: worldX,
			world_y: worldY,
		});
	}

	if (room.guesses.size >= room.players.length) {
		if (room.roundTimer) clearTimeout(room.roundTimer);
		endRound(room);
	}
}

function endRound(room: DuelRoom) {
	const loc = room.locations[room.currentRound - 1];

	const results = room.players.map((p) => {
		const guess = room.guesses.get(p.userId);
		const score = guess?.score ?? 0;
		const distance = guess?.distance ?? null;

		db.run(
			`INSERT INTO duel_round_scores
        (game_id, user_id, round_number, location_id, guessed_x, guessed_y, distance, time_taken, score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				room.dbId,
				p.userId,
				room.currentRound,
				loc.id,
				guess?.worldX ?? null,
				guess?.worldY ?? null,
				distance,
				guess?.timeTaken ?? null,
				score,
			]
		);

		p.totalScore += score;

		return {
			user_id: p.userId,
			username: p.username,
			display_name: p.displayName,
			avatar_url: p.avatarUrl,
			guessed_x: guess?.worldX ?? null,
			guessed_y: guess?.worldY ?? null,
			distance: distance ? Math.round(distance) : null,
			time_taken: guess ? Math.round(guess.timeTaken * 10) / 10 : null,
			score,
			total_score: p.totalScore,
		};
	});

	broadcast(room, "round_result", {
		round: room.currentRound,
		correct_x: loc.world_x,
		correct_y: loc.world_y,
		label: loc.label,
		results,
	});

	if (room.currentRound >= room.rounds) {
		setTimeout(() => endGame(room), 5000);
	} else {
		setTimeout(() => startRound(room), 7000);
	}
}

function endGame(room: DuelRoom) {
	room.status = "finished";

	const sorted = [...room.players].sort((a, b) => b.totalScore - a.totalScore);
	const winner = sorted[0];
	const isTie = sorted.length > 1 && sorted[0].totalScore === sorted[1].totalScore;

	db.run("UPDATE duel_games SET status = 'finished', winner_id = ?, finished_at = unixepoch() WHERE id = ?", [
		isTie ? null : winner.userId,
		room.dbId,
	]);

	for (const p of room.players) {
		db.run("UPDATE duel_participants SET total_score = ? WHERE game_id = ? AND user_id = ?", [
			p.totalScore,
			room.dbId,
			p.userId,
		]);
	}

	_duelAudit?.(
		"duel_end",
		room.dbId,
		isTie
			? `tie: ${sorted.map((p) => `${p.username} ${p.totalScore}`).join(" / ")}, room ${room.code}${room.quickplay ? ", quickplay" : ""}`
			: `winner: ${winner.username} (${winner.totalScore} vs ${sorted[1]?.totalScore ?? 0}), room ${room.code}${room.quickplay ? ", quickplay" : ""}`
	);
	broadcast(room, "game_end", {
		scores: sorted.map((p) => ({
			user_id: p.userId,
			username: p.username,
			display_name: p.displayName,
			avatar_url: p.avatarUrl,
			total_score: p.totalScore,
		})),
		winner: isTie ? null : { user_id: winner.userId, username: winner.username },
		is_tie: isTie,
	});

	setTimeout(() => duelRooms.delete(room.code), 5 * 60 * 1000);
}
