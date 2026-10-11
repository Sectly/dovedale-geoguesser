import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { PUBLIC_DIR } from "../src/config";
import { db } from "../src/db";
import { call, createUser, post, resetReviewQueues } from "./helpers";

const read = (file: string) => readFileSync(join(PUBLIC_DIR, file), "utf8");

beforeAll(resetReviewQueues);

describe("numbered rules", () => {
	test("the list staff cite from matches the published rules exactly", () => {
		const listed = [...read("js/rules.js").matchAll(/code: "([FAU]\d+)", title: "([^"]+)", page: "\/(\w+)"/g)].map(
			([, code, title, page]) => ({ code, title, page })
		);
		expect(listed.length).toBe(26);

		const published: typeof listed = [];
		for (const page of ["fairplay", "tos", "guidelines"]) {
			for (const [, code, title] of read(`${page}.html`).matchAll(
				/<li id="([FAU]\d+)" class="rule">[\s\S]*?<strong[^>]*>([^<]+)\.<\/strong>/g
			)) {
				published.push({ code, title: title.replace(/&#39;|&apos;/g, "'"), page });
			}
		}
		expect(published).toEqual(listed);
	});
});

describe("privacy promises", () => {
	test("deleting an account removes the name from records it was copied into", async () => {
		const mod = createUser({ role: "moderator" });
		const player = createUser();
		await post(`/api/admin/users/${player.id}/warn`, mod, { reason: "[F7 Harassment and abuse] in a duel" });
		const ticket = await post("/api/support", player, {
			subject: "Appeal",
			message: "I would like to appeal this warning please.",
			category: "ban_appeal",
		});
		await post(`/api/admin/support/${ticket.data.id}/reply`, mod, { reply: "Looked at it, the warning stands." });

		expect((await call("/api/account", { method: "DELETE", as: mod, json: { confirm: true } })).status).toBe(200);
		const names = (sql: string) =>
			db
				.query<{ name: string }, []>(sql)
				.all()
				.map((r) => r.name);
		expect(names(`SELECT issued_by_username AS name FROM moderation_actions WHERE user_id = ${player.id}`)).toEqual(
			["[deleted]"]
		);
		expect(names(`SELECT author_username AS name FROM ticket_replies WHERE ticket_id = ${ticket.data.id}`)).toEqual(
			["[deleted]"]
		);
		expect(
			names(`SELECT actor_username AS name FROM audit_log WHERE actor_id = ${mod.id}`).every(
				(n) => n === "[deleted]"
			)
		).toBe(true);
		expect(
			names(
				`SELECT target_username AS name FROM audit_log WHERE target_type = 'user' AND target_id = ${mod.id}`
			).filter((n) => n && n !== "[deleted]")
		).toEqual([]);
	});

	test("the data export includes the Discord ID we hold", async () => {
		const user = createUser();
		const exported = await call("/api/gdpr/export", { as: user });
		expect(exported.data.account.discord_id).toStartWith("discord-");
		expect(Object.keys(exported.data)).toContain("moderation");
		expect(Object.keys(exported.data)).toContain("notifications");
	});
});
