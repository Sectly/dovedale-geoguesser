import { describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { call, createUser, post, type TestUser } from "./helpers";

function pendingSubmission(author: TestUser, label = "The goods shed"): number {
	return Number(
		db.run(
			"INSERT INTO submissions (image_path, world_x, world_y, label, submitted_by) VALUES ('n.webp', 1, 2, ?, ?)",
			[label, author.id]
		).lastInsertRowid
	);
}

const inbox = (user: TestUser) => call("/api/notifications", { as: user }).then((r) => r.data);

describe("notifications", () => {
	test("a reviewed submission lands in its author's inbox and can be marked read", async () => {
		const author = createUser();
		const mod = createUser({ role: "moderator" });
		expect((await inbox(author)).unread).toBe(0);

		await post(`/api/admin/submissions/${pendingSubmission(author)}/approve`, mod);
		await post(`/api/admin/submissions/${pendingSubmission(author, "A blurry field")}/deny`, mod, {
			reason: "Too blurry",
		});

		const box = await inbox(author);
		expect(box.unread).toBe(2);
		expect(box.notifications.map((n: any) => n.title)).toEqual([
			"Your location was not accepted",
			"Your location was approved",
		]);
		expect(box.notifications[0].body).toContain("Too blurry");
		expect(box.latest.title).toBe("Your location was not accepted");

		expect((await post("/api/notifications/read", author, { ids: [box.notifications[0].id] })).data.unread).toBe(1);
		expect((await post("/api/notifications/read", author)).data.unread).toBe(0);
		expect((await call("/api/notifications", { method: "DELETE", as: author })).data.unread).toBe(0);
		expect((await inbox(author)).notifications).toEqual([]);
	});

	test("nobody can read or clear someone else's inbox", async () => {
		const author = createUser();
		await post(`/api/admin/submissions/${pendingSubmission(author)}/approve`, createUser({ role: "moderator" }));
		const other = createUser();
		const id = (await inbox(author)).notifications[0].id;
		await post("/api/notifications/read", other, { ids: [id] });
		expect((await inbox(author)).unread).toBe(1);
		expect((await call("/api/attention")).status).toBe(401);
	});

	test("categories can be switched off, except moderation", async () => {
		const player = createUser();
		const mod = createUser({ role: "moderator" });
		const saved = await post("/api/settings", player, {
			prefs: { sounds: false, notify: { submissions: false }, nonsense: 1 },
		});
		expect(saved.data.prefs).toMatchObject({
			sounds: false,
			desktop: false,
			notify: { submissions: false, tickets: true },
		});
		expect(saved.data.prefs.nonsense).toBeUndefined();
		expect((await call("/api/auth/me", { as: player })).data.prefs.sounds).toBe(false);

		await post(`/api/admin/submissions/${pendingSubmission(player)}/approve`, mod);
		expect((await inbox(player)).unread).toBe(0);

		await post("/api/settings", player, { prefs: { notify: { moderation: false } } });
		await post(`/api/admin/users/${player.id}/warn`, mod, { reason: "Being rude in duels" });
		const box = await inbox(player);
		expect(box.unread).toBe(1);
		expect(box.notifications[0]).toMatchObject({ category: "moderation", title: "You received a warning" });
	});

	test("ticket replies notify the player and feed the staff queue", async () => {
		const player = createUser();
		const mod = createUser({ role: "moderator" });
		const before = (await call("/api/attention", { as: mod })).data.staff;
		const ticket = await post("/api/support", player, {
			subject: "Wrong pin",
			message: "The pin for this place is in the lake.",
			category: "report_location",
		});
		pendingSubmission(player);

		const during = (await call("/api/attention", { as: mod })).data.staff;
		expect(during.tickets).toBe(before.tickets + 1);
		expect(during.submissions).toBe(before.submissions + 1);
		expect(during.total).toBe(during.submissions + during.suggestions + during.tickets);
		expect((await call("/api/attention", { as: player })).data.staff).toBeNull();

		await post(`/api/admin/support/${ticket.data.id}/reply`, mod, { reply: "Fixed, thank you." });
		expect((await call("/api/attention", { as: mod })).data.staff.tickets).toBe(before.tickets);
		expect((await inbox(player)).notifications[0]).toMatchObject({
			category: "tickets",
			title: "Staff replied to your ticket",
		});

		// With badges and alerts both off, the queue is not even counted.
		await post("/api/settings", mod, { prefs: { staff_badges: false } });
		expect((await call("/api/attention", { as: mod })).data.staff).not.toBeNull();
		const saved = await post("/api/settings", mod, { prefs: { staff_alerts: false } });
		expect(saved.data.prefs).toMatchObject({ staff_badges: false, staff_alerts: false });
		expect((await call("/api/attention", { as: mod })).data.staff).toBeNull();

		// Players never see the staff-only options.
		const prefs = (await call("/api/auth/me", { as: player })).data.prefs;
		expect(prefs.staff_badges).toBeUndefined();
		expect(prefs.staff_alerts).toBeUndefined();
	});
});
