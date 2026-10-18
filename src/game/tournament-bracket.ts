export type Side = number | null;
export type Decided = "sudden_death" | "tiebreak" | "forfeit" | "no_show" | "not_ready" | "staff" | "bye" | null;

export type Match = {
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
	/** In a round played all at once: why this match is waiting for staff. */
	hold?: HoldReason | null;
};

export type BreakLabel = "start" | "match" | "round" | "final";

export type Phase =
	| { kind: "lobby" }
	| { kind: "break"; label: BreakLabel; matchId: number | null; endsAt: number; round?: number }
	/** A round being played all at once. */
	| { kind: "batch"; round: number }
	| { kind: "hold"; matchId: number | null; reason: HoldReason }
	| { kind: "match"; matchId: number; code: string }
	| { kind: "result"; matchId: number; endsAt: number }
	| { kind: "done" };

export type HoldReason = "not_ready" | "no_show" | "no_winner" | "closed" | "restart" | "staff";

export type State = {
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
	/** The match staff want spectators to follow in a round played all at once. */
	featured: number | null;
};

export const playable = (m: Match) => m.players.every((p, i) => p !== null && !m.closed[i]);

/** Seed positions so the top seeds meet last: 1v8, 4v5, 2v7, 3v6 for eight. */
export function seedOrder(size: number): number[] {
	let order = [1];
	while (order.length < size) {
		const n = order.length * 2 + 1;
		order = order.flatMap((seed) => [seed, n - seed]);
	}
	return order;
}

export function buildBracket(playerIds: number[], thirdPlace: boolean): { matches: Match[]; rounds: number } {
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

export const matchAt = (s: State, round: number, index: number) =>
	s.matches.find((m) => m.round === round && m.index === index) ?? null;

export const feeder = (s: State, m: Match, side: 0 | 1) =>
	m.round === 0 ? null : matchAt(s, m.round - 1, m.third ? side : m.index * 2 + side);

/** True once we know who, if anyone, plays on this side. */
export function sideKnown(s: State, m: Match, side: 0 | 1): boolean {
	const from = feeder(s, m, side);
	return !from || from.status === "done";
}

export function roundName(s: State, round: number): string {
	const fromEnd = s.rounds - 1 - round;
	if (fromEnd === 0) return "Final";
	if (fromEnd === 1) return "Semi-finals";
	if (fromEnd === 2) return "Quarter-finals";
	return `Round ${round + 1}`;
}

export const matchName = (s: State, m: Match) => (m.third ? "Third place" : roundName(s, m.round));

/** Round by round, with third place just before the final. */
export const playOrder = (a: Match, b: Match) =>
	a.round - b.round || (a.third ? -1 : a.index) - (b.third ? -1 : b.index);

export function propagate(s: State, m: Match) {
	if (m.third) return;
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

export function settle(s: State, m: Match, winner: Side, decided: Decided) {
	m.status = "done";
	m.winner = winner;
	m.decided = decided;
	m.code = null;
	propagate(s, m);
}
