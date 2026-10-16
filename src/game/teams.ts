import { randomInt } from "crypto";
import type { Location, User } from "../db";
import { GAME } from "../config";
import { auditLog } from "../lib/audit";
import { fail } from "../lib/http";
import { uploadUrl } from "../lib/uploads";
import { features } from "../system/features";
import { offeredEmotes } from "./duels/rooms";
import { pickLocations } from "./locations";
import { Round, type Guess, type RoundOutcome, type RoundRules } from "./round";

/** Team duels (Specials): two teams of up to two, best guess scores. In memory, pushed over a socket. Never on the leaderboards. */

export type TeamId = "a" | "b";
const TEAMS: TeamId[] = ["a", "b"];
const TEAM_SIZE = 2;

export const TEAM_RULES: RoundRules = { timeLimit: 45, hintCost: 0, hints: false, maxTimeBonus: 0 };
export const TEAM_ROUNDS = { min: 3, max: 10, default: 5 };
const READY_SECONDS = 4;
const REVEAL_SECONDS = 10;
/** A player with no open, visible page for this long is treated as away and not waited for. */
const AWAY_MS = 8000;
const MAX_ROOMS = 200;
const IDLE_TTL_MS = 30 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type Member = {
	userId: number;
	username: string;
	displayName: string;
	avatarUrl: string | null;
	team: TeamId | null;
	/** Last sign of them being here; 0 once they have left a game in progress. */
	seenAt: number;
	/** Their open, visible pages on the room's socket. */
	pages: number;
	/** Where their pin is right now, before they commit to it. Shown to their teammate only. */
	pin: Guess | null;
	outcome: RoundOutcome | null;
	/** This game so far: their best round, and how many rounds their guess was the one their team scored. */
	best: number;
	counted: number;
	lastEmoteAt?: number;
};

/** How long a reaction stays in a room's state, so a page that reconnects still shows it. */
const EMOTE_TTL_MS = 6000;

type Reveal = {
	round: number;
	location_id: number;
	correct_x: number;
	correct_y: number;
	label: string | null;
	guesses: {
		user_id: number;
		team: TeamId;
		x: number | null;
		y: number | null;
		score: number;
		distance: number | null;
	}[];
	team_scores: Record<TeamId, number>;
};

type TeamRoom = {
	code: string;
	hostId: number;
	rounds: number;
	members: Map<number, Member>;
	status: "lobby" | "playing" | "finished";
	phase: "ready" | "guessing" | "reveal" | null;
	phaseEndsAt: number;
	locations: Location[];
	roundNumber: number;
	round: Round | null;
	totals: Record<TeamId, number>;
	/** Rounds each team has taken outright this game. A drawn round counts for neither. */
	roundsWon: Record<TeamId, number>;
	reveal: Reveal | null;
	/** Reactions sent in the last few seconds, numbered so a browser can tell which it has shown. */
	emotes: { id: number; user_id: number; emote: string; at: number }[];
	emoteSeq: number;
	touchedAt: number;
};

const rooms = new Map<string, TeamRoom>();

/* ---- Change notices ---- */

const changed = new Set<string>();
let listener: ((code: string) => void) | null = null;

/** Called once per changed room, after the change, so the socket can send each player their state. */
export function onTeamRoomChanged(fn: (code: string) => void) {
	listener = fn;
}

function markChanged(code: string) {
	if (changed.size === 0)
		queueMicrotask(() => {
			const codes = [...changed];
			changed.clear();
			for (const c of codes) listener?.(c);
		});
	changed.add(code);
}

const isAway = (m: Member, now: number) => m.seenAt === 0 || (m.pages === 0 && now - m.seenAt >= AWAY_MS);

export function teamRoomCount(): number {
	return rooms.size;
}

export function teamGamesInProgress(): number {
	return [...rooms.values()].filter((room) => room.status === "playing").length;
}

function newCode(): string {
	for (;;) {
		let code = "";
		for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
		if (!rooms.has(code)) return code;
	}
}

function member(user: User): Member {
	return {
		userId: user.id,
		username: user.username,
		displayName: user.display_name || user.username,
		avatarUrl: user.avatar_url,
		team: null,
		seenAt: Date.now(),
		pages: 0,
		pin: null,
		outcome: null,
		best: 0,
		counted: 0,
	};
}

const onTeam = (room: TeamRoom, team: TeamId) => [...room.members.values()].filter((m) => m.team === team);
const smallerTeam = (room: TeamRoom): TeamId => (onTeam(room, "b").length < onTeam(room, "a").length ? "b" : "a");

export function createTeamRoom(user: User, rounds: number): string {
	if (rooms.size >= MAX_ROOMS) pruneTeamRooms();
	if (rooms.size >= MAX_ROOMS) fail(503, "The server is busy. Try again in a moment.");
	const host = { ...member(user), team: "a" as TeamId };
	const room: TeamRoom = {
		code: newCode(),
		hostId: user.id,
		rounds,
		members: new Map([[user.id, host]]),
		status: "lobby",
		phase: null,
		phaseEndsAt: 0,
		locations: [],
		roundNumber: 0,
		round: null,
		totals: { a: 0, b: 0 },
		roundsWon: { a: 0, b: 0 },
		reveal: null,
		emotes: [],
		emoteSeq: 0,
		touchedAt: Date.now(),
	};
	rooms.set(room.code, room);
	return room.code;
}

function getRoom(code: string): TeamRoom {
	const room = rooms.get(code.toUpperCase()) ?? fail(404, "That room doesn't exist or has closed.");
	room.touchedAt = Date.now();
	return room;
}

/** The caller's seat in the room. Anything a player does also counts as them being here. */
function getMember(room: TeamRoom, user: User): Member {
	const me = room.members.get(user.id) ?? fail(403, "You are not in this room.");
	me.seenAt = Date.now();
	return me;
}

export function joinTeamRoom(code: string, user: User) {
	const room = getRoom(code);
	if (room.members.has(user.id)) return;
	if (room.status !== "lobby") fail(409, "That game has already started.");
	if (room.members.size >= TEAM_SIZE * 2) fail(409, "That room is full.");
	room.members.set(user.id, { ...member(user), team: smallerTeam(room) });
	markChanged(room.code);
}

export function chooseTeam(code: string, user: User, team: unknown) {
	const room = getRoom(code);
	const me = getMember(room, user);
	if (room.status !== "lobby") fail(409, "Teams are locked once the game starts.");
	if (team !== "a" && team !== "b") fail(400, "Pick one of the two teams.");
	if (me.team === team) return;
	if (onTeam(room, team).length >= TEAM_SIZE) fail(409, "That team is full.");
	me.team = team;
	markChanged(room.code);
}

export function setTeamRounds(code: string, user: User, rounds: number) {
	const room = getRoom(code);
	getMember(room, user);
	if (room.hostId !== user.id) fail(403, "Only the host can change the number of rounds.");
	if (room.status !== "lobby") fail(409, "The number of rounds is fixed once the game starts.");
	room.rounds = rounds;
	markChanged(room.code);
}

export function leaveTeamRoom(code: string, user: User) {
	const room = rooms.get(code.toUpperCase());
	if (!room?.members.has(user.id)) return;
	if (room.status === "playing") {
		/** Their team plays on without them; their seat stays so the scoreboard still makes sense. */
		room.members.get(user.id)!.seenAt = 0;
	} else {
		room.members.delete(user.id);
	}
	markChanged(room.code);
	const anyoneLeft = [...room.members.values()].some((m) => m.seenAt > 0);
	if (!anyoneLeft) return void rooms.delete(room.code);
	if (room.hostId === user.id) room.hostId = [...room.members.values()].find((m) => m.seenAt > 0)!.userId;
}

/** A page on the room's socket opened, closed, was hidden or was shown again. */
export function setTeamPresence(code: string, userId: number, here: boolean) {
	const room = rooms.get(code);
	const m = room?.members.get(userId);
	if (!room || !m) return;
	m.pages = Math.max(0, m.pages + (here ? 1 : -1));
	if (m.seenAt !== 0) m.seenAt = Date.now();
	markChanged(code);
	/** Shows them as away, and stops waiting on their guess, once the grace time is up. */
	if (!here && m.pages === 0)
		setTimeout(() => {
			if (rooms.get(code) !== room || !isAway(m, Date.now())) return;
			advance(room, Date.now());
			markChanged(code);
		}, AWAY_MS + 100);
}

function startRound(room: TeamRoom, now: number) {
	room.roundNumber++;
	room.reveal = null;
	for (const m of room.members.values()) {
		m.pin = null;
		m.outcome = null;
	}
	/** The clock starts after the "get ready" count, while browsers preload the screenshot. */
	room.round = new Round(room.locations[room.roundNumber - 1], TEAM_RULES, now + READY_SECONDS * 1000);
	room.phase = "ready";
	room.phaseEndsAt = now + READY_SECONDS * 1000;
}

export function startTeamGame(code: string, user: User) {
	const room = getRoom(code);
	getMember(room, user);
	if (room.hostId !== user.id) fail(403, "Only the host can start the game.");
	if (room.status === "playing") fail(409, "The game has already started.");
	if (TEAMS.some((team) => onTeam(room, team).length === 0)) fail(409, "Both teams need at least one player.");

	const locations = pickLocations(room.rounds);
	if (!locations.length) fail(503, "No locations available yet. Check back later.");
	Object.assign(room, {
		status: "playing",
		locations,
		rounds: locations.length,
		roundNumber: 0,
		totals: { a: 0, b: 0 },
		roundsWon: { a: 0, b: 0 },
	});
	for (const m of room.members.values()) Object.assign(m, { best: 0, counted: 0 });
	startRound(room, Date.now());
	markChanged(room.code);
	auditLog(user, "team_game_start", {
		details: `${room.code}: ${TEAMS.map((t) =>
			onTeam(room, t)
				.map((m) => m.username)
				.join(" + ")
		).join(" vs ")}`,
	});
}

export function resetTeamRoom(code: string, user: User) {
	const room = getRoom(code);
	getMember(room, user);
	if (room.hostId !== user.id) fail(403, "Only the host can start another game.");
	if (room.status !== "finished") fail(409, "The game is still going.");
	Object.assign(room, {
		status: "lobby",
		phase: null,
		round: null,
		reveal: null,
		roundNumber: 0,
		totals: { a: 0, b: 0 },
	});
	for (const [id, m] of room.members) if (m.seenAt === 0) room.members.delete(id);
	markChanged(room.code);
}

export function moveTeamPin(code: string, user: User, pin: Guess | null) {
	const room = getRoom(code);
	const me = getMember(room, user);
	if (room.phase !== "guessing" || me.outcome) return;
	me.pin = pin;
	markChanged(room.code);
}

export function sendTeamEmote(code: string, user: User, emote: unknown) {
	const room = getRoom(code);
	const me = getMember(room, user);
	const now = Date.now();
	if (!features().duel_emotes || typeof emote !== "string" || !GAME.duel.emotes.includes(emote)) return;
	if (now - (me.lastEmoteAt ?? 0) < GAME.duel.emoteCooldownMs) return;
	me.lastEmoteAt = now;
	room.emotes = room.emotes.filter((e) => now - e.at < EMOTE_TTL_MS);
	room.emotes.push({ id: ++room.emoteSeq, user_id: user.id, emote, at: now });
	markChanged(room.code);
}

export function submitTeamGuess(code: string, user: User, guess: Guess | null) {
	const room = getRoom(code);
	const me = getMember(room, user);
	if (room.phase !== "guessing" || !room.round) fail(409, "There is no round to guess in right now.");
	if (me.outcome) fail(409, "You have already guessed this round.");
	me.outcome = room.round.score(guess);
	me.pin = me.outcome.guess;
	advance(room, Date.now());
	markChanged(room.code);
}

function finishRound(room: TeamRoom, now: number) {
	const round = room.round!;
	const playing = [...room.members.values()].filter((m) => m.team);
	for (const m of playing) m.outcome ??= round.score(null, now);
	/** A team's round is its best guess, so one good guess is enough and a miss costs nothing. */
	const teamScores = { a: 0, b: 0 };
	for (const m of playing) teamScores[m.team!] = Math.max(teamScores[m.team!], m.outcome!.score);
	for (const team of TEAMS) room.totals[team] += teamScores[team];
	if (teamScores.a !== teamScores.b) room.roundsWon[teamScores.a > teamScores.b ? "a" : "b"]++;
	for (const m of playing) {
		m.best = Math.max(m.best, m.outcome!.score);
		if (m.outcome!.score > 0 && m.outcome!.score === teamScores[m.team!]) m.counted++;
	}

	room.reveal = {
		round: room.roundNumber,
		...round.answer(),
		guesses: playing.map((m) => ({
			user_id: m.userId,
			team: m.team!,
			x: m.outcome!.guess?.x ?? null,
			y: m.outcome!.guess?.y ?? null,
			score: m.outcome!.score,
			distance: m.outcome!.distance === null ? null : Math.round(m.outcome!.distance),
		})),
		team_scores: teamScores,
	};
	room.round = null;
	room.phase = "reveal";
	room.phaseEndsAt = now + REVEAL_SECONDS * 1000;
}

/** Moves a room on if its current step is over. Safe to call as often as you like. */
function advance(room: TeamRoom, now: number) {
	if (room.status !== "playing") return;
	const step = `${room.phase}:${room.roundNumber}`;
	moveOn(room, now);
	if (`${room.phase}:${room.roundNumber}` !== step) markChanged(room.code);
}

function moveOn(room: TeamRoom, now: number) {
	if (room.phase === "ready" && now >= room.phaseEndsAt) {
		room.phase = "guessing";
		room.phaseEndsAt = now + (TEAM_RULES.timeLimit + GAME.lateGuessGrace) * 1000;
	}
	if (room.phase === "guessing") {
		const waitingFor = [...room.members.values()].filter((m) => m.team && !m.outcome && !isAway(m, now));
		if (waitingFor.length === 0 || now >= room.phaseEndsAt) finishRound(room, now);
	}
	if (room.phase === "reveal" && now >= room.phaseEndsAt) {
		if (room.roundNumber < room.rounds) return startRound(room, now);
		room.status = "finished";
		room.phase = null;
		auditLog(null, "team_game_end", { details: `${room.code}: ${room.totals.a} to ${room.totals.b}` });
	}
}

/** Everything one player may know about their room right now. Never the answer before the reveal. */
export function teamRoomState(code: string, user: User) {
	const room = getRoom(code);
	getMember(room, user);
	return roomView(room, user.id);
}

/** The same for the socket, which does not count as the player doing anything. */
export function teamRoomStateFor(code: string, userId: number) {
	const room = rooms.get(code.toUpperCase()) ?? fail(404, "That room doesn't exist or has closed.");
	if (!room.members.has(userId)) fail(403, "You are not in this room.");
	return roomView(room, userId);
}

function roomView(room: TeamRoom, userId: number) {
	const me = room.members.get(userId)!;
	const now = Date.now();
	advance(room, now);

	const live = room.phase === "ready" || room.phase === "guessing";
	return {
		code: room.code,
		status: room.status,
		phase: room.phase,
		host_id: room.hostId,
		you: { id: me.userId, team: me.team, guessed: !!me.outcome },
		rounds: room.rounds,
		round_number: room.roundNumber,
		totals: room.totals,
		members: [...room.members.values()].map((m) => ({
			id: m.userId,
			username: m.username,
			display_name: m.displayName,
			avatar_url: m.avatarUrl,
			team: m.team,
			guessed: !!m.outcome,
			away: isAway(m, now),
		})),
		round:
			live && room.round
				? {
						image_url: uploadUrl(room.locations[room.roundNumber - 1].image_path),
						location_id: room.locations[room.roundNumber - 1].id,
						time_limit: TEAM_RULES.timeLimit,
						time_remaining: Math.ceil(room.round.remaining(now) ?? 0),
						starts_in: room.phase === "ready" ? Math.max(0, Math.ceil((room.phaseEndsAt - now) / 1000)) : 0,
					}
				: null,
		/** Only your own side's pins, so the other team learns nothing from them. */
		team_pins: live
			? [...room.members.values()]
					.filter((m) => m.team === me.team && m.userId !== me.userId && m.pin)
					.map((m) => ({ id: m.userId, x: m.pin!.x, y: m.pin!.y, locked: !!m.outcome }))
			: [],
		reveal: room.phase === "reveal" || room.status === "finished" ? room.reveal : null,
		emote_list: offeredEmotes(),
		emotes: room.emotes
			.filter((e) => now - e.at < EMOTE_TTL_MS)
			.map(({ id, user_id, emote }) => ({ id, user_id, emote })),
		summary:
			room.status === "finished"
				? {
						rounds_won: room.roundsWon,
						players: [...room.members.values()]
							.filter((m) => m.team)
							.map((m) => ({ id: m.userId, best: m.best, counted: m.counted })),
					}
				: null,
		next_in: room.phase === "reveal" ? Math.max(0, Math.ceil((room.phaseEndsAt - now) / 1000)) : 0,
		/** Time left in the get-ready count or the reveal, for the page to count down itself. */
		phase_ms_left: room.phase === "ready" || room.phase === "reveal" ? Math.max(0, room.phaseEndsAt - now) : 0,
		winner:
			room.status === "finished"
				? room.totals.a === room.totals.b
					? "tie"
					: room.totals.a > room.totals.b
						? "a"
						: "b"
				: null,
	};
}

/** Keeps games moving when nobody happens to be asking, and clears out rooms left behind. */
export function tickTeamRooms(now = Date.now()) {
	for (const room of rooms.values()) {
		try {
			advance(room, now);
		} catch (err) {
			console.error(`[teams] Room ${room.code} failed:`, err);
			rooms.delete(room.code);
			markChanged(room.code);
		}
	}
}

export function pruneTeamRooms(now = Date.now()) {
	for (const [code, room] of rooms) {
		if (now - room.touchedAt > IDLE_TTL_MS) {
			rooms.delete(code);
			markChanged(code);
		}
	}
}

/** Closes every room ahead of a restart. */
export function closeTeamRooms() {
	for (const code of rooms.keys()) markChanged(code);
	rooms.clear();
}

export function removeFromTeamRooms(user: User) {
	for (const room of [...rooms.values()]) if (room.members.has(user.id)) leaveTeamRoom(room.code, user);
}
