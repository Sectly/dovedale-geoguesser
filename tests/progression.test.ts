import { beforeAll, describe, expect, jest, test } from "bun:test";
import type { WireConnection } from "@webwirejs/server";
import { award, backfillAchievements } from "../src/achievements";
import { GAME } from "../src/config";
import { db } from "../src/db";
import { expectedScore, rateDuel } from "../src/game/duels/rating";
import { quickplay } from "../src/game/duels/matchmaking";
import { createRoom, duelRooms, joinRoom, sendEmote, submitGuess, type DuelRoom } from "../src/game/duels/rooms";
import { difficultyOf, pickLocations, recordLocationPlay } from "../src/game/locations";
import { DUEL_RULES, Round } from "../src/game/round";
import { liveSpecial } from "../src/specials";
import { setFeature } from "../src/system/features";
import { call, clearLocations, createLocation, createUser, post, resetReviewQueues, type TestUser } from "./helpers";

type FakeConn = WireConnection & { events: [string, any][] };

function seat(room: DuelRoom, user: TestUser): FakeConn {
	const events: [string, any][] = [];
	const conn = {
		events,
		auth: null,
		on() {
			return this;
		},
		emit: (e: string, d: unknown) => void events.push([e, d]),
		close() {},
	} as unknown as FakeConn;
	room.players.push({
		userId: user.id,
		username: user.username,
		displayName: user.username,
		avatarUrl: "",
		conn,
		connected: true,
		disconnects: 0,
		totalScore: 0,
	});
	return conn;
}

const location = (id: number) => db.query<any, [number]>("SELECT * FROM locations WHERE id = ?").get(id);
const userRow = (u: TestUser) => db.query<any, [number]>("SELECT * FROM users WHERE id = ?").get(u.id);
const achievements = (u: TestUser) =>
	db
		.query<{ key: string }, [number]>("SELECT key FROM user_achievements WHERE user_id = ?")
		.all(u.id)
		.map((r) => r.key);
const operator = () => createUser({ role: "operator" });

/** Plays a one-round duel in which `winner` guesses the spot exactly and the other misses. */
function playDuel(winner: TestUser, loser: TestUser, quick: boolean) {
	const room = createRoom(winner.id, 1, quick);
	joinRoom(room.code, loser.id);
	const conn = seat(room, winner);
	seat(room, loser);
	room.locations = [location(createLocation({ x: 100, y: 100 }))];
	room.status = "in_progress";
	room.roundNumber = 1;
	room.round = new Round(room.locations[0], DUEL_RULES);
	jest.useFakeTimers();
	try {
		submitGuess(room, winner.id, { x: 100, y: 100 });
		submitGuess(room, loser.id, { x: 90000, y: 90000 });
		jest.advanceTimersByTime(GAME.duel.finalResultDelay * 1000 + 100);
	} finally {
		jest.useRealTimers();
	}
	duelRooms.delete(room.code);
	return { room, end: conn.events.find(([name]) => name === "game_end")![1] };
}

beforeAll(() => {
	resetReviewQueues();
	clearLocations();
	for (let i = 0; i < 6; i++) createLocation({ hints: ["a hint"] });
});

describe("duel ratings", () => {
	test("equal players trade the same points and an upset moves more", () => {
		expect(expectedScore(1000, 1000)).toBe(0.5);
		expect(expectedScore(1400, 1000)).toBeGreaterThan(0.9);
		const [a, b] = [createUser(), createUser()];
		const game = createRoom(a.id, 1, true);
		joinRoom(game.code, b.id);
		duelRooms.delete(game.code);
		const [won, lost] = rateDuel(game.dbId, [a.id, b.id], a.id)!;
		expect(won.change).toBe(GAME.rating.kProvisional / 2);
		expect(lost.change).toBe(-won.change);
		expect(userRow(a)).toMatchObject({ duel_rating: 1000 + won.change, duel_rated_games: 1 });
	});

	test("Quick Play duels are rated, private rooms are not", () => {
		const [a, b] = [createUser(), createUser()];
		const quick = playDuel(a, b, true);
		expect(quick.end.ratings.map((r: any) => r.change)).toEqual([20, -20]);
		expect(userRow(a).duel_rating).toBe(1020);
		expect(userRow(b).duel_rating).toBe(980);

		const friendly = playDuel(b, a, false);
		expect(friendly.end.ratings).toBeNull();
		expect(userRow(a).duel_rating).toBe(1020);
	});

	test("the ranked board lists rated players, and voiding a duel hands the points back", async () => {
		const [a, b] = [createUser(), createUser()];
		const { room } = playDuel(a, b, true);
		const board = (await call("/api/leaderboard/duels?sort=rating")).data;
		expect(board.find((row: any) => row.user_id === a.id)).toMatchObject({ rating: 1020, rated_games: 1 });
		expect((await call(`/api/profile/${a.username}`)).data.rating).toEqual({ value: 1020, games: 1 });

		const voided = await call(`/api/admin/scores/${a.id}/duels/${room.dbId}`, {
			method: "DELETE",
			as: operator(),
			json: { reason: "Testing that a voided duel is unrated" },
		});
		expect(voided.status).toBe(200);
		expect(userRow(a)).toMatchObject({ duel_rating: 1000, duel_rated_games: 0 });
		expect(userRow(b)).toMatchObject({ duel_rating: 1000, duel_rated_games: 0 });
	});

	test("Quick Play pairs a player with whoever waiting is closest to their rating", () => {
		const [low, high, me] = [createUser(), createUser(), createUser()];
		db.run("UPDATE users SET duel_rating = 800 WHERE id = ?", [low.id]);
		db.run("UPDATE users SET duel_rating = 1500 WHERE id = ?", [high.id]);
		db.run("UPDATE users SET duel_rating = 1450 WHERE id = ?", [me.id]);
		const lowRoom = quickplay(userRow(low), 7, () => true)!;
		const highRoom = quickplay(userRow(high), 7, () => true)!;
		for (const [code, user] of [
			[lowRoom.code, low],
			[highRoom.code, high],
		] as const)
			seat(duelRooms.get(code)!, user);
		expect(quickplay(userRow(me), 7, () => true)).toEqual({ status: "matched", code: highRoom.code });
		duelRooms.delete(lowRoom.code);
		duelRooms.delete(highRoom.code);
	});

	test("staff can set a rating, with a reason", async () => {
		const player = createUser();
		const op = operator();
		expect((await post(`/api/admin/scores/${player.id}/rating`, op, { rating: 1300 })).status).toBe(400);
		expect(
			(await post(`/api/admin/scores/${player.id}/rating`, createUser({ role: "moderator" }), { rating: 1300 }))
				.status
		).toBe(403);
		const set = await post(`/api/admin/scores/${player.id}/rating`, op, {
			rating: 1300,
			reason: "Restoring a rating lost to a bug",
		});
		expect(set.status).toBe(200);
		expect((await call(`/api/admin/scores/${player.id}`, { as: op })).data.rating.value).toBe(1300);
	});
});

describe("achievements", () => {
	test("are earned by playing, shown once, and listed on the profile", async () => {
		const player = createUser();
		const start = await post("/api/solo/games", player, { rounds: 3, time_limit: 0 });
		for (let i = 0; i < 3; i++) {
			if (i > 0) await post(`/api/solo/games/${start.data.game_id}/next`, player);
			await post(`/api/solo/games/${start.data.game_id}/guess`, player, { x: 0, y: 0 });
		}
		expect(achievements(player)).toContain("first_game");

		const unseen = await call("/api/achievements/unseen", { as: player });
		expect(unseen.data.map((a: any) => a.id)).toContain("first_game");
		expect(unseen.data[0]).toHaveProperty("icon");
		expect((await call("/api/achievements/unseen", { as: player })).data).toEqual([]);
		expect((await call("/api/achievements/unseen")).status).toBe(401);

		const profile = (await call(`/api/profile/${player.username}`)).data;
		expect(profile.achievements.find((a: any) => a.id === "first_game").earned_at).toBeNumber();
		expect(profile.achievements.find((a: any) => a.id === "duel_win").earned_at).toBeNull();
		const inbox = (await call("/api/notifications", { as: player })).data;
		expect(inbox.notifications[0]).toMatchObject({ category: "achievements" });
	});

	test("a guess on the spot and a duel win each earn theirs", () => {
		const [a, b] = [createUser(), createUser()];
		playDuel(a, b, false);
		expect(achievements(a)).toEqual(expect.arrayContaining(["bullseye", "duel_win"]));
		expect(achievements(b)).not.toContain("duel_win");
	});

	test("existing players are given what their history shows, without a pop-up", async () => {
		const veteran = createUser();
		db.run(
			"INSERT INTO solo_scores (user_id, total_score, rounds, max_possible, time_limit) VALUES (?, 24000, 5, 25000, 0)",
			[veteran.id]
		);
		db.run(
			"INSERT INTO daily_scores (user_id, date, score, distance, time_taken) VALUES (?, '2020-01-01', 4800, 90, 3)",
			[veteran.id]
		);
		db.run("UPDATE users SET longest_streak = 9 WHERE id = ?", [veteran.id]);

		expect(backfillAchievements()).toBeGreaterThan(0);
		expect(achievements(veteran)).toEqual(
			expect.arrayContaining([
				"first_game",
				"local_expert",
				"daily_first",
				"daily_ace",
				"bullseye",
				"quick_draw",
				"streak_3",
				"streak_7",
			])
		);
		expect(achievements(veteran)).not.toContain("streak_30");
		expect((await call("/api/achievements/unseen", { as: veteran })).data).toEqual([]);
		// Running it again gives nothing twice.
		const before = achievements(veteran).length;
		backfillAchievements();
		expect(achievements(veteran).length).toBe(before);

		const run = await post("/api/admin/system/achievements/backfill", operator());
		expect(run.status).toBe(200);
		expect((await post("/api/admin/system/achievements/backfill", createUser({ role: "supervisor" }))).status).toBe(
			403
		);
	});

	test("staff can give, take away and reset them, and they are in the data export", async () => {
		const player = createUser();
		const op = operator();
		const give = (earned: boolean) =>
			post(`/api/admin/scores/${player.id}/achievements/duel_wins_10`, op, {
				earned,
				reason: "Correcting an achievement by hand",
			});
		expect((await give(true)).status).toBe(200);
		expect((await give(true)).status).toBe(409);
		expect((await post(`/api/admin/scores/${player.id}/achievements/nonsense`, op, { earned: true })).status).toBe(
			404
		);

		const exported = (await call("/api/gdpr/export", { as: player })).data;
		expect(exported.achievements.map((a: any) => a.key)).toEqual(["duel_wins_10"]);
		expect(exported.account).toMatchObject({ duel_rating: 1000, duel_rated_games: 0 });
		expect(exported.export_version).toBe(8);

		expect((await give(false)).status).toBe(200);
		expect(achievements(player)).toEqual([]);

		award(player.id, "first_game");
		const reset = await post(`/api/admin/scores/${player.id}/reset`, op, {
			scope: "achievements",
			reason: "Clearing achievements for a test",
		});
		expect(reset.status).toBe(200);
		expect(achievements(player)).toEqual([]);
	});

	test("deleting an account removes them", async () => {
		const player = createUser();
		award(player.id, "first_game");
		await call("/api/account", { method: "DELETE", as: player, json: { confirm: true } });
		expect(achievements(player)).toEqual([]);
	});
});

describe("duel reactions", () => {
	function openRoom() {
		const [a, b] = [createUser(), createUser()];
		const room = createRoom(a.id, 1);
		joinRoom(room.code, b.id);
		const conns = [seat(room, a), seat(room, b)];
		const watcher: [string, any][] = [];
		room.spectators.add({
			emit: (e: string, d: unknown) => void watcher.push([e, d]),
		} as unknown as WireConnection);
		room.status = "in_progress";
		return { a, b, room, conns, watcher };
	}
	const emotes = (events: [string, any][]) => events.filter(([name]) => name === "emote").map(([, data]) => data);

	test("reach both players and anyone watching, one at a time", () => {
		const { a, room, conns, watcher } = openRoom();
		const emote = GAME.duel.emotes[0];
		sendEmote(room, a.id, emote);
		sendEmote(room, a.id, emote);
		sendEmote(room, a.id, "<script>");
		for (const seen of [conns[0].events, conns[1].events, watcher])
			expect(emotes(seen)).toEqual([{ user_id: a.id, emote }]);
		duelRooms.delete(room.code);
	});

	test("staff can switch them off", async () => {
		const op = operator();
		expect((await post("/api/admin/system/features", createUser({ role: "supervisor" }), {})).status).toBe(403);
		expect((await post("/api/admin/system/features", op, { feature: "nope", enabled: false })).status).toBe(400);
		const off = await post("/api/admin/system/features", op, { feature: "duel_emotes", enabled: false });
		expect(off.data.duel_emotes).toBe(false);
		try {
			const { a, room, conns } = openRoom();
			sendEmote(room, a.id, GAME.duel.emotes[0]);
			expect(emotes(conns[1].events)).toEqual([]);
			duelRooms.delete(room.code);
		} finally {
			setFeature("duel_emotes", true);
		}
	});

	test("work in team games too", async () => {
		const [host, mate] = [createUser(), createUser()];
		if (!liveSpecial("teams", userRow(host))) return;
		const code = (await post("/api/teams/rooms", host, { rounds: 3 })).data.code;
		await post(`/api/teams/rooms/${code}/join`, mate);
		const emote = GAME.duel.emotes[1];
		expect((await post(`/api/teams/rooms/${code}/emote`, host, { emote })).status).toBe(200);
		await post(`/api/teams/rooms/${code}/emote`, host, { emote });
		await post(`/api/teams/rooms/${code}/emote`, mate, { emote: "not-an-emote" });
		const state = (await call(`/api/teams/rooms/${code}`, { as: mate })).data;
		expect(state.emote_list).toEqual(GAME.duel.emotes);
		expect(state.emotes).toEqual([{ id: 1, user_id: host.id, emote }]);
	});
});

describe("location difficulty", () => {
	test("is graded from how players do, once enough have guessed", async () => {
		const easy = createLocation();
		const hard = createLocation();
		expect(difficultyOf(easy)).toBeNull();
		for (let i = 0; i < GAME.difficulty.minPlays; i++) {
			recordLocationPlay(easy, 4800);
			recordLocationPlay(hard, 300);
		}
		expect(difficultyOf(easy)).toBe("easy");
		expect(difficultyOf(hard)).toBe("hard");
		expect(pickLocations(5, "hard").map((l) => l.id)).toEqual([hard]);

		const counts = (await call("/api/solo/difficulties")).data;
		expect(counts).toMatchObject({ easy: 1, hard: 1 });
	});

	test("a solo game on one difficulty is practice, and needs enough locations", async () => {
		const player = createUser();
		const tooMany = await post("/api/solo/games", player, { rounds: 3, time_limit: 0, difficulty: "hard" });
		expect(tooMany.status).toBe(409);

		for (let n = 0; n < 2; n++) {
			const extra = createLocation();
			for (let i = 0; i < GAME.difficulty.minPlays; i++) recordLocationPlay(extra, 200);
		}
		const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM solo_scores").get()!.n;
		const start = await post("/api/solo/games", player, { rounds: 3, time_limit: 0, difficulty: "hard" });
		expect(start.data).toMatchObject({ rounds: 3, difficulty: "hard" });
		let last: any;
		for (let i = 0; i < 3; i++) {
			if (i > 0) await post(`/api/solo/games/${start.data.game_id}/next`, player);
			last = await post(`/api/solo/games/${start.data.game_id}/guess`, player, { x: 0, y: 0 });
		}
		expect(last.data.difficulty).toBe("hard");
		expect(last.data.summary).toMatchObject({ saved: false, difficulty: "hard" });
		expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM solo_scores").get()!.n).toBe(before);
	});

	test("staff see it on each location and can reset it", async () => {
		const mod = createUser({ role: "moderator" });
		const id = createLocation();
		for (let i = 0; i < GAME.difficulty.minPlays; i++) recordLocationPlay(id, 5000);
		const listed = (await call("/api/admin/locations", { as: mod })).data.find((l: any) => l.id === id);
		expect(listed).toMatchObject({ difficulty: "easy", plays: GAME.difficulty.minPlays, avg_score: 5000 });

		expect((await post(`/api/admin/locations/${id}/stats/reset`, createUser())).status).toBe(403);
		expect((await post(`/api/admin/locations/${id}/stats/reset`, mod)).status).toBe(200);
		expect(difficultyOf(id)).toBeNull();
	});
});
