import { Hono } from "hono";
import { db } from "../../db";
import { requireStaff } from "../../auth/guards";
import { auditLog } from "../../lib/audit";
import { fail, idParam, readJson, text } from "../../lib/http";
import { DAY, nowSec } from "../../lib/time";
import { notifyUser } from "../../notifications";
import { TICKET_CATEGORIES, listTickets } from "../support";

export const adminSupportRoutes = new Hono();

const CLOSED_TICKET_RETENTION = 180 * DAY;

function getTicket(id: number) {
	return (
		db
			.query<{ id: number; status: string; user_id: number; subject: string }, [number]>(
				"SELECT id, status, user_id, subject FROM support_tickets WHERE id = ?"
			)
			.get(id) ?? fail(404, "Ticket not found")
	);
}

export function deleteOldClosedTickets(): number {
	return db.run("DELETE FROM support_tickets WHERE status = 'closed' AND created_at < ?", [
		nowSec() - CLOSED_TICKET_RETENTION,
	]).changes;
}

adminSupportRoutes.get("/", (c) => {
	requireStaff(c);
	const status = c.req.query("status") === "closed" ? "closed" : "open";
	const category = c.req.query("category") || "";
	const params = [status];
	let where = "t.status = ?";
	if (TICKET_CATEGORIES.includes(category)) {
		where += " AND t.category = ?";
		params.push(category);
	}
	return c.json(listTickets(where, params, "t.created_at ASC"));
});

adminSupportRoutes.get("/counts", (c) => {
	requireStaff(c);
	return c.json(
		db.query("SELECT status, category, COUNT(*) AS count FROM support_tickets GROUP BY status, category").all()
	);
});

/** Last staff ticket close, from the audit log, since tickets keep no close time. */
adminSupportRoutes.get("/last-closed", (c) => {
	requireStaff(c);
	const row = db
		.query<{ at: number | null }, []>("SELECT MAX(created_at) AS at FROM audit_log WHERE action = 'ticket_close'")
		.get();
	return c.json({ at: row?.at ?? null });
});

adminSupportRoutes.post("/cleanup", (c) => {
	const staff = requireStaff(c, "admin");
	const deleted = deleteOldClosedTickets();
	auditLog(staff, "ticket_cleanup", { details: `${deleted} tickets removed` });
	return c.json({ deleted });
});

adminSupportRoutes.post("/:id/reply", async (c) => {
	const staff = requireStaff(c);
	const ticket = getTicket(idParam(c));
	const body = await readJson<{ reply: string; close: boolean }>(c);
	const reply = text(body.reply, 2000);
	const close = body.close === true;
	if (!reply && !close) fail(400, "Write a reply first");

	db.transaction(() => {
		if (reply) {
			db.run(
				"INSERT INTO ticket_replies (ticket_id, author_id, author_username, body, type) VALUES (?, ?, ?, ?, 'staff')",
				[ticket.id, staff.id, staff.username, reply]
			);
		}
		db.run("UPDATE support_tickets SET status = ?, awaiting_staff = 0, close_requested = 0 WHERE id = ?", [
			close ? "closed" : "open",
			ticket.id,
		]);
	})();
	notifyUser(ticket.user_id, "tickets", {
		title: reply
			? close
				? "Staff replied and closed your ticket"
				: "Staff replied to your ticket"
			: "Your ticket was closed",
		body: `"${ticket.subject}"${reply ? `: ${reply}` : ""}`,
		link: `/settings?open_ticket=${ticket.id}#support`,
	});
	if (reply)
		auditLog(staff, "ticket_reply", { targetType: "ticket", targetId: ticket.id, details: reply.slice(0, 100) });
	if (close) auditLog(staff, "ticket_close", { targetType: "ticket", targetId: ticket.id });
	return c.json({ success: true });
});

adminSupportRoutes.post("/:id/close", (c) => {
	const staff = requireStaff(c);
	const ticket = getTicket(idParam(c));
	db.run("UPDATE support_tickets SET status = 'closed', awaiting_staff = 0, close_requested = 0 WHERE id = ?", [
		ticket.id,
	]);
	if (ticket.status !== "closed") {
		notifyUser(ticket.user_id, "tickets", {
			title: "Your ticket was closed",
			body: `"${ticket.subject}"`,
			link: `/settings?open_ticket=${ticket.id}#support`,
		});
	}
	auditLog(staff, "ticket_close", { targetType: "ticket", targetId: ticket.id });
	return c.json({ success: true });
});

adminSupportRoutes.post("/:id/reopen", (c) => {
	const staff = requireStaff(c);
	const ticket = getTicket(idParam(c));
	db.run("UPDATE support_tickets SET status = 'open' WHERE id = ?", [ticket.id]);
	auditLog(staff, "ticket_reopen", { targetType: "ticket", targetId: ticket.id });
	return c.json({ success: true });
});

adminSupportRoutes.delete("/:id", (c) => {
	const staff = requireStaff(c, "admin");
	const ticket = getTicket(idParam(c));
	if (ticket.status !== "closed") fail(400, "Can only delete closed tickets");
	db.run("DELETE FROM support_tickets WHERE id = ?", [ticket.id]);
	auditLog(staff, "ticket_delete", { targetType: "ticket", targetId: ticket.id });
	return c.json({ success: true });
});
