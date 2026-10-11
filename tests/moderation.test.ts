import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { handleError } from "../src/app";
import { db } from "../src/db";
import { upsertUser } from "../src/auth/sessions";
import { fail } from "../src/lib/http";
import { call, createUser, post, type TestUser } from "./helpers";

const operator = () => createUser({ role: "operator" });
const ban = (target: TestUser, reason = "A1: testing bans") =>
	post(`/api/admin/users/${target.id}/ban`, operator(), { type: "perm", reason });
const isBanned = (user: TestUser) =>
	!!db.query<{ is_banned: number }, [number]>("SELECT is_banned FROM users WHERE id = ?").get(user.id)?.is_banned;

/** Reports in as `user` from a browser with the given device cookie and fingerprint. */
const seenOn = (user: TestUser, device: string, fingerprint: string) =>
	call("/api/fp", { json: { h: fingerprint }, headers: { Cookie: `${user.cookie}; device=${device}` } });
const hex = (seed: string) => seed.repeat(32).slice(0, 32);
const flags = async () => (await call("/api/admin/users/evasion", { as: operator() })).data as any[];

describe("banned accounts", () => {
	test("are shut out of play but can still appeal and reach their own data", async () => {
		const player = createUser();
		expect((await ban(player, "U3: offensive screenshots")).status).toBe(200);

		expect((await post("/api/daily/start", player)).status).toBe(403);
		expect((await post("/api/duels/rooms", player, { rounds: 3 })).status).toBe(403);
		expect((await post("/api/duels/quickplay", player, { rounds: 3 })).status).toBe(403);

		const me = (await call("/api/auth/me", { as: player })).data;
		expect(me.is_banned).toBe(true);
		expect(me.ban_reason).toBe("U3: offensive screenshots");

		const ticket = await post("/api/support", player, {
			category: "ban_appeal",
			subject: "Ban Appeal",
			message: "I believe this ban was a mistake, please review it.",
		});
		expect(ticket.status).toBe(200);
		expect(
			(await post(`/api/support/${ticket.data.id}/reply`, player, { message: "More detail here" })).status
		).toBe(200);
		expect((await call("/api/support/mine", { as: player })).data).toHaveLength(1);
		expect((await call("/api/me/moderation", { as: player })).data.actions[0].reason).toBe(
			"U3: offensive screenshots"
		);
		expect((await call("/api/gdpr/export", { as: player })).status).toBe(200);
	});

	test("a temporary ban ends by itself", async () => {
		const player = createUser();
		await post(`/api/admin/users/${player.id}/ban`, operator(), {
			type: "temp",
			hours: 1,
			reason: "F2: testing expiry",
		});
		expect(isBanned(player)).toBe(true);
		db.run("UPDATE moderation_actions SET expires_at = unixepoch() - 5 WHERE user_id = ?", [player.id]);
		db.run("UPDATE users SET ban_expires_at = unixepoch() - 5 WHERE id = ?", [player.id]);
		expect((await call("/api/auth/me", { as: player })).data.is_banned).toBe(false);
	});

	test("deleting the account and signing up again brings the ban back", async () => {
		const player = createUser();
		const discordId = db
			.query<{ discord_id: string }, [number]>("SELECT discord_id FROM users WHERE id = ?")
			.get(player.id)!.discord_id;
		await ban(player);
		expect((await call("/api/account", { method: "DELETE", as: player, json: { confirm: true } })).status).toBe(
			200
		);

		const again = upsertUser({
			discord_id: discordId,
			username: "returning",
			display_name: "Returning",
			avatar_url: "",
		});
		expect(again.isNew).toBe(true);
		expect(again.id).not.toBe(player.id);
		expect(isBanned({ id: again.id } as TestUser)).toBe(true);
	});

	test("an account with a clean record leaves no identity behind when deleted", async () => {
		const player = createUser();
		await call("/api/account", { method: "DELETE", as: player, json: { confirm: true } });
		const row = db.query<{ deleted_identity: string | null }, [number]>(
			"SELECT deleted_identity FROM users WHERE id = ?"
		);
		expect(row.get(player.id)!.deleted_identity).toBeNull();
	});
});

describe("ban evasion", () => {
	test("a second account on a banned player's browser is flagged for staff, not banned", async () => {
		const banned = createUser();
		const second = createUser();
		await seenOn(banned, hex("a1"), hex("b1"));
		await ban(banned);
		await seenOn(second, hex("a1"), hex("b1"));

		expect(isBanned(second)).toBe(false);
		const flag = (await flags()).find((f) => f.user_id === second.id);
		expect(flag).toMatchObject({ banned_id: banned.id, signal: "device" });
		expect((await call("/api/attention", { as: operator() })).data.staff.users).toBeGreaterThan(0);

		// Staff decide it is a sibling: the flag goes away and stays away.
		expect((await post(`/api/admin/users/evasion/${flag.id}/dismiss`, operator())).status).toBe(200);
		await seenOn(second, hex("a1"), hex("b1"));
		expect((await flags()).some((f) => f.user_id === second.id)).toBe(false);
	});

	test("identical hardware alone is only a weak match", async () => {
		const banned = createUser();
		const stranger = createUser();
		await seenOn(banned, hex("c1"), hex("d1"));
		await ban(banned);
		await seenOn(stranger, hex("c2"), hex("d1"));

		expect(isBanned(stranger)).toBe(false);
		expect((await flags()).find((f) => f.user_id === stranger.id)?.signal).toBe("browser");
		const panel = (await call(`/api/admin/users/${stranger.id}/moderation`, { as: operator() })).data;
		expect(panel.linked_accounts).toMatchObject([{ id: banned.id, signal: "browser" }]);
	});

	test("accounts already on the device are flagged when the ban comes later, and cleared when it is lifted", async () => {
		const first = createUser();
		const second = createUser();
		await seenOn(first, hex("e1"), hex("f1"));
		await seenOn(second, hex("e1"), hex("f1"));
		expect((await flags()).some((f) => [first.id, second.id].includes(f.user_id))).toBe(false);

		await ban(first);
		expect((await flags()).some((f) => f.user_id === second.id)).toBe(true);
		await post(`/api/admin/users/${first.id}/unban`, operator(), { reason: "Appeal accepted" });
		expect((await flags()).some((f) => f.user_id === second.id)).toBe(false);
	});

	test("staff are never flagged and players cannot see the list", async () => {
		const banned = createUser();
		const moderator = createUser({ role: "moderator" });
		await seenOn(banned, hex("71"), hex("81"));
		await ban(banned);
		await seenOn(moderator, hex("71"), hex("81"));
		expect((await flags()).some((f) => f.user_id === moderator.id)).toBe(false);
		expect((await call("/api/admin/users/evasion", { as: createUser() })).status).toBe(403);
	});
});

describe("error handling", () => {
	const broken = new Hono();
	broken.get("/boom", () => {
		throw new Error("secret internal detail");
	});
	broken.get("/api/boom", () => {
		throw new Error("secret internal detail");
	});
	broken.get("/api/refused", () => fail(403, "Not for you"));
	broken.onError(handleError);
	const get = (path: string, accept: string) =>
		broken.fetch(new Request(`http://localhost${path}`, { headers: { Accept: accept } }));

	test("a crashing page shows the error screen with a reference and no internals", async () => {
		const res = await get("/boom", "text/html");
		const html = await res.text();
		expect(res.status).toBe(500);
		expect(res.headers.get("Content-Type")).toContain("text/html");
		expect(html).toContain("Something went wrong");
		expect(html).toContain(`quote reference ${res.headers.get("X-Error-Ref")}`);
		expect(html).not.toContain("secret internal detail");
	});

	test("a crashing API call answers in plain text", async () => {
		const res = await get("/api/boom", "*/*");
		const body = await res.text();
		expect(res.status).toBe(500);
		expect(body).toContain("Something went wrong");
		expect(body).not.toContain("secret internal detail");
		expect((await get("/api/refused", "*/*")).status).toBe(403);
	});

	test("a failed login lands on a page, not bare text", async () => {
		const res = await call("/api/auth/callback?state=x", { headers: { Accept: "text/html" } });
		expect(res.status).toBe(400);
		expect(res.data).toContain("<!doctype html>");
		expect(res.data).toContain("Login didn");
	});
});
