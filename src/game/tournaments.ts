import { GAME } from "../config";
import { db, type User } from "../db";
import { nudgeTournament } from "../events";
import { auditLog } from "../lib/audit";
import { fail } from "../lib/http";
import { checkUserRateLimit } from "../lib/rate-limit";
import { HOUR } from "../lib/time";
import { notifyUser } from "../notifications";
import { restartIn } from "../system/restart";
import { cancelQuickplay } from "./duels/matchmaking";
import {
	closeDuelByStaff,
	createRoom,
	duelRooms,
	joinRoom,
	leaveWaitingRoom,
	onTournamentDuelEnd,
	type DuelRoom,
} from "./duels/rooms";

/**
 * Tournaments: one knockout bracket played one match at a time, so everyone watches the same duel.
 * Staff pick the players; whoever checks in gets a place. Between matches there is a break with a countdown.
 */

export type TournamentStatus = "draft" | "open" | "live" | "finished" | "cancelled";

export type Settings = {
	rounds: number;
	semiRounds: number;
	finalRounds: number;
	/** Seconds. */
	breaks: { start: number; match: number; round: number; final: number };
	thirdPlace: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
	rounds: 3,
	semiRounds: 5,
	finalRounds: 5,
	breaks: { start: 300, match: 60, round: 180, final: 180 },
	thirdPlace: false,
};

/** How long a finished tournament's results stay on the home page unless staff change it. */
const RESULTS_HOURS = 12;

export const LIMITS = {
	players: 64,
	roster: 128,
	breakMin: 10,
	breakMax: 3600,
	title: 80,
	description: 500,
	message: 200,
};

type Side = number | null;
type Decided = "sudden_death" | "tiebreak" | "forfeit" | "no_show" | "staff" | "bye" | null;

type Match = {
	id: number;
	round: number;
	index: number;
	players: [Side, Side];
	/** A side nobody will fill: a bye, or a player who was taken out. */
	closed: [boolean, boolean];
	winner: Side;
	status: "waiting" | "live" | "done";
	scores: [number, number] | null;
	decided: Decided;
	gameId: number | null;
	code: string | null;
	third?: boolean;
};

type BreakLabel = "start" | "match" | "round" | "final";

type Phase =
	| { kind: "lobby" }
	| { kind: "break"; label: BreakLabel; matchId: number | null; endsAt: number }
	| { kind: "hold"; matchId: number | null; reason: HoldReason }
	| { kind: "match"; matchId: number; code: string }
	| { kind: "result"; matchId: number; endsAt: number }
	| { kind: "done" };

type HoldReason = "not_ready" | "no_show" | "no_winner" | "closed" | "restart" | "staff";

type State = {
	matches: Match[];
	rounds: number;
	phase: Phase;
	/** Milliseconds left when staff paused. */
	paused: number | null;
	ready: number[];
	message: { text: string; at: number } | null;
	/** Byes and walkovers just settled, shown once. */
	notice: { text: string; at: number } | null;
	championId: number | null;
	/** Spectators' picks: match id, then user id, then side. */
	votes: Record<string, Record<string, 0 | 1>>;
};

type Tournament = {
	id: number;
	title: string;
	description: string;
	status: TournamentStatus;
	startsAt: number | null;
	settings: Settings;
	state: State;
	version: number;
};

type Row = {
	id: number;
	title: string;
	description: string;
	status: TournamentStatus;
	starts_at: number | null;
	settings: string;
	state: string | null;
	winner_id: number | null;
	created_at: number;
	started_at: number | null;
	finished_at: number | null;
	results_until: number | null;
	/** Anyone with this code can join while check-in is open; null when invites are off. */
	invite_code: string | null;
};

/** How long the duel's end screen stays up. */
const RESULT_MS = 14_000;
const FORFEIT_RESULT_MS = 8000;
/** Once both players are ready, a match break is cut down to this. */
const READY_MS = 10_000;
/** Time for both players to join their match. */
const JOIN_MS = 90_000;
const ADD_TIME_MS = 60_000;
const RESTART_BREAK_S = 30;

/** The numbers the staff panel's guide quotes, so it always matches what the server does. */
export function tournamentRules() {
	return {
		...LIMITS,
		minRounds: GAME.duel.minRounds,
		maxRounds: GAME.duel.maxRounds,
		roundSeconds: GAME.duel.roundTime,
		reconnectSeconds: GAME.duel.reconnectWindow,
		joinSeconds: JOIN_MS / 1000,
		readySeconds: READY_MS / 1000,
		addTimeSeconds: ADD_TIME_MS / 1000,
		restartBreakSeconds: RESTART_BREAK_S,
		resultsHours: RESULTS_HOURS,
	};
}

let active: Tournament | null = null;
let phaseTimer: ReturnType<typeof setTimeout> | null = null;
let joinTimer: ReturnType<typeof setTimeout> | null = null;
let voteTimer: ReturnType<typeof setTimeout> | null = null;
let results: { id: number; title: string; until: number; version: number } | null = null;
let resultsTimer: ReturnType<typeof setTimeout> | null = null;

const emptyState = (): State => ({
	matches: [],
	rounds: 0,
	phase: { kind: "lobby" },
	paused: null,
	ready: [],
	message: null,
	notice: null,
	championId: null,
	votes: {},
});

function parseJson<T>(raw: string | null, fallback: T): T {
	try {
		return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
	} catch {
		return fallback;
	}
}

function fromRow(row: Row): Tournament {
	const settings = parseJson(row.settings, DEFAULT_SETTINGS);
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		status: row.status,
		startsAt: row.starts_at,
		settings: { ...settings, breaks: { ...DEFAULT_SETTINGS.breaks, ...settings.breaks } },
		state: parseJson(row.state, emptyState()),
		version: Date.now(),
	};
}

const getRow = (id: number) => db.query<Row, [number]>("SELECT * FROM tournaments WHERE id = ?").get(id);

/** The one in memory if it is the one asked for, so timers and state stay in one place. */
function load(id: number): Tournament {
	if (active?.id === id) return active;
	const row = getRow(id);
	if (!row) fail(404, "Tournament not found");
	return fromRow(row);
}

function save(t: Tournament) {
	db.run(
		"UPDATE tournaments SET title = ?, description = ?, status = ?, starts_at = ?, settings = ?, state = ?, winner_id = ? WHERE id = ?",
		[
			t.title,
			t.description,
			t.status,
			t.startsAt,
			JSON.stringify(t.settings),
			JSON.stringify(t.state),
			t.state.championId,
			t.id,
		]
	);
}

/** Saves and tells every open page. */
function changed(t: Tournament) {
	t.version++;
	save(t);
	if (t.status === "open" || t.status === "live") active = t;
	else if (active?.id === t.id) {
		active = null;
		clearTimers();
	}
	nudgeTournament(currentSummary());
}

function clearTimers() {
	if (phaseTimer) clearTimeout(phaseTimer);
	if (joinTimer) clearTimeout(joinTimer);
	phaseTimer = joinTimer = null;
}

/** The tournament that is on, or one whose results are still on show. */
export function currentSummary() {
	if (active)
		return {
			id: active.id,
			title: active.title,
			status: active.status,
			phase: active.state.phase.kind,
			version: active.version,
		};
	if (results && results.until > Date.now())
		return { id: results.id, title: results.title, status: "finished", phase: "done", version: results.version };
	return null;
}

function loadResults() {
	if (resultsTimer) clearTimeout(resultsTimer);
	resultsTimer = null;
	const row = db
		.query<{ id: number; title: string; results_until: number }, [number]>(
			"SELECT id, title, results_until FROM tournaments WHERE status = 'finished' AND results_until > ? ORDER BY results_until DESC LIMIT 1"
		)
		.get(Math.floor(Date.now() / 1000));
	results = row ? { id: row.id, title: row.title, until: row.results_until * 1000, version: Date.now() } : null;
	if (!results) return;
	/** Timers cap at about 24 days; a later time is checked again then. */
	resultsTimer = setTimeout(
		() => {
			loadResults();
			nudgeTournament(currentSummary());
		},
		Math.min(results.until - Date.now() + 1000, 2 ** 31 - 1)
	);
}

/* ---- The bracket ---- */

/** Seed positions so the top seeds meet last: 1v8, 4v5, 2v7, 3v6 for eight. */
function seedOrder(size: number): number[] {
	let order = [1];
	while (order.length < size) {
		const n = order.length * 2 + 1;
		order = order.flatMap((seed) => [seed, n - seed]);
	}
	return order;
}

function buildBracket(playerIds: number[], thirdPlace: boolean): { matches: Match[]; rounds: number } {
	let size = 2;
	while (size < playerIds.length) size *= 2;
	const rounds = Math.log2(size);
	const order = seedOrder(size);
	const matches: Match[] = [];
	for (let round = 0; round < rounds; round++) {
		for (let index = 0; index < size / 2 ** (round + 1); index++) {
			const match: Match = {
				id: matches.length,
				round,
				index,
				players: [null, null],
				closed: [false, false],
				winner: null,
				status: "waiting",
				scores: null,
				decided: null,
				gameId: null,
				code: null,
			};
			if (round === 0) {
				for (const side of [0, 1] as const) {
					const seed = order[index * 2 + side];
					match.players[side] = playerIds[seed - 1] ?? null;
					match.closed[side] = seed > playerIds.length;
				}
			}
			matches.push(match);
		}
	}
	if (thirdPlace && rounds >= 2) {
		matches.push({
			id: matches.length,
			round: rounds - 1,
			index: 1,
			players: [null, null],
			closed: [false, false],
			winner: null,
			status: "waiting",
			scores: null,
			decided: null,
			gameId: null,
			code: null,
			third: true,
		});
	}
	return { matches, rounds };
}

const matchAt = (s: State, round: number, index: number) =>
	s.matches.find((m) => m.round === round && m.index === index) ?? null;

const feeder = (s: State, m: Match, side: 0 | 1) =>
	m.round === 0 ? null : matchAt(s, m.round - 1, m.third ? side : m.index * 2 + side);

/** True once we know who, if anyone, plays on this side. */
function sideKnown(s: State, m: Match, side: 0 | 1): boolean {
	const from = feeder(s, m, side);
	return !from || from.status === "done";
}

function roundName(s: State, round: number): string {
	const fromEnd = s.rounds - 1 - round;
	if (fromEnd === 0) return "Final";
	if (fromEnd === 1) return "Semi-finals";
	if (fromEnd === 2) return "Quarter-finals";
	return `Round ${round + 1}`;
}

const matchName = (s: State, m: Match) => (m.third ? "Third place" : roundName(s, m.round));

/** Round by round, with third place just before the final. */
const playOrder = (a: Match, b: Match) => a.round - b.round || (a.third ? -1 : a.index) - (b.third ? -1 : b.index);

function roundsFor(t: Tournament, m: Match): number {
	if (m.third) return t.settings.semiRounds;
	const fromEnd = t.state.rounds - 1 - m.round;
	return fromEnd === 0 ? t.settings.finalRounds : fromEnd === 1 ? t.settings.semiRounds : t.settings.rounds;
}

function propagate(s: State, m: Match) {
	if (m.third) return;
	/** Semi-final losers go on to the match for third place. */
	const third = m.round === s.rounds - 2 ? s.matches.find((x) => x.third) : undefined;
	if (third) {
		const loser = m.players.find((p, i) => p !== null && p !== m.winner && !m.closed[i]) ?? null;
		third.players[m.index as 0 | 1] = loser;
		third.closed[m.index as 0 | 1] = loser === null;
	}
	if (m.round === s.rounds - 1) {
		s.championId = m.winner;
		return;
	}
	const next = matchAt(s, m.round + 1, Math.floor(m.index / 2))!;
	const side = (m.index % 2) as 0 | 1;
	next.players[side] = m.winner;
	next.closed[side] = m.winner === null;
}

function settle(s: State, m: Match, winner: Side, decided: Decided) {
	m.status = "done";
	m.winner = winner;
	m.decided = decided;
	m.code = null;
	propagate(s, m);
}

/** The next match, settling byes on the way. Settled only when reached, so staff can fill an empty place until then. */
function pickNext(t: Tournament): Match | null {
	const s = t.state;
	const names: string[] = [];
	for (;;) {
		const m = [...s.matches]
			.filter((x) => x.status === "waiting" && sideKnown(s, x, 0) && sideKnown(s, x, 1))
			.sort(playOrder)[0];
		if (!m) break;
		const [a, b] = m.players;
		const aOut = a === null || m.closed[0];
		const bOut = b === null || m.closed[1];
		if (!aOut && !bOut) {
			if (names.length) s.notice = { text: `${names.join(", ")} through without playing`, at: Date.now() };
			return m;
		}
		const winner = aOut ? (bOut ? null : b) : a;
		settle(s, m, winner, "bye");
		if (winner !== null) names.push(userName(winner));
	}
	if (names.length) s.notice = { text: `${names.join(", ")} through without playing`, at: Date.now() };
	return null;
}

const userName = (id: number) =>
	db
		.query<{ name: string }, [number]>("SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?")
		.get(id)?.name ?? "A player";

/* ---- Running it ---- */

function arm(t: Tournament) {
	if (phaseTimer) clearTimeout(phaseTimer);
	phaseTimer = null;
	const phase = t.state.phase;
	if (t.state.paused !== null || (phase.kind !== "break" && phase.kind !== "result")) return;
	phaseTimer = setTimeout(
		() => {
			phaseTimer = null;
			if (active !== t) return;
			try {
				if (t.state.phase.kind === "break") tryStart(t);
				else if (t.state.phase.kind === "result") advance(t);
			} catch (err) {
				console.error(`[tournament] ${t.id} failed to move on:`, err);
			}
		},
		Math.max(0, phase.endsAt - Date.now())
	);
}

function setPhase(t: Tournament, phase: Phase) {
	t.state.phase = phase;
	t.state.paused = null;
	if (phase.kind !== "break" && phase.kind !== "hold") t.state.ready = [];
	arm(t);
	changed(t);
}

function breakFor(t: Tournament, m: Match, label: BreakLabel, seconds?: number, ready: number[] = []) {
	t.state.ready = ready;
	setPhase(t, {
		kind: "break",
		label,
		matchId: m.id,
		endsAt: Date.now() + (seconds ?? t.settings.breaks[label]) * 1000,
	});
	for (const player of m.players) {
		notifyUser(player, "reminders", {
			title: `Your match in ${t.title} is up next`,
			body: "Open the tournament and press Ready.",
			link: `/tournament/${t.id}`,
		});
	}
}

function advance(t: Tournament) {
	const s = t.state;
	const lastRound = Math.max(
		-1,
		...s.matches.filter((m) => m.status === "done" && m.gameId !== null).map((m) => m.round)
	);
	const next = pickNext(t);
	if (!next) return finish(t);
	const label: BreakLabel =
		next.round === s.rounds - 1 && !next.third
			? "final"
			: next.third || (next.round > lastRound && lastRound >= 0)
				? "round"
				: "match";
	breakFor(t, next, label);
}

function finish(t: Tournament) {
	clearTimers();
	t.status = "finished";
	t.state.phase = { kind: "done" };
	t.state.paused = null;
	db.run(
		"UPDATE tournaments SET status = 'finished', finished_at = unixepoch(), results_until = unixepoch() + ? WHERE id = ?",
		[RESULTS_HOURS * 3600, t.id]
	);
	loadResults();
	auditLog(null, "tournament_finish", {
		targetType: "tournament",
		targetId: t.id,
		details: `${t.title}: won by ${t.state.championId ? userName(t.state.championId) : "nobody"}`,
	});
	changed(t);
}

/** Starts the match if both players are ready; otherwise staff decide. */
function tryStart(t: Tournament) {
	const phase = t.state.phase;
	if (phase.kind !== "break" && phase.kind !== "hold") return;
	const m = phase.matchId === null ? null : t.state.matches[phase.matchId];
	if (!m || m.status !== "waiting") return advance(t);
	const [a, b] = m.players;
	if (a === null || b === null || m.closed.some(Boolean)) return advance(t);
	if (!t.state.ready.includes(a) || !t.state.ready.includes(b))
		return setPhase(t, { kind: "hold", matchId: m.id, reason: "not_ready" });
	startMatch(t, m);
}

/** Takes a player out of Quick Play and any waiting room, so they are only in their match. */
function freeForMatch(userId: number) {
	cancelQuickplay(userId);
	for (const room of [...duelRooms.values()])
		if (room.status === "waiting" && !room.tournament && room.players.some((p) => p.userId === userId))
			leaveWaitingRoom(room, userId);
}

function startMatch(t: Tournament, m: Match) {
	const [a, b] = m.players as [number, number];
	if (restartIn() !== null) return setPhase(t, { kind: "hold", matchId: m.id, reason: "restart" });
	freeForMatch(a);
	freeForMatch(b);
	const room = createRoom(a, roundsFor(t, m), false, false, { id: t.id, matchId: m.id });
	joinRoom(room.code, b);
	m.status = "live";
	m.code = room.code;
	m.gameId = room.dbId;
	m.scores = null;
	auditLog(null, "tournament_match_start", {
		targetType: "tournament",
		targetId: t.id,
		details: `${userName(a)} vs ${userName(b)}, ${matchName(t.state, m)}, room ${room.code}`,
	});
	setPhase(t, { kind: "match", matchId: m.id, code: room.code });
	if (joinTimer) clearTimeout(joinTimer);
	joinTimer = setTimeout(() => noShow(t, m, room), JOIN_MS);
}

function noShow(t: Tournament, m: Match, room: DuelRoom) {
	joinTimer = null;
	if (active !== t || m.code !== room.code || room.status !== "waiting") return;
	const here = room.players.filter((p) => p.connected).map((p) => p.userId);
	detach(room);
	if (here.length === 1) {
		settle(t.state, m, here[0], "no_show");
		return setPhase(t, { kind: "result", matchId: m.id, endsAt: Date.now() + FORFEIT_RESULT_MS });
	}
	m.status = "waiting";
	m.code = null;
	setPhase(t, { kind: "hold", matchId: m.id, reason: "no_show" });
}

/** Closes a match's room without it counting as a result. */
function detach(room: DuelRoom | undefined) {
	if (!room) return;
	room.tournament = null;
	closeDuelByStaff(room.code);
}

onTournamentDuelEnd((room, winnerId, how) => {
	const t = active;
	const ref = room.tournament;
	if (!t || !ref || ref.id !== t.id) return;
	const m = t.state.matches[ref.matchId];
	if (!m || m.status !== "live" || m.code !== room.code) return;
	if (joinTimer) clearTimeout(joinTimer);
	joinTimer = null;
	const scoreOf = (id: Side) => room.players.find((p) => p.userId === id)?.totalScore ?? 0;
	m.scores = [scoreOf(m.players[0]), scoreOf(m.players[1])];
	if (winnerId === null) {
		m.status = "waiting";
		m.code = null;
		return setPhase(t, { kind: "hold", matchId: m.id, reason: how === "closed" ? "closed" : "no_winner" });
	}
	const decided: Decided =
		how === "abandoned"
			? "forfeit"
			: room.suddenDeath?.winnerId
				? "sudden_death"
				: m.scores[0] === m.scores[1]
					? "tiebreak"
					: null;
	settle(t.state, m, winnerId, decided);
	setPhase(t, {
		kind: "result",
		matchId: m.id,
		endsAt: Date.now() + (how === "finished" ? RESULT_MS : FORFEIT_RESULT_MS),
	});
});

/* ---- What pages see ---- */

/** `invite_code` is the code a player joined with, or null if staff added them. */
type Roster = { user_id: number; checked_in: number; position: number; invite_code: string | null };

const rosterOf = (id: number) =>
	db
		.query<Roster, [number]>(
			"SELECT user_id, checked_in, position, invite_code FROM tournament_players WHERE tournament_id = ? ORDER BY position, added_at"
		)
		.all(id);

function playerCards(ids: number[]) {
	if (!ids.length) return {};
	const rows = db
		.query<{ id: number; username: string; display_name: string | null; avatar_url: string | null }, number[]>(
			`SELECT id, username, display_name, avatar_url FROM users WHERE id IN (${ids.map(() => "?").join(",")})`
		)
		.all(...ids);
	return Object.fromEntries(rows.map((u) => [u.id, u]));
}

function stateView(t: Tournament) {
	const s = t.state;
	const roster = rosterOf(t.id);
	const ids = new Set<number>(roster.map((r) => r.user_id));
	for (const m of s.matches) for (const p of m.players) if (p !== null) ids.add(p);
	const phase = s.phase;
	return {
		id: t.id,
		title: t.title,
		description: t.description,
		status: t.status,
		starts_at: t.startsAt,
		settings: t.settings,
		now: Date.now(),
		version: t.version,
		players: playerCards([...ids]),
		roster: roster.map((r) => ({ user_id: r.user_id, checked_in: !!r.checked_in })),
		rounds: Array.from({ length: s.rounds }, (_, round) => ({
			name: roundName(s, round),
			match_rounds: roundsFor(t, { round } as Match),
			matches: s.matches
				.filter((m) => m.round === round)
				.map((m) => ({
					id: m.id,
					index: m.index,
					third: !!m.third,
					name: matchName(s, m),
					match_rounds: roundsFor(t, m),
					votes: tally(s, m.id),
					players: m.players,
					closed: m.closed,
					winner: m.winner,
					status: m.status,
					scores: m.scores,
					decided: m.decided,
					code: m.code,
					game_id: m.gameId,
				})),
		})),
		phase: {
			kind: phase.kind,
			label: phase.kind === "break" ? phase.label : null,
			match_id: "matchId" in phase ? phase.matchId : null,
			code: phase.kind === "match" ? phase.code : null,
			ends_at: "endsAt" in phase ? phase.endsAt : null,
			reason: phase.kind === "hold" ? phase.reason : null,
			paused_left: s.paused,
		},
		ready: s.ready,
		message: s.message,
		notice: s.notice,
		champion: s.championId,
		results_until: t.status === "finished" ? (getRow(t.id)?.results_until ?? null) : null,
		invite_open: !!getRow(t.id)?.invite_code,
	};
}

function tally(s: State, matchId: number): [number, number] | null {
	const picks = Object.values(s.votes?.[matchId] ?? {});
	return picks.length ? [picks.filter((p) => p === 0).length, picks.filter((p) => p === 1).length] : null;
}

/** Drafts are for staff only. */
export function tournamentView(id: number, staff: boolean, viewerId: number | null = null) {
	const t = load(id);
	if (t.status === "draft" && !staff) fail(404, "Tournament not found");
	const myVotes: Record<string, 0 | 1> = {};
	if (viewerId !== null)
		for (const [matchId, picks] of Object.entries(t.state.votes ?? {}))
			if (picks[viewerId] !== undefined) myVotes[matchId] = picks[viewerId];
	return {
		...stateView(t),
		my_votes: myVotes,
		...(staff
			? {
					invite_code: getRow(id)?.invite_code ?? null,
					roster: rosterOf(id).map((r) => ({
						user_id: r.user_id,
						checked_in: !!r.checked_in,
						invite_code: r.invite_code,
					})),
				}
			: {}),
	};
}

/** What a shared link shows: the share image and the page description. Null for drafts and unknown ids. */
export function tournamentShare(id: number) {
	const row = getRow(id);
	if (!row || row.status === "draft") return null;
	const t = load(id);
	const s = t.state;
	const roster = rosterOf(id);
	const players = t.status === "open" ? roster.length : roster.filter((r) => r.checked_in).length;
	const phase = s.phase;
	const current = "matchId" in phase && phase.matchId !== null ? s.matches[phase.matchId] : null;
	const name = (userId: number | null) => (userId === null ? "To be decided" : userName(userId));
	const starts = t.startsAt
		? `Starts ${new Date(t.startsAt * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`
		: null;
	const champion =
		t.status === "finished" && s.championId !== null
			? db
					.query<{ name: string; avatar_url: string | null }, [number]>(
						"SELECT COALESCE(display_name, username) AS name, avatar_url FROM users WHERE id = ?"
					)
					.get(s.championId)
			: null;
	return {
		title: t.title,
		description: t.description,
		status: t.status,
		players,
		detail:
			t.status === "live"
				? current
					? matchName(s, current)
					: "In progress"
				: t.status === "open"
					? starts
					: null,
		match:
			t.status === "live" && current
				? `${phase.kind === "match" ? "Now playing" : "Up next"}: ${name(current.players[0])} vs ${name(current.players[1])}`
				: null,
		champion: champion ? { name: champion.name, avatarUrl: champion.avatar_url } : null,
	};
}

export function pastTournaments() {
	return db
		.query(
			`SELECT t.id, t.title, t.finished_at,
				(SELECT COUNT(*) FROM tournament_players p WHERE p.tournament_id = t.id AND p.checked_in = 1) AS players,
				w.username AS winner_username, w.display_name AS winner_display_name, w.avatar_url AS winner_avatar_url
			FROM tournaments t LEFT JOIN users w ON w.id = t.winner_id
			WHERE t.status = 'finished' ORDER BY t.finished_at DESC LIMIT 20`
		)
		.all();
}

/* ---- Players ---- */

export function checkIn(id: number, user: User) {
	const t = load(id);
	if (t.status !== "open")
		fail(409, t.status === "live" ? "The tournament has already started." : "Check-in isn't open.");
	const result = db.run("UPDATE tournament_players SET checked_in = 1 WHERE tournament_id = ? AND user_id = ?", [
		id,
		user.id,
	]);
	if (!result.changes) fail(403, "You're not on the list for this tournament. Ask staff to add you.");
	changed(t);
}

/** Joins with an invite code: the player goes on the list, already checked in. */
export function joinByInvite(id: number, user: User, code: string) {
	const t = load(id);
	if (!checkUserRateLimit(user, "tournament_join", 10, HOUR * 1000)) fail(429, "Too many tries. Wait a while.");
	const invite = getRow(id)?.invite_code;
	if (!invite || code.trim().toUpperCase() !== invite)
		fail(403, "That invite code isn't right, or it has been turned off.");
	if (t.status !== "open")
		fail(409, t.status === "live" ? "The tournament has already started." : "Check-in isn't open.");
	const limited = db
		.query<{ duel_limited: number }, [number]>("SELECT duel_limited FROM users WHERE id = ?")
		.get(user.id)?.duel_limited;
	if (limited) fail(403, "Your duels are limited, so you can't play in tournaments right now.");
	const onList = rosterOf(id).some((r) => r.user_id === user.id);
	if (!onList && rosterOf(id).length >= LIMITS.roster) fail(409, "The tournament is full.");
	const position =
		(db
			.query<{ n: number | null }, [number]>(
				"SELECT MAX(position) AS n FROM tournament_players WHERE tournament_id = ?"
			)
			.get(id)?.n ?? 0) + 1;
	db.run(
		`INSERT INTO tournament_players (tournament_id, user_id, position, checked_in, invite_code) VALUES (?, ?, ?, 1, ?)
		ON CONFLICT (tournament_id, user_id) DO UPDATE SET checked_in = 1`,
		[id, user.id, position, invite]
	);
	if (!onList)
		auditLog(user, "tournament_invite_join", {
			targetType: "tournament",
			targetId: id,
			details: `${t.title}, code ${invite}`,
		});
	changed(t);
}

export function markReady(id: number, user: User) {
	const t = load(id);
	const phase = t.state.phase;
	if (t.status !== "live" || (phase.kind !== "break" && phase.kind !== "hold") || phase.matchId === null)
		fail(409, "There's nothing to get ready for yet.");
	const m = t.state.matches[phase.matchId];
	if (!m.players.includes(user.id)) fail(403, "It isn't your match.");
	if (!t.state.ready.includes(user.id)) t.state.ready.push(user.id);
	const bothReady = m.players.every((p) => p !== null && t.state.ready.includes(p));
	if (bothReady && phase.kind === "hold") return breakFor(t, m, "match", READY_MS / 1000, t.state.ready);
	if (bothReady && phase.kind === "break" && phase.label === "match" && phase.endsAt - Date.now() > READY_MS) {
		phase.endsAt = Date.now() + READY_MS;
		arm(t);
	}
	changed(t);
}

/** Picks close when the match starts. */
export function vote(id: number, user: User, side: 0 | 1) {
	const t = load(id);
	const phase = t.state.phase;
	if (t.status !== "live" || (phase.kind !== "break" && phase.kind !== "hold") || phase.matchId === null)
		fail(409, "Picks are closed.");
	const m = t.state.matches[phase.matchId];
	if (m.players.includes(user.id)) fail(403, "You can't pick in your own match.");
	if (m.players[side] === null) fail(409, "That place isn't decided yet.");
	((t.state.votes ??= {})[m.id] ??= {})[user.id] = side;
	/** Picks come in bursts, so they go out together. */
	voteTimer ??= setTimeout(() => {
		voteTimer = null;
		if (active === t) changed(t);
	}, 1500);
}

/* ---- Staff ---- */

export type TournamentInput = {
	title?: unknown;
	description?: unknown;
	starts_at?: unknown;
	rounds?: unknown;
	semi_rounds?: unknown;
	final_rounds?: unknown;
	breaks?: unknown;
	third_place?: unknown;
};

const clamp = (value: unknown, fallback: number, min: number, max: number) =>
	typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

function applyInput(t: Pick<Tournament, "title" | "description" | "startsAt" | "settings">, input: TournamentInput) {
	if (input.title !== undefined) {
		const title = typeof input.title === "string" ? input.title.trim().slice(0, LIMITS.title) : "";
		if (!title) fail(400, "Give the tournament a name.");
		t.title = title;
	}
	if (typeof input.description === "string") t.description = input.description.trim().slice(0, LIMITS.description);
	if (input.starts_at !== undefined) {
		const at = typeof input.starts_at === "number" ? input.starts_at : Date.parse(String(input.starts_at ?? ""));
		t.startsAt = Number.isFinite(at) && at > 0 ? Math.floor(at / 1000) : null;
	}
	const { minRounds, maxRounds } = GAME.duel;
	const s = t.settings;
	s.rounds = clamp(input.rounds, s.rounds, minRounds, maxRounds);
	s.semiRounds = clamp(input.semi_rounds, s.semiRounds, minRounds, maxRounds);
	s.finalRounds = clamp(input.final_rounds, s.finalRounds, minRounds, maxRounds);
	const breaks = (input.breaks && typeof input.breaks === "object" ? input.breaks : {}) as Record<string, unknown>;
	for (const key of ["start", "match", "round", "final"] as const)
		s.breaks[key] = clamp(breaks[key], s.breaks[key], LIMITS.breakMin, LIMITS.breakMax);
	if (typeof input.third_place === "boolean") s.thirdPlace = input.third_place;
}

export function createTournament(staff: User, input: TournamentInput): number {
	const draft = {
		title: "",
		description: "",
		startsAt: null as number | null,
		settings: structuredClone(DEFAULT_SETTINGS),
	};
	applyInput(draft, { ...input, title: input.title ?? "" });
	const id = Number(
		db.run(
			"INSERT INTO tournaments (title, description, starts_at, settings, state, created_by) VALUES (?, ?, ?, ?, ?, ?)",
			[
				draft.title,
				draft.description,
				draft.startsAt,
				JSON.stringify(draft.settings),
				JSON.stringify(emptyState()),
				staff.id,
			]
		).lastInsertRowid
	);
	auditLog(staff, "tournament_create", { targetType: "tournament", targetId: id, details: draft.title });
	return id;
}

export function updateTournament(staff: User, id: number, input: TournamentInput) {
	const t = load(id);
	if (t.status === "finished" || t.status === "cancelled") fail(409, "This tournament is over.");
	applyInput(t, input);
	auditLog(staff, "tournament_update", { targetType: "tournament", targetId: id, details: t.title });
	changed(t);
}

export function deleteTournament(staff: User, id: number) {
	const t = load(id);
	if (t.status === "live" || t.status === "open") fail(409, "Cancel the tournament before deleting it.");
	db.run("DELETE FROM tournaments WHERE id = ?", [id]);
	auditLog(staff, "tournament_delete", { targetType: "tournament", targetId: id, details: t.title });
}

export function listTournaments() {
	return db
		.query(
			`SELECT t.id, t.title, t.status, t.starts_at, t.created_at, t.started_at, t.finished_at, t.winner_id,
				w.username AS winner_username, (SELECT COUNT(*) FROM tournament_players p WHERE p.tournament_id = t.id) AS players
			FROM tournaments t LEFT JOIN users w ON w.id = t.winner_id ORDER BY t.id DESC LIMIT 50`
		)
		.all();
}

/** Only one tournament can be open or running at a time. */
export function openTournament(staff: User, id: number) {
	const t = load(id);
	if (t.status !== "draft") fail(409, "Only a draft can be opened.");
	if (active && active.id !== id) fail(409, `"${active.title}" is already on. Finish or cancel it first.`);
	t.status = "open";
	auditLog(staff, "tournament_open", { targetType: "tournament", targetId: id, details: t.title });
	changed(t);
	for (const r of rosterOf(id)) {
		notifyUser(r.user_id, "reminders", {
			title: `Check in for ${t.title}`,
			body: "You're on the list. Open the tournament and press I'm here.",
			link: `/tournament/${id}`,
		});
	}
}

export function unpublishTournament(staff: User, id: number) {
	const t = load(id);
	if (t.status !== "open") fail(409, "Only a tournament that hasn't started can go back to draft.");
	t.status = "draft";
	auditLog(staff, "tournament_unpublish", { targetType: "tournament", targetId: id, details: t.title });
	changed(t);
}

/** Returns names that matched nobody, and players whose duels are limited. */
export function addPlayers(staff: User, id: number, names: string[]) {
	const t = load(id);
	if (t.status === "finished" || t.status === "cancelled") fail(409, "This tournament is over.");
	const missing: string[] = [];
	const limited: string[] = [];
	const added: string[] = [];
	let position =
		(db
			.query<{ n: number | null }, [number]>(
				"SELECT MAX(position) AS n FROM tournament_players WHERE tournament_id = ?"
			)
			.get(id)?.n ?? 0) + 1;
	for (const raw of names) {
		const name = raw.trim().replace(/^@/, "");
		if (!name) continue;
		const user = db
			.query<{ id: number; username: string; is_banned: number; duel_limited: number }, [string]>(
				"SELECT id, username, is_banned, duel_limited FROM users WHERE username = ? COLLATE NOCASE"
			)
			.get(name);
		if (!user || user.is_banned) {
			missing.push(name);
			continue;
		}
		if (user.duel_limited) {
			limited.push(user.username);
			continue;
		}
		if (rosterOf(id).length >= LIMITS.roster) fail(409, `A tournament can have up to ${LIMITS.roster} players.`);
		const result = db.run(
			"INSERT OR IGNORE INTO tournament_players (tournament_id, user_id, position) VALUES (?, ?, ?)",
			[id, user.id, position++]
		);
		if (result.changes) added.push(user.username);
	}
	if (added.length)
		auditLog(staff, "tournament_players_add", {
			targetType: "tournament",
			targetId: id,
			details: `${t.title}: ${added.join(", ")}`,
		});
	if (added.length && t.status === "open") {
		for (const name of added) {
			const user = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(name);
			notifyUser(user?.id, "reminders", {
				title: `You're in ${t.title}`,
				body: "Open the tournament and press I'm here to check in.",
				link: `/tournament/${id}`,
			});
		}
	}
	changed(t);
	return { added, missing, limited };
}

/** Once started, the player leaves the bracket and their opponent goes through. */
export function removePlayer(staff: User, id: number, userId: number) {
	const t = load(id);
	const name = userName(userId);
	if (t.status === "live") withdraw(t, userId);
	else if (t.status === "finished" || t.status === "cancelled") fail(409, "This tournament is over.");
	db.run("DELETE FROM tournament_players WHERE tournament_id = ? AND user_id = ?", [id, userId]);
	auditLog(staff, "tournament_player_remove", {
		targetType: "tournament",
		targetId: id,
		targetUsername: name,
		details: t.title,
	});
	changed(t);
}

function withdraw(t: Tournament, userId: number) {
	const s = t.state;
	const m = s.matches.find((x) => x.status !== "done" && x.players.includes(userId));
	if (!m) return;
	const side = m.players.indexOf(userId) as 0 | 1;
	const other = m.players[1 - side];
	if (m.status === "live") {
		detach(duelRooms.get(m.code ?? ""));
		if (joinTimer) clearTimeout(joinTimer);
		joinTimer = null;
		settle(s, m, other, "forfeit");
		return setPhase(t, { kind: "result", matchId: m.id, endsAt: Date.now() + FORFEIT_RESULT_MS });
	}
	m.players[side] = null;
	m.closed[side] = true;
	const phase = s.phase;
	if ((phase.kind === "break" || phase.kind === "hold") && phase.matchId === m.id) advance(t);
}

export function movePlayer(staff: User, id: number, userId: number, by: number) {
	const t = load(id);
	if (t.status !== "draft" && t.status !== "open") fail(409, "The bracket is already drawn.");
	const roster = rosterOf(id).map((r) => r.user_id);
	const from = roster.indexOf(userId);
	if (from < 0) fail(404, "That player isn't on the list.");
	const to = Math.max(0, Math.min(roster.length - 1, from + by));
	roster.splice(to, 0, ...roster.splice(from, 1));
	reorder(id, roster);
	changed(t);
}

export function shufflePlayers(staff: User, id: number) {
	const t = load(id);
	if (t.status !== "draft" && t.status !== "open") fail(409, "The bracket is already drawn.");
	const roster = rosterOf(id).map((r) => r.user_id);
	for (let i = roster.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[roster[i], roster[j]] = [roster[j], roster[i]];
	}
	reorder(id, roster);
	auditLog(staff, "tournament_shuffle", { targetType: "tournament", targetId: id, details: t.title });
	changed(t);
}

function reorder(id: number, userIds: number[]) {
	db.transaction(() => {
		userIds.forEach((userId, i) =>
			db.run("UPDATE tournament_players SET position = ? WHERE tournament_id = ? AND user_id = ?", [
				i + 1,
				id,
				userId,
			])
		);
	})();
}

export function setCheckedIn(staff: User, id: number, userId: number, checkedIn: boolean) {
	const t = load(id);
	if (t.status !== "draft" && t.status !== "open") fail(409, "The bracket is already drawn.");
	db.run("UPDATE tournament_players SET checked_in = ? WHERE tournament_id = ? AND user_id = ?", [
		checkedIn ? 1 : 0,
		id,
		userId,
	]);
	changed(t);
}

/** Draws the bracket from everyone checked in, in list order. */
export function startTournament(staff: User, id: number) {
	const t = load(id);
	if (t.status !== "open") fail(409, "Open check-in first.");
	draw(t);
	t.status = "live";
	db.run("UPDATE tournaments SET started_at = unixepoch() WHERE id = ?", [id]);
	auditLog(staff, "tournament_start", {
		targetType: "tournament",
		targetId: id,
		details: `${t.title}, ${checkedIn(id).length} players`,
	});
	firstBreak(t, t.settings.breaks.start);
}

const checkedIn = (id: number) =>
	rosterOf(id)
		.filter((r) => r.checked_in)
		.map((r) => r.user_id);

function draw(t: Tournament) {
	const ids = checkedIn(t.id);
	if (ids.length < 2) fail(409, "At least two players need to be checked in.");
	if (ids.length > LIMITS.players) fail(409, `A bracket can hold up to ${LIMITS.players} players.`);
	const { matches, rounds } = buildBracket(ids, t.settings.thirdPlace);
	Object.assign(t.state, { matches, rounds, championId: null, notice: null, ready: [], votes: {} });
}

function firstBreak(t: Tournament, seconds: number) {
	const first = [...t.state.matches]
		.filter((m) => m.round === 0 && m.players.every((p, i) => p !== null && !m.closed[i]))
		.sort((a, b) => a.index - b.index)[0];
	t.state.ready = [];
	setPhase(t, { kind: "break", label: "start", matchId: first?.id ?? null, endsAt: Date.now() + seconds * 1000 });
}

/** Only before any match has been played. */
export function redrawTournament(staff: User, id: number) {
	const t = load(id);
	if (t.status !== "live") fail(409, "The tournament hasn't started.");
	if (t.state.matches.some((m) => m.gameId !== null))
		fail(409, "A match has been played, so the bracket can't be drawn again.");
	draw(t);
	const phase = t.state.phase;
	const left = phase.kind === "break" ? Math.max(30_000, phase.endsAt - Date.now()) : t.settings.breaks.start * 1000;
	auditLog(staff, "tournament_redraw", { targetType: "tournament", targetId: id, details: t.title });
	firstBreak(t, Math.round(left / 1000));
}

export type Control = "skip" | "add_time" | "pause" | "resume" | "continue";

export function controlTournament(staff: User, id: number, action: Control) {
	const t = load(id);
	if (t.status !== "live") fail(409, "The tournament isn't running.");
	const s = t.state;
	const phase = s.phase;
	const timed = phase.kind === "break" || phase.kind === "result";
	if (action === "skip") {
		if (!timed) fail(409, "There's no countdown to skip.");
		phase.endsAt = Date.now();
		s.paused = null;
		arm(t);
	} else if (action === "add_time") {
		if (!timed) fail(409, "There's no countdown to extend.");
		if (s.paused !== null) s.paused += ADD_TIME_MS;
		else phase.endsAt = Math.max(phase.endsAt, Date.now()) + ADD_TIME_MS;
		arm(t);
	} else if (action === "pause") {
		if (!timed || s.paused !== null) fail(409, "There's no countdown to pause.");
		s.paused = Math.max(0, phase.endsAt - Date.now());
		arm(t);
	} else if (action === "resume") {
		if (!timed || s.paused === null) fail(409, "Nothing is paused.");
		phase.endsAt = Date.now() + s.paused;
		s.paused = null;
		arm(t);
	} else if (action === "continue") {
		if (phase.kind !== "hold") fail(409, "Nothing is waiting on staff.");
		const m = phase.matchId === null ? null : s.matches[phase.matchId];
		if (m && m.status === "waiting" && m.players.every((p, i) => p !== null && !m.closed[i])) {
			/** Whoever isn't there when the duel opens loses it. */
			auditLog(staff, "tournament_continue", { targetType: "tournament", targetId: id, details: t.title });
			return breakFor(t, m, "match", READY_MS / 1000, m.players as number[]);
		}
		return advance(t);
	}
	auditLog(staff, `tournament_${action}`, { targetType: "tournament", targetId: id, details: t.title });
	changed(t);
}

export function awardMatch(staff: User, id: number, matchId: number, winnerId: number) {
	const t = load(id);
	const m = t.state.matches[matchId] ?? fail(404, "Match not found");
	if (t.status !== "live" || m.status === "done") fail(409, "That match is already decided.");
	if (!m.players.includes(winnerId)) fail(400, "That player isn't in this match.");
	if (m.status === "live") detach(duelRooms.get(m.code ?? ""));
	if (joinTimer && m.status === "live") clearTimeout(joinTimer);
	settle(t.state, m, winnerId, "staff");
	auditLog(staff, "tournament_award", {
		targetType: "tournament",
		targetId: id,
		targetUsername: userName(winnerId),
		details: `${t.title}, ${matchName(t.state, m)}`,
	});
	setPhase(t, { kind: "result", matchId: m.id, endsAt: Date.now() + FORFEIT_RESULT_MS });
}

export function restartMatch(staff: User, id: number, matchId: number) {
	const t = load(id);
	const m = t.state.matches[matchId] ?? fail(404, "Match not found");
	if (t.status !== "live" || m.status !== "live") fail(409, "That match isn't being played.");
	detach(duelRooms.get(m.code ?? ""));
	if (joinTimer) clearTimeout(joinTimer);
	joinTimer = null;
	m.status = "waiting";
	m.code = null;
	m.scores = null;
	auditLog(staff, "tournament_match_restart", {
		targetType: "tournament",
		targetId: id,
		details: `${t.title}, ${matchName(t.state, m)}`,
	});
	breakFor(t, m, "match", RESTART_BREAK_S);
}

/** A late arrival in a bye, or a swap. */
export function setSlot(staff: User, id: number, matchId: number, side: 0 | 1, username: string) {
	const t = load(id);
	const s = t.state;
	const m = s.matches[matchId] ?? fail(404, "Match not found");
	if (t.status !== "live" || m.status !== "waiting") fail(409, "Only a match that hasn't started can change.");
	if (!sideKnown(s, m, side)) fail(409, "That place is still being played for.");
	const user =
		db
			.query<{ id: number; is_banned: number; duel_limited: number }, [string]>(
				"SELECT id, is_banned, duel_limited FROM users WHERE username = ? COLLATE NOCASE"
			)
			.get(username.trim().replace(/^@/, "")) ?? fail(404, "No player has that username.");
	if (user.is_banned) fail(409, "That player is banned.");
	if (user.duel_limited) fail(409, "That player's duels are limited.");
	const elsewhere = s.matches.find((x) => x.status !== "done" && x.players.includes(user.id) && x !== m);
	if (elsewhere || m.players[1 - side] === user.id) fail(409, "That player already has a place in the bracket.");
	const replaced = m.players[side];
	m.players[side] = user.id;
	m.closed[side] = false;
	db.run("INSERT OR IGNORE INTO tournament_players (tournament_id, user_id, checked_in) VALUES (?, ?, 1)", [
		id,
		user.id,
	]);
	s.notice = {
		text:
			replaced !== null
				? `${userName(user.id)} replaces ${userName(replaced)}`
				: `${userName(user.id)} joins the bracket`,
		at: Date.now(),
	};
	auditLog(staff, "tournament_slot", {
		targetType: "tournament",
		targetId: id,
		targetUsername: userName(user.id),
		details: `${t.title}: ${s.notice.text}`,
	});
	const phase = s.phase;
	/** The new player needs time to get ready. */
	if ((phase.kind === "break" || phase.kind === "hold") && phase.matchId === m.id) {
		s.ready = s.ready.filter((p) => p !== replaced);
		if (phase.kind === "break") phase.endsAt = Math.max(phase.endsAt, Date.now() + t.settings.breaks.match * 1000);
		arm(t);
	}
	changed(t);
}

const INVITE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Turns the invite code on (a new one each time, so an old code stops working) or off. */
export function setInvite(staff: User, id: number, on: boolean) {
	const t = load(id);
	if (t.status !== "draft" && t.status !== "open") fail(409, "Invites only work before the tournament starts.");
	const code = on
		? Array.from({ length: 6 }, () => INVITE_CHARS[Math.floor(Math.random() * INVITE_CHARS.length)]).join("")
		: null;
	db.run("UPDATE tournaments SET invite_code = ? WHERE id = ?", [code, id]);
	auditLog(staff, on ? "tournament_invite_on" : "tournament_invite_off", {
		targetType: "tournament",
		targetId: id,
		details: t.title,
	});
	changed(t);
}

export function postMessage(staff: User, id: number, text: string) {
	const t = load(id);
	const message = text.trim().slice(0, LIMITS.message);
	t.state.message = message ? { text: message, at: Date.now() } : null;
	auditLog(staff, "tournament_message", {
		targetType: "tournament",
		targetId: id,
		details: `${t.title}: ${message || "(cleared)"}`,
	});
	changed(t);
}

export function cancelTournament(staff: User, id: number) {
	const t = load(id);
	if (t.status === "finished" || t.status === "cancelled") fail(409, "This tournament is already over.");
	for (const m of t.state.matches) if (m.status === "live") detach(duelRooms.get(m.code ?? ""));
	clearTimers();
	t.status = "cancelled";
	t.state.phase = { kind: "done" };
	t.state.paused = null;
	db.run("UPDATE tournaments SET finished_at = unixepoch() WHERE id = ?", [id]);
	auditLog(staff, "tournament_cancel", { targetType: "tournament", targetId: id, details: t.title });
	changed(t);
}

/** `until` is in milliseconds; null hides the results. */
export function setResults(staff: User, id: number, until: number | null) {
	const t = load(id);
	if (t.status !== "finished") fail(409, "Only a finished tournament has results to show.");
	const at = until === null ? null : Math.floor(until / 1000);
	if (at !== null && at * 1000 <= Date.now()) fail(400, "Pick a time in the future.");
	db.run("UPDATE tournaments SET results_until = ? WHERE id = ?", [at, id]);
	auditLog(staff, at === null ? "tournament_results_hide" : "tournament_results_show", {
		targetType: "tournament",
		targetId: id,
		details: at === null ? t.title : `${t.title}, until ${new Date(at * 1000).toISOString()}`,
	});
	loadResults();
	nudgeTournament(currentSummary());
}

/** After a restart. The match in play was cut off, so staff carry on when ready. */
export function restoreTournaments() {
	loadResults();
	const row = db
		.query<Row, []>("SELECT * FROM tournaments WHERE status IN ('open', 'live') ORDER BY id DESC LIMIT 1")
		.get();
	if (!row) return;
	const t = fromRow(row);
	active = t;
	const phase = t.state.phase;
	if (t.status === "live" && phase.kind !== "done") {
		for (const m of t.state.matches) {
			if (m.status !== "live") continue;
			m.status = "waiting";
			m.code = null;
		}
		const matchId = "matchId" in phase ? phase.matchId : null;
		t.state.phase = { kind: "hold", matchId, reason: "restart" };
		t.state.paused = null;
	}
	save(t);
	nudgeTournament(currentSummary());
}

/** For tests: forget the tournament in memory. */
export function resetTournaments() {
	clearTimers();
	if (resultsTimer) clearTimeout(resultsTimer);
	if (voteTimer) clearTimeout(voteTimer);
	resultsTimer = voteTimer = null;
	active = null;
	results = null;
}
