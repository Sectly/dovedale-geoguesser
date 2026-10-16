import { afterEach, describe, expect, test } from "bun:test";
import type { WireConnection } from "@webwirejs/server";
import { db } from "../src/db";
import {
	allowLocalListsForTests,
	checkMessage,
	cleanText,
	downloadList,
	hasLink,
	isPrivateAddress,
	parseList,
	rawUrl,
	resetFilterIndex,
	seedDefaultList,
} from "../src/game/chat-filter";
import { duelRooms } from "../src/game/duels/rooms";
import { resetTournaments } from "../src/game/tournaments";
import { call, createUser, post, type TestUser } from "./helpers";

const quietConn = () => ({ auth: null, on() {}, emit() {}, close() {} }) as unknown as WireConnection;

afterEach(() => {
	for (const room of duelRooms.values()) if (room.tournament) duelRooms.delete(room.code);
	resetTournaments();
	db.run("DELETE FROM tournaments");
	db.run("DELETE FROM chat_filter_words");
	db.run("DELETE FROM chat_filter_lists");
	db.run("DELETE FROM app_settings WHERE key = 'chat_filter_seeded'");
	resetFilterIndex();
	allowLocalListsForTests(false);
});

const chat = async (id: number, as?: TestUser) => (await call(`/api/tournaments/${id}/chat`, { as })).data;
const say = (id: number, as: TestUser, text: string) => post(`/api/tournaments/${id}/chat`, as, { text });

/** A tournament with two players, open for check-in, chat on with no delay. */
async function openWithChat(delay = 0) {
	const staff = createUser({ role: "supervisor", ageDays: 30 });
	const players = [createUser({ ageDays: 30 }), createUser({ ageDays: 30 })];
	const id = (await post("/api/admin/tournaments", staff, { title: "Chat night", rounds: 1 })).data.id as number;
	await post(`/api/admin/tournaments/${id}/players`, staff, { usernames: players.map((p) => p.username).join(",") });
	await post(`/api/admin/tournaments/${id}/open`, staff);
	for (const p of players) await post(`/api/tournaments/${id}/checkin`, p);
	await post(`/api/admin/tournaments/${id}/chat/settings`, staff, { on: true, delay_ms: delay });
	return { id, staff, players };
}

describe("chat filter", () => {
	test("invisible characters go, emoji and other alphabets are refused, emotes are fine", () => {
		expect(cleanText("he​llo ‮there\n  you")).toBe("hello there you");
		expect(checkMessage("nice one 🔥").ok).toBe(false);
		expect(checkMessage("привет").ok).toBe(false);
		expect(checkMessage("café, naïve, ¿qué?").ok).toBe(true);
		expect(checkMessage("gg :fire: :heart:").ok).toBe(true);
		expect(checkMessage(":fire: ".repeat(6)).ok).toBe(false);
	});

	test("links are caught however they are written, ordinary text is not", () => {
		for (const text of [
			"go to google.com",
			"https://x",
			"www . site",
			"g o o g l e . c o m",
			"dovedale dot com",
			"site(.)net",
			"site [dot] org",
			"discord.gg/abc",
			"discord gg abc",
			"ping 10.0.0.1",
			"mail me@example.org",
			"@everyone look",
		])
			expect([text, hasLink(text)]).toEqual([text, true]);
		for (const text of ["e.g. this", "Mr. Smith won", "gg.ez", "3.5 km off", "well done. so close", "i.e. no"])
			expect([text, hasLink(text)]).toEqual([text, false]);
	});

	test("our own list catches number swaps, repeats and spacing; the allow list lets real words through", async () => {
		const staff = createUser({ role: "moderator" });
		await post("/api/admin/word-filter/words", staff, { words: "badword", match: "word", action: "refuse" });
		await post("/api/admin/word-filter/words", staff, { words: "crud", match: "contains", action: "refuse" });
		await post("/api/admin/word-filter/words", staff, { words: "crudton", kind: "allow" });
		await post("/api/admin/word-filter/words", staff, { words: "meh", action: "mask" });
		await post("/api/admin/word-filter/words", staff, { words: "hmm", action: "hold" });
		for (const text of ["BADWORD", "b4dw0rd", "baaadword", "b a d w o r d", "supercrudly"])
			expect([text, checkMessage(text).ok]).toEqual([text, false]);
		expect(checkMessage("off to crudton").ok).toBe(true);
		expect(checkMessage("that was meh").ok && checkMessage("that was meh")).toMatchObject({ body: "that was ***" });
		expect(checkMessage("hmm ok")).toMatchObject({ ok: true, held: true });
		const tried = await post("/api/admin/word-filter/test", staff, { text: "b4dw0rd" });
		expect(tried.data).toMatchObject({ ok: false, hits: [{ word: "badword", source: "Our list" }] });
	});

	test("list words match stretched spellings, but not shorter everyday words", () => {
		db.run("INSERT INTO chat_filter_lists (url, words, count) VALUES ('https://example.org/w', ?, 4)", [
			["ass", "butt", "tied up", "s&m"].join("\n"),
		]);
		db.run("INSERT INTO chat_filter_words (word, kind) VALUES ('tied up', 'allow')");
		resetFilterIndex();
		for (const text of ["as close as that", "but why", "the score is tied up", "sm"])
			expect([text, checkMessage(text).ok]).toEqual([text, true]);
		for (const text of ["you ass", "assss", "a$$", "BUTTTT"])
			expect([text, checkMessage(text).ok]).toEqual([text, false]);
	});

	test("the default list is added once, and stays gone once removed", () => {
		expect(seedDefaultList()).toBe(true);
		const lists = db.query<{ url: string; action: string }, []>("SELECT url, action FROM chat_filter_lists").all();
		expect(lists).toEqual([{ url: expect.stringContaining("LDNOOBW"), action: "refuse" }]);
		db.run("DELETE FROM chat_filter_lists");
		expect(seedDefaultList()).toBe(false);
		expect(db.query("SELECT 1 FROM chat_filter_lists").all()).toEqual([]);
	});

	test("place names are refused while a round is being played", () => {
		expect(checkMessage("it's perthtyne", ["perthtyne"]).ok).toBe(false);
		expect(checkMessage("nice guess", ["perthtyne"]).ok).toBe(true);
	});

	test("lists from the web: formats, GitHub links and private addresses", async () => {
		expect(parseList("# comment\nOne\ntwo, three\n\nTWO")).toEqual(["one", "two", "three"]);
		expect(parseList('["a", "b", 3]')).toEqual(["a", "b"]);
		expect(rawUrl("https://github.com/owner/repo/blob/main/words.txt")).toBe(
			"https://raw.githubusercontent.com/owner/repo/main/words.txt"
		);
		expect(() => rawUrl("ftp://x.org/list")).toThrow();
		for (const a of [
			"127.0.0.1",
			"10.1.2.3",
			"192.168.0.9",
			"172.20.0.1",
			"169.254.169.254",
			"::1",
			"fd00::1",
			"::ffff:127.0.0.1",
		])
			expect([a, isPrivateAddress(a)]).toEqual([a, true]);
		expect(isPrivateAddress("140.82.112.3")).toBe(false);
		await expect(downloadList("http://127.0.0.1:1/list.txt")).rejects.toThrow("private network");
	});

	test("supervisors add a web list; its words are used and it can be switched off", async () => {
		allowLocalListsForTests(true);
		const server = Bun.serve({
			port: 0,
			fetch: (req) =>
				new URL(req.url).pathname === "/big"
					? new Response("x\n".repeat(1_100_000))
					: new Response("# words\nzonk\nblorp", { headers: { "content-type": "text/plain" } }),
		});
		try {
			const mod = createUser({ role: "moderator" });
			const sup = createUser({ role: "supervisor" });
			const url = `http://127.0.0.1:${server.port}/words.txt`;
			expect((await post("/api/admin/word-filter/lists", mod, { url })).status).toBe(403);
			const added = await post("/api/admin/word-filter/lists", sup, { url, action: "refuse" });
			expect(added.data.lists[0]).toMatchObject({ count: 2, error: null });
			expect(checkMessage("zonk you").ok).toBe(false);
			await call(`/api/admin/word-filter/lists/${added.data.lists[0].id}`, {
				method: "PATCH",
				as: sup,
				json: { enabled: false },
			});
			expect(checkMessage("zonk you").ok).toBe(true);
			const big = await post("/api/admin/word-filter/lists", sup, { url: `http://127.0.0.1:${server.port}/big` });
			expect(big.data.lists[1].error).toContain("bigger than");
		} finally {
			server.stop(true);
		}
	});
});

describe("tournament chat", () => {
	test("off until staff turn it on", async () => {
		const staff = createUser({ role: "supervisor" });
		const viewer = createUser({ ageDays: 30 });
		const id = (await post("/api/admin/tournaments", staff, { title: "Quiet" })).data.id as number;
		await post(`/api/admin/tournaments/${id}/open`, staff);
		expect((await chat(id, viewer)).access).toMatchObject({ read: false, write: false, why: "Chat is off." });
		expect((await say(id, viewer, "hello")).status).toBe(403);
		await post(`/api/admin/tournaments/${id}/chat/settings`, staff, { on: true });
		expect((await chat(id, viewer)).access).toMatchObject({ read: true, write: true });
	});

	test("signed-out visitors, new accounts and banned players can't read or write", async () => {
		const { id } = await openWithChat();
		const spectator = createUser({ ageDays: 30 });
		await say(id, spectator, "hello all");
		expect(await chat(id)).toMatchObject({ access: { read: false, why: "Sign in to see chat." }, messages: [] });
		expect((await chat(id, createUser())).access.read).toBe(false);
		const banned = createUser({ ageDays: 30 });
		db.run("UPDATE users SET is_banned = 1 WHERE id = ?", [banned.id]);
		expect((await chat(id, banned)).access.read).toBe(false);
		expect((await chat(id, spectator)).messages.map((m: any) => m.body)).toEqual(["hello all"]);
	});

	test("others see a message only after the delay; the sender sees it at once", async () => {
		const { id } = await openWithChat(300);
		const [a, b] = [createUser({ ageDays: 30 }), createUser({ ageDays: 30 })];
		expect((await say(id, a, "first")).data).toMatchObject({ held: false, message: { body: "first" } });
		expect((await chat(id, a)).messages).toHaveLength(1);
		expect((await chat(id, b)).messages).toHaveLength(0);
		await Bun.sleep(350);
		expect((await chat(id, b)).messages).toHaveLength(1);
	});

	test("links, repeats and floods are refused, and caught messages are kept for staff", async () => {
		const { id, staff } = await openWithChat();
		const a = createUser({ ageDays: 30 });
		expect((await say(id, a, "see google.com")).data).toBe("Links aren't allowed in chat.");
		const b = createUser({ ageDays: 30 });
		expect((await say(id, b, "hello")).status).toBe(200);
		expect((await say(id, b, "hello again")).status).toBe(429);
		const staffView = (await call(`/api/admin/tournaments/${id}/chat`, { as: staff })).data;
		expect(staffView.messages.map((m: any) => m.status)).toEqual(["shown", "blocked"]);
	});

	test("players can't read while guessing, read after their guess, and write once they are out", async () => {
		const { id, staff, players } = await openWithChat();
		await post(`/api/admin/tournaments/${id}/start`, staff);
		const [p1, p2] = players;
		expect((await chat(id, p1)).access).toMatchObject({ read: true, write: false });
		for (const p of players) await post(`/api/tournaments/${id}/ready`, p);
		await post(`/api/admin/tournaments/${id}/control`, staff, { action: "skip" });
		await Bun.sleep(10);
		const t = (await call(`/api/tournaments/${id}`)).data;
		const room = duelRooms.get(t.phase.code)!;
		room.status = "in_progress";
		room.round = {} as any;
		room.outcomes = new Map();
		expect((await chat(id, p1)).access).toMatchObject({ read: false, why: "Chat opens after your guess." });
		room.outcomes.set(p1.id, {} as any);
		expect((await chat(id, p1)).access).toMatchObject({ read: true, write: false });
		expect((await say(id, p1, "hi")).status).toBe(403);
		room.players = [p1, p2].map((p) => ({
			userId: p.id,
			username: p.username,
			displayName: p.username,
			avatarUrl: "",
			conn: quietConn(),
			connected: true,
			disconnects: 0,
			totalScore: 0,
		}));
		room.round = null;
		await post(`/api/admin/tournaments/${id}/matches/${t.phase.match_id}/award`, staff, { user_id: p2.id });
		expect((await chat(id, p1)).access).toMatchObject({ read: true, write: true });
	});

	test("staff delete, time out and approve held messages; viewers report", async () => {
		const { id, staff } = await openWithChat();
		const [a, b] = [createUser({ ageDays: 30 }), createUser({ ageDays: 30 })];
		const sent = (await say(id, a, "rude thing")).data.message;
		expect((await post(`/api/tournaments/${id}/chat/${sent.id}/report`, b)).status).toBe(200);
		expect((await post(`/api/tournaments/${id}/chat/${sent.id}/report`, a)).status).toBe(400);
		let view = (await call(`/api/admin/tournaments/${id}/chat`, { as: staff })).data;
		expect(view.messages[0].reports).toBe(1);

		view = (await post(`/api/admin/tournaments/${id}/chat/${sent.id}/timeout`, staff, { minutes: 5 })).data;
		expect(view.messages[0].status).toBe("deleted");
		expect((await chat(id, a)).access).toMatchObject({ read: false });
		expect((await chat(id, a)).access.why).toContain("again in 5 minutes");
		expect((await chat(id, b)).messages).toHaveLength(0);

		await post("/api/admin/word-filter/words", staff, { words: "hmm", action: "hold" });
		const held = (await say(id, b, "hmm well")).data;
		expect(held.held).toBe(true);
		expect((await chat(id, createUser({ ageDays: 30 }))).messages).toHaveLength(0);
		await post(`/api/admin/tournaments/${id}/chat/${held.message.id}/approve`, staff);
		await Bun.sleep(600);
		expect((await chat(id, createUser({ ageDays: 30 }))).messages.map((m: any) => m.body)).toEqual(["hmm well"]);
	});

	test("slow mode and staff-only mode", async () => {
		const { id, staff } = await openWithChat();
		const a = createUser({ ageDays: 30 });
		await post(`/api/admin/tournaments/${id}/chat/settings`, staff, { slow_seconds: 30 });
		expect((await say(id, a, "one")).status).toBe(200);
		await Bun.sleep(2100);
		expect((await say(id, a, "two")).data).toContain("Slow mode");
		await post(`/api/admin/tournaments/${id}/chat/settings`, staff, { staff_only: true });
		expect((await chat(id, a)).access).toMatchObject({ read: true, write: false });
		expect((await say(id, staff, "staff here")).status).toBe(200);
	});
});
