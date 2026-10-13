import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { sendScheduledAnnouncements } from "../src/announcements";
import { sendDueDigests, setTestSender } from "../src/email";
import { writeLog } from "../src/lib/logs";
import { setFeature } from "../src/system/features";
import { DAY, nowSec } from "../src/lib/time";
import { notifyUser } from "../src/notifications";
import { call, createUser, post, resetReviewQueues, type TestUser } from "./helpers";

function pendingSubmission(author: TestUser, label = "The goods shed"): number {
	return Number(
		db.run(
			"INSERT INTO submissions (image_path, world_x, world_y, label, submitted_by) VALUES ('n.webp', 1, 2, ?, ?)",
			[label, author.id]
		).lastInsertRowid
	);
}

const inbox = (user: TestUser) => call("/api/notifications", { as: user }).then((r) => r.data);

beforeAll(resetReviewQueues);

describe("notifications", () => {
	test("a reviewed submission lands in its author's inbox and can be marked read", async () => {
		const author = createUser();
		const mod = createUser({ role: "moderator" });
		expect((await inbox(author)).unread).toBe(0);

		await post(`/api/admin/submissions/${pendingSubmission(author)}/approve`, mod);
		const blurry = pendingSubmission(author, "A blurry field");
		/** A denial has to say why. */
		expect((await post(`/api/admin/submissions/${blurry}/deny`, mod, {})).status).toBe(400);
		expect((await post(`/api/admin/submissions/${blurry}/deny`, mod, { reason: "  no " })).status).toBe(400);
		await post(`/api/admin/submissions/${blurry}/deny`, mod, {
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
		expect(during.total).toBe(during.submissions + during.suggestions + during.tickets + during.users);
		expect((await call("/api/attention", { as: player })).data.staff).toBeNull();

		await post(`/api/admin/support/${ticket.data.id}/reply`, mod, { reply: "Fixed, thank you." });
		expect((await call("/api/attention", { as: mod })).data.staff.tickets).toBe(before.tickets);
		expect((await inbox(player)).notifications[0]).toMatchObject({
			category: "tickets",
			title: "Staff replied to your ticket",
		});

		/** With badges and alerts both off, the queue is not even counted. */
		await post("/api/settings", mod, { prefs: { staff_badges: false } });
		expect((await call("/api/attention", { as: mod })).data.staff).not.toBeNull();
		const saved = await post("/api/settings", mod, { prefs: { staff_alerts: false } });
		expect(saved.data.prefs).toMatchObject({ staff_badges: false, staff_alerts: false });
		expect((await call("/api/attention", { as: mod })).data.staff).toBeNull();

		/** Players never see the staff-only options. */
		const prefs = (await call("/api/auth/me", { as: player })).data.prefs;
		expect(prefs.staff_badges).toBeUndefined();
		expect(prefs.staff_alerts).toBeUndefined();
	});
});

describe("emailed summaries", () => {
	test("an address must be confirmed, then gets one email per period with everything unread", async () => {
		const outbox: { to: string; subject: string; text: string }[] = [];
		setTestSender(async (mail) => void outbox.push(mail));
		setFeature("email_digests", true);
		try {
			const player = createUser();
			const me = async () => (await call("/api/auth/me", { as: player })).data.email;
			expect(await me()).toMatchObject({ available: true, address: null, verified: false, frequency: "off" });
			expect((await post("/api/settings/email", player, { email: "not an address" })).status).toBe(400);
			expect((await post("/api/settings/email", player, { email: "Player@Example.com" })).status).toBe(200);
			/** The page is told which address it is, never the address itself. */
			expect((await me()).address).toBe("p****r@example.com");
			expect(outbox[0].to).toBe("player@example.com");
			expect((await post("/api/settings/email/frequency", player, { frequency: "hourly" })).status).toBe(409);

			/** Nothing goes out to an address nobody has confirmed. */
			notifyUser(player.id, "tickets", { title: "Staff replied to your ticket" });
			expect(await sendDueDigests(nowSec() + 2 * DAY)).toBe(0);

			const token = /token=([0-9a-f]+)/.exec(outbox[0].text)![1];
			expect((await call("/api/email/confirm?token=nope")).status).toBe(410);
			expect((await call(`/api/email/confirm?token=${token}`)).status).toBe(200);
			expect(await me()).toMatchObject({ verified: true, frequency: "daily" });

			notifyUser(player.id, "tickets", { title: "Your ticket was closed" });
			notifyUser(player.id, "submissions", { title: "Your submission was approved" });
			expect(await sendDueDigests(nowSec() + 3600)).toBe(0);
			expect(await sendDueDigests(nowSec() + DAY + 60)).toBe(1);
			const digest = outbox.at(-1)!;
			expect(digest.subject).toContain("2 new notifications");
			expect(digest.text).toContain("Your submission was approved");
			/** Sent once: the next run has nothing new to say. */
			expect(await sendDueDigests(nowSec() + 2 * DAY + 120)).toBe(0);

			/** The link in the email stops them without logging in. */
			expect((await call(`/api/email/unsubscribe?token=${token}`)).status).toBe(200);
			expect((await me()).frequency).toBe("off");
			expect((await call("/api/settings/email", { method: "DELETE", as: player })).status).toBe(200);
			expect(await me()).toMatchObject({ address: null, verified: false });
		} finally {
			setTestSender(null);
			setFeature("email_digests", false);
		}
	});
});

describe("scheduled announcements and the system breakdown", () => {
	test("a scheduled announcement waits for its time, can be called off, and one can go to a single player", async () => {
		const admin = createUser({ role: "admin" });
		const reader = createUser();
		const got = async () =>
			(await call("/api/notifications", { as: reader })).data.notifications.map(
				(n: { title: string }) => n.title
			);

		const later = await post("/api/admin/announcements", admin, {
			title: "Planned for later",
			body: "This one goes out in a while.",
			audience: "everyone",
			send_at: nowSec() + 3600,
		});
		expect(later.data).toMatchObject({ scheduled: true, sent: 0 });
		expect(await got()).not.toContain("Planned for later");
		expect(sendScheduledAnnouncements(nowSec() + 60)).toBe(0);
		expect(sendScheduledAnnouncements(nowSec() + 3700)).toBe(1);
		expect(await got()).toContain("Planned for later");

		const dropped = await post("/api/admin/announcements", admin, {
			title: "Never to be sent",
			body: "This one is called off first.",
			send_at: nowSec() + 3600,
		});
		expect((await post(`/api/admin/announcements/${dropped.data.id}/recall`, admin)).status).toBe(200);
		expect(sendScheduledAnnouncements(nowSec() + 3700)).toBe(0);

		expect(
			(
				await post("/api/admin/announcements", admin, {
					title: "To nobody",
					body: "No such player here.",
					audience: "player",
					username: "nobody-by-this-name",
				})
			).status
		).toBe(404);
		const direct = await post("/api/admin/announcements", admin, {
			title: "Just for you",
			body: "A note for one player only.",
			audience: "player",
			username: reader.username,
		});
		expect(direct.data.sent).toBe(1);
		const listed = (await call("/api/admin/announcements", { as: admin })).data.history.find(
			(a: { id: number }) => a.id === direct.data.id
		);
		expect(listed).toMatchObject({ target_username: reader.username, in_inboxes: 1, read: 0 });
	});

	test("the breakdown folds repeated log lines into one and is for operators", async () => {
		for (let i = 0; i < 3; i++) writeLog("error", ["breakdown test: the same thing went wrong"]);
		expect((await call("/api/admin/system/breakdown", { as: createUser({ role: "admin" }) })).status).toBe(403);
		const findings = (await call("/api/admin/system/breakdown", { as: createUser({ role: "operator" }) })).data;
		const line = findings.find((f: { title: string }) => f.title.includes("breakdown test"));
		expect(line).toMatchObject({ level: "problem", count: 3 });
	});
});

describe("unlinking an email", () => {
	test("a player can delete their address at any time, even while email is switched off", async () => {
		const operator = createUser({ role: "operator" });
		const player = createUser();
		setTestSender(async () => {});
		setFeature("email_digests", true);
		try {
			expect((await post("/api/settings/email", player, { email: "gone@example.com" })).status).toBe(200);
			await post("/api/admin/system/features", operator, { feature: "email_digests", enabled: false });
			/** Hidden as a setting, but the saved address is still shown so it can be removed. */
			expect((await call("/api/auth/me", { as: player })).data.email).toMatchObject({
				available: false,
				address: "g****e@example.com",
			});
			expect((await call("/api/settings/email", { method: "DELETE", as: player })).status).toBe(200);
			const row = db
				.query<Record<string, unknown>, [number]>(
					"SELECT email, email_verified, email_token, email_digest FROM users WHERE id = ?"
				)
				.get(player.id);
			expect(row).toEqual({ email: null, email_verified: 0, email_token: null, email_digest: null });
		} finally {
			setTestSender(null);
			setFeature("email_digests", false);
		}
	});
});

describe("clearing every email", () => {
	test("an operator can delete all saved addresses in one go, and nobody else can", async () => {
		const operator = createUser({ role: "operator" });
		const players = [createUser(), createUser()];
		for (const player of players)
			db.run("UPDATE users SET email = ?, email_verified = 1, email_digest = 'daily' WHERE id = ?", [
				`${player.username}@example.com`,
				player.id,
			]);
		const saved = () =>
			db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE email IS NOT NULL").get()!.n;
		expect(saved()).toBeGreaterThanOrEqual(2);
		expect(
			(await post("/api/admin/system/email/clear", createUser({ role: "admin" }), { confirm: true })).status
		).toBe(403);
		expect((await post("/api/admin/system/email/clear", operator, {})).status).toBe(400);
		expect(saved()).toBeGreaterThanOrEqual(2);
		const cleared = await post("/api/admin/system/email/clear", operator, { confirm: true });
		expect(cleared.data.removed).toBeGreaterThanOrEqual(2);
		expect(saved()).toBe(0);
		expect((await call("/api/auth/me", { as: players[0] })).data.email).toMatchObject({
			address: null,
			frequency: "off",
		});
	});
});

describe("switching email on", () => {
	test("email is off without a mail server, cannot be switched on, and goes off when the server is removed", async () => {
		const operator = createUser({ role: "operator" });
		const player = createUser();
		const toggle = (enabled: boolean) =>
			post("/api/admin/system/features", operator, { feature: "email_digests", enabled });
		const state = async () => (await call("/api/admin/system/email", { as: operator })).data;

		expect(await state()).toMatchObject({ saved: false, enabled: false });
		expect((await toggle(true)).status).toBe(409);
		/** With nothing saved and email off, a player is not shown the setting at all. */
		expect((await call("/api/auth/me", { as: player })).data.email).toMatchObject({
			available: false,
			address: null,
		});
		expect((await post("/api/settings/email", player, { email: "early@example.com" })).status).toBe(503);

		/** A stand-in for a working mail server: now it can be switched on, and off again. */
		setTestSender(async () => {});
		try {
			expect((await toggle(true)).status).toBe(200);
			expect((await call("/api/auth/me", { as: player })).data.email.available).toBe(true);
			/** Removing the mail server switches email off with it. */
			expect((await call("/api/admin/system/email/settings", { method: "DELETE", as: operator })).status).toBe(
				200
			);
			expect((await call("/api/auth/me", { as: player })).data.email.available).toBe(false);
		} finally {
			setTestSender(null);
			setFeature("email_digests", false);
		}
	});
});

describe("the mail server", () => {
	test("only an operator can change it, the password is never sent back, and every email says not to reply", async () => {
		const operator = createUser({ role: "operator" });
		expect((await call("/api/admin/system/email", { as: createUser({ role: "admin" }) })).status).toBe(403);
		expect(
			(
				await post("/api/admin/system/email/settings", operator, {
					host: "not a host",
					port: 465,
					user: "a",
					from: "a@b.co",
				})
			).status
		).toBe(400);
		const saved = await post("/api/admin/system/email/settings", operator, {
			host: "smtp.example.com",
			port: 465,
			user: "notifications@example.com",
			pass: "a-secret-password",
			from: "Dovedale GeoGuesser <notifications@example.com>",
		});
		expect(saved.status).toBe(200);
		/** Hidden until asked for, and the password not even then. */
		const hidden = (await call("/api/admin/system/email", { as: operator })).data;
		expect(hidden).toMatchObject({ saved: true, has_password: true });
		expect(JSON.stringify(hidden)).not.toContain("smtp.example.com");
		const info = (await call("/api/admin/system/email?reveal=1", { as: operator })).data;
		expect(info).toMatchObject({ host: "smtp.example.com", user: "notifications@example.com" });
		expect(JSON.stringify(info)).not.toContain("a-secret-password");

		const outbox: { text: string; html: string; headers?: Record<string, string> }[] = [];
		setTestSender(async (mail) => void outbox.push(mail));
		try {
			const before = (await call("/api/admin/system/email", { as: operator })).data.stats.total;
			expect((await post("/api/admin/system/email/test", operator, { to: "someone@example.com" })).status).toBe(
				200
			);
			expect(outbox[0].text).toContain("please don't reply");
			expect(outbox[0].html).toContain("please don't reply");
			expect(outbox[0].headers?.["Auto-Submitted"]).toBe("auto-generated");
			expect((await call("/api/admin/system/email", { as: operator })).data.stats.total).toBe(before + 1);
		} finally {
			setTestSender(null);
			await call("/api/admin/system/email/settings", { method: "DELETE", as: operator });
		}
		expect((await call("/api/admin/system/email", { as: operator })).data.saved).toBe(false);
	});
});

describe("announcement options", () => {
	const send = (as: TestUser, extra: Record<string, unknown>) =>
		post("/api/admin/announcements", as, {
			title: "An option test",
			body: "Checking one of the options.",
			...extra,
		});
	const inbox = async (as: TestUser) =>
		(await call("/api/notifications", { as })).data.notifications.map((n: { title: string }) => n.title);
	const listed = async (as: TestUser, id: number) =>
		(await call("/api/admin/announcements?limit=200", { as })).data.history.find(
			(a: { id: number }) => a.id === id
		);

	test("audiences pick out new players and helpers", async () => {
		const admin = createUser({ role: "admin" });
		const fresh = createUser();
		const veteran = createUser({ ageDays: 60 });
		const helper = createUser({ role: "helper", ageDays: 60 });
		await send(admin, { title: "Welcome aboard", audience: "new" });
		expect(await inbox(fresh)).toContain("Welcome aboard");
		expect(await inbox(veteran)).not.toContain("Welcome aboard");
		await send(admin, { title: "Queue is long", audience: "helpers" });
		expect(await inbox(helper)).toContain("Queue is long");
		expect(await inbox(veteran)).not.toContain("Queue is long");
		expect((await send(admin, { audience: "helpers", banner_hours: 1 })).status).toBe(400);
	});

	test("a banner-only announcement reaches no inbox, and its style is kept", async () => {
		const admin = createUser({ role: "admin" });
		const player = createUser();
		expect((await send(admin, { silent: true })).status).toBe(400);
		const banner = await send(admin, { title: "Duels are slow", silent: true, banner_hours: 1, style: "warning" });
		expect(banner.data.sent).toBe(0);
		expect(await inbox(player)).not.toContain("Duels are slow");
		expect((await call("/api/announcement")).data).toMatchObject({ title: "Duels are slow", style: "warning" });
		await post(`/api/admin/announcements/${banner.data.id}/banner`, admin, { hours: 0 });
	});

	test("drafts wait unsent, and sending from one clears it", async () => {
		const admin = createUser({ role: "admin" });
		const player = createUser();
		const draft = await send(admin, { title: "Half written", draft: true });
		expect(draft.data).toMatchObject({ draft: true, sent: 0 });
		expect(await inbox(player)).not.toContain("Half written");
		expect(await listed(admin, draft.data.id)).toMatchObject({ draft: 1, can_delete: true });
		const sent = await send(admin, { title: "Fully written", from_draft: draft.data.id });
		expect(await inbox(player)).toContain("Fully written");
		expect(await listed(admin, draft.data.id)).toBeUndefined();
		/** Fresh and sent: it cannot be removed from the history yet. */
		expect(await listed(admin, sent.data.id)).toMatchObject({ can_delete: false });
		expect((await call(`/api/admin/announcements/${sent.data.id}`, { method: "DELETE", as: admin })).status).toBe(
			409
		);
		db.run("UPDATE announcements SET created_at = unixepoch() - 8 * 86400 WHERE id = ?", [sent.data.id]);
		expect((await call(`/api/admin/announcements/${sent.data.id}`, { method: "DELETE", as: admin })).status).toBe(
			200
		);
		/** The copy in the inbox stays. */
		expect(await inbox(player)).toContain("Fully written");
	});

	test("a repeating announcement queues its next turn, and an expiring one leaves inboxes", async () => {
		const admin = createUser({ role: "admin" });
		const player = createUser();
		expect((await send(admin, { repeat: "weekly" })).status).toBe(400);
		const first = await send(admin, {
			title: "Weekly reminder",
			send_at: nowSec() + 3600,
			repeat: "weekly",
			expire_days: 1,
		});
		expect(sendScheduledAnnouncements(nowSec() + 3700)).toBe(1);
		expect(await inbox(player)).toContain("Weekly reminder");
		const next = db
			.query<{ send_at: number }, [number]>(
				"SELECT send_at FROM announcements WHERE title = 'Weekly reminder' AND send_at IS NOT NULL AND id != ?"
			)
			.get(first.data.id)!;
		expect(next.send_at).toBeGreaterThan(nowSec() + 6 * DAY);
		db.run("DELETE FROM announcements WHERE title = 'Weekly reminder' AND send_at IS NOT NULL");
		/** A day and a bit later it has gone from the inbox by itself. */
		sendScheduledAnnouncements(nowSec() + 2 * DAY);
		expect(await inbox(player)).not.toContain("Weekly reminder");
	});

	test("one that must be acknowledged is pending until read, and staff can see who has not read theirs", async () => {
		const admin = createUser({ role: "admin" });
		const player = createUser();
		const mod = createUser({ role: "moderator" });
		await send(admin, { title: "The terms have changed", must_ack: true });
		const pending = (await call("/api/announcement/pending", { as: player })).data;
		expect(pending).toMatchObject({ title: "The terms have changed" });
		expect((await call("/api/announcement/pending")).data).toBeNull();
		await post("/api/notifications/read", player, { ids: [pending.notification_id] });
		expect((await call("/api/announcement/pending", { as: player })).data).toBeNull();

		const note = await send(admin, { title: "Read this, staff", audience: "staff" });
		expect((await call(`/api/admin/announcements/${note.data.id}/unread`, { as: admin })).data).toContain(
			mod.username
		);
		const everyone = await send(admin, { title: "For all" });
		expect((await call(`/api/admin/announcements/${everyone.data.id}/unread`, { as: admin })).status).toBe(400);
	});

	test("changelog entries can be added, edited and removed, and share the news page with announcements", async () => {
		const admin = createUser({ role: "admin" });
		expect((await post("/api/admin/announcements/changelog", createUser({ role: "supervisor" }), {})).status).toBe(
			403
		);
		expect(
			(await post("/api/admin/announcements/changelog", admin, { title: "x", body: "y", released_at: nowSec() }))
				.status
		).toBe(400);
		const added = await post("/api/admin/announcements/changelog", admin, {
			title: "October update",
			body: "New special: Flash\nReport a location from the result screen",
			released_at: nowSec() + 60,
		});
		expect(added.status).toBe(200);
		await send(admin, { title: "News for everyone" });
		await send(admin, { title: "News for staff only", audience: "staff" });
		const news = (await call("/api/news")).data;
		expect(news[0]).toMatchObject({ kind: "update", title: "October update" });
		const titles = news.map((item: { title: string }) => item.title);
		expect(titles).toContain("News for everyone");
		expect(titles).not.toContain("News for staff only");
		expect((await call("/news")).status).toBe(200);

		const id = added.data.id;
		expect(
			(
				await post(`/api/admin/announcements/changelog/${id}`, admin, {
					title: "October update, part two",
					body: "One more change",
					released_at: nowSec(),
				})
			).status
		).toBe(200);
		expect((await call("/api/admin/announcements/changelog", { as: admin })).data[0].title).toBe(
			"October update, part two"
		);
		expect((await call(`/api/admin/announcements/changelog/${id}`, { method: "DELETE", as: admin })).status).toBe(
			200
		);
		expect((await call("/api/news")).data.map((item: { title: string }) => item.title)).not.toContain(
			"October update, part two"
		);
	});
});

describe("the link counter", () => {
	test("stops counting after a few visits a minute from one address, but still sends the visitor on", async () => {
		const admin = createUser({ role: "admin" });
		const sent = await post("/api/admin/announcements", admin, {
			title: "Counted link",
			body: "Follow this to the daily challenge.",
			link: "/daily",
		});
		const go = `/api/announcement/${sent.data.id}/go`;
		for (let i = 0; i < 20; i++) {
			const visit = await call(go);
			expect(visit.status).toBe(302);
			expect(visit.headers.get("Location")).toBe("/daily");
		}
		const clicks = (await call("/api/admin/announcements?limit=200", { as: admin })).data.history.find(
			(a: { id: number }) => a.id === sent.data.id
		).clicks;
		expect(clicks).toBeGreaterThan(0);
		expect(clicks).toBeLessThanOrEqual(6);
	});

	test("sends a link to another site by way of the page that warns about leaving", async () => {
		const admin = createUser({ role: "admin" });
		const link = "https://example.com/map?zoom=2#top";
		const sent = await post("/api/admin/announcements", admin, {
			title: "Elsewhere",
			body: "The full map lives on another site.",
			link,
			banner_hours: 1,
		});
		expect(sent.status).toBe(200);
		const go = `/api/announcement/${sent.data.id}/go`;
		expect((await call("/api/announcement")).data).toMatchObject({ link: go, external: true });
		const visit = await call(go);
		expect(visit.status).toBe(302);
		expect(visit.headers.get("Location")).toBe(`/leaving?to=${encodeURIComponent(link)}`);
		expect((await call("/leaving")).status).toBe(200);
	});
});
