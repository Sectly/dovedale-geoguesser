import { Hono } from "hono";
import { db } from "../db";
import { requireUser } from "../auth/guards";
import { fail, idParam, readJson, text } from "../lib/http";
import { checkUserRateLimit } from "../lib/rate-limit";
import { DAY } from "../lib/time";
import { displayName, md, notify } from "../lib/webhook";

export const supportRoutes = new Hono();

export const TICKET_CATEGORIES = [
	"ban_appeal",
	"submission_appeal",
	"report_user",
	"report_location",
	"account",
	"other",
];

const REPLIES_JSON = `COALESCE((
	SELECT JSON_GROUP_ARRAY(JSON_OBJECT(
		'id', r.id, 'body', r.body, 'type', r.type, 'author_username', r.author_username, 'created_at', r.created_at
	)) FROM (SELECT * FROM ticket_replies WHERE ticket_id = t.id ORDER BY created_at ASC, id ASC) r
), '[]')`;

/** Tickets with their reply thread attached, oldest reply first. */
export function listTickets(where: string, params: (string | number)[], order: string) {
	const rows = db
		.query<Record<string, unknown>, (string | number)[]>(
			`SELECT t.id, t.user_id, t.subject, t.message, t.category, t.status,
				t.awaiting_staff, t.close_requested, t.created_at,
				u.username, u.display_name, u.avatar_url, u.is_banned,
				${REPLIES_JSON} AS replies
			FROM support_tickets t
			JOIN users u ON u.id = t.user_id
			WHERE ${where}
			ORDER BY ${order}`
		)
		.all(...params);
	for (const row of rows) row.replies = JSON.parse(row.replies as string);
	return rows;
}

/** Banned users are deliberately allowed everything here: this is how they appeal. */
supportRoutes.post("/", async (c) => {
	const user = requireUser(c);
	const body = await readJson<{ subject: string; message: string; category: string }>(c);
	const subject = text(body.subject, 100);
	const message = text(body.message, 2000);
	if (!TICKET_CATEGORIES.includes(body.category!)) fail(400, "Invalid category");
	if (subject.length < 5) fail(400, "Subject must be at least 5 characters");
	if (message.length < 20) fail(400, "Message must be at least 20 characters");
	if (!checkUserRateLimit(user, "support", 3, DAY * 1000)) fail(429, "Too many tickets today. Try again tomorrow.");

	const result = db.run("INSERT INTO support_tickets (user_id, subject, message, category) VALUES (?, ?, ?, ?)", [
		user.id,
		subject,
		message,
		body.category!,
	]);
	const id = Number(result.lastInsertRowid);
	notify(
		"support",
		`**Support ticket #${id}** [${body.category}] from **${displayName(user)}**\n> **${subject}**\n> ${message.slice(0, 200)}${message.length > 200 ? "..." : ""}`,
		"/admin#tickets"
	);
	return c.json({ success: true, id });
});

supportRoutes.get("/mine", (c) => {
	const user = requireUser(c);
	const tickets = listTickets("t.user_id = ?", [user.id], "t.created_at DESC LIMIT 20");
	/** Players are never told which member of staff answered them. */
	for (const ticket of tickets) {
		for (const reply of ticket.replies as { type: string; author_username: string | null }[]) {
			if (reply.type === "staff") reply.author_username = "Staff";
		}
	}
	return c.json(tickets);
});

function ownOpenTicket(userId: number, ticketId: number) {
	const ticket = db
		.query<{ status: string; awaiting_staff: number; close_requested: number }, [number, number]>(
			"SELECT status, awaiting_staff, close_requested FROM support_tickets WHERE id = ? AND user_id = ?"
		)
		.get(ticketId, userId);
	if (!ticket) fail(404, "Not found");
	if (ticket.status !== "open") fail(400, "Ticket is closed");
	return ticket;
}

/** A player may send this many messages in a row (the opening one included) before staff must answer. */
const MAX_FOLLOW_UPS = 3;

supportRoutes.post("/:id/reply", async (c) => {
	const user = requireUser(c);
	const ticketId = idParam(c);
	ownOpenTicket(user.id, ticketId);

	const sinceStaff =
		db
			.query<{ n: number }, [number, number]>(
				`SELECT COUNT(*) AS n FROM ticket_replies WHERE ticket_id = ? AND type = 'user'
					AND id > COALESCE((SELECT MAX(id) FROM ticket_replies WHERE ticket_id = ? AND type = 'staff'), 0)`
			)
			.get(ticketId, ticketId)?.n ?? 0;
	const staffHaveReplied = !!db
		.query("SELECT 1 FROM ticket_replies WHERE ticket_id = ? AND type = 'staff' LIMIT 1")
		.get(ticketId);
	if (sinceStaff + (staffHaveReplied ? 0 : 1) >= MAX_FOLLOW_UPS)
		fail(400, "You've sent a few messages in a row. Please wait for staff to reply before adding more.");

	const message = text((await readJson<{ message: string }>(c)).message, 2001);
	if (message.length < 2) fail(400, "Message too short");
	if (message.length > 2000) fail(400, "Message too long");

	db.transaction(() => {
		db.run(
			"INSERT INTO ticket_replies (ticket_id, author_id, author_username, body, type) VALUES (?, ?, ?, ?, 'user')",
			[ticketId, user.id, user.username, message]
		);
		// A new message withdraws any earlier request to close.
		db.run("UPDATE support_tickets SET awaiting_staff = 1, close_requested = 0 WHERE id = ?", [ticketId]);
	})();
	notify(
		"support",
		`**Ticket #${ticketId}: new reply** from **${md(displayName(user))}**\n> ${md(message.slice(0, 300))}${message.length > 300 ? "..." : ""}`,
		`/admin#tickets:${ticketId}`
	);
	return c.json({ success: true });
});

supportRoutes.post("/:id/request-close", (c) => {
	const user = requireUser(c);
	const ticketId = idParam(c);
	if (ownOpenTicket(user.id, ticketId).close_requested)
		fail(400, "You have already asked for this ticket to be closed");
	db.run("UPDATE support_tickets SET close_requested = 1, awaiting_staff = 1 WHERE id = ?", [ticketId]);
	notify(
		"support",
		`**Ticket #${ticketId}: close requested** by **${md(displayName(user))}**`,
		`/admin#tickets:${ticketId}`
	);
	return c.json({ success: true });
});
