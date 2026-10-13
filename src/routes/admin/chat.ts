import { Hono } from "hono";
import { GAME } from "../../config";
import { db, type Role, type User } from "../../db";
import { hasRole, requireStaff, roleRank } from "../../auth/guards";
import { auditLog } from "../../lib/audit";
import { fail, idParam, readJson, text } from "../../lib/http";
import { checkRateLimit } from "../../lib/rate-limit";
import { DAY } from "../../lib/time";
import { STAFF_CHAT_ROLE, notifyUser, parsePreferences } from "../../notifications";

/** Routes mounted at /api/admin/chat: one room where staff talk to each other. */
export const adminChatRoutes = new Hono();

const CHAT_ROLE = STAFF_CHAT_ROLE;
/** Who may delete someone else's message or take off someone else's pin, and then only a lower role's. */
const CHAT_MODERATOR_ROLE: Role = "supervisor";
const MESSAGE_MAX = 1000;
/** How many of the newest messages the room shows. */
const SHOWN = 150;
/** Messages older than this many days are deleted by the nightly clean-up, unless they are pinned. */
export const CHAT_RETENTION_DAYS = 90;
/** How many messages each member of staff may have pinned at once, by role. */
const PIN_LIMITS: Partial<Record<Role, number>> = { curator: 3, moderator: 5, supervisor: 10, admin: 20, operator: 30 };
const pinLimit = (staff: User) => PIN_LIMITS[staff.role as Role] ?? 0;

type Message = {
	id: number;
	author_id: number | null;
	author_username: string | null;
	body: string;
	created_at: number;
	pinned_at: number | null;
	pinned_by: number | null;
	pinned_by_username: string | null;
	display_name: string | null;
	avatar_url: string | null;
	/** The roles its author and whoever pinned it hold now. */
	role: Role | null;
	pinner_role: Role | null;
};

const MESSAGE_COLUMNS = `m.id, m.author_id, m.author_username, m.body, m.created_at, m.pinned_at, m.pinned_by,
	m.pinned_by_username, u.display_name, u.avatar_url, u.role, p.role AS pinner_role`;
const MESSAGE_SOURCE = `staff_chat m LEFT JOIN users u ON u.id = m.author_id LEFT JOIN users p ON p.id = m.pinned_by`;

const findMessage = (id: number) =>
	db.query<Message, [number]>(`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_SOURCE} WHERE m.id = ?`).get(id);

/** What this member of staff may do to a message: anything to their own, and to another's only from a lower role. */
function allowed(staff: User, m: Message) {
	const rank = roleRank(staff.role);
	const senior = hasRole(staff, CHAT_MODERATOR_ROLE);
	const own = m.author_id === staff.id;
	const outranksAuthor = rank > roleRank(m.role);
	return {
		delete: own || (senior && outranksAuthor),
		pin: own || outranksAuthor,
		unpin: m.pinned_by === staff.id || (senior && rank > roleRank(m.pinner_role)),
	};
}

const pinsHeldBy = (staff: User) =>
	db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM staff_chat WHERE pinned_by = ?").get(staff.id)?.n ?? 0;

/** The newest messages, oldest first, and every pinned one however old. Reading the room counts as having seen them. */
adminChatRoutes.get("/", (c) => {
	const staff = requireStaff(c, CHAT_ROLE);
	const messages = db
		.query<Message, [number]>(`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_SOURCE} ORDER BY m.id DESC LIMIT ?`)
		.all(SHOWN)
		.reverse();
	const pins = db
		.query<Message, []>(
			`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_SOURCE}
			WHERE m.pinned_at IS NOT NULL ORDER BY m.pinned_at DESC, m.id DESC`
		)
		.all();
	const newest = messages.at(-1)?.id ?? 0;
	if (newest > (staff.staff_chat_read ?? 0))
		db.run("UPDATE users SET staff_chat_read = ? WHERE id = ?", [newest, staff.id]);
	db.run(
		"UPDATE notifications SET read_at = unixepoch() WHERE user_id = ? AND category = 'staff_chat' AND read_at IS NULL",
		[staff.id]
	);
	const forViewer = ({ pinner_role, ...m }: Message) => {
		const may = allowed(staff, { ...m, pinner_role });
		return {
			...m,
			can_delete: may.delete,
			can_pin: m.pinned_at === null && may.pin,
			can_unpin: m.pinned_at !== null && may.unpin,
		};
	};
	return c.json({
		messages: messages.map(forViewer),
		pins: pins.map(forViewer),
		pin_limit: pinLimit(staff),
		pins_used: pinsHeldBy(staff),
		max_length: MESSAGE_MAX,
		/** The duel reactions, usable here as :name: whether or not they are switched on for players. */
		emotes: GAME.duel.emotes,
	});
});

/** How many messages from other staff have arrived since this one last had the room open. */
adminChatRoutes.get("/unread", (c) => {
	const staff = requireStaff(c, CHAT_ROLE);
	const unread =
		db
			.query<{ n: number }, [number, number]>(
				"SELECT COUNT(*) AS n FROM staff_chat WHERE id > ? AND COALESCE(author_id, 0) != ?"
			)
			.get(staff.staff_chat_read ?? 0, staff.id)?.n ?? 0;
	return c.json({ unread });
});

/**
 * An inbox entry for staff who asked for one. It says only that there is something new, and there is one at a time:
 * nothing more is sent until they have opened the room.
 */
function tellStaff(author: User) {
	const others = db
		.query<Pick<User, "id" | "role" | "staff_locked" | "is_banned" | "prefs">, [number]>(
			"SELECT id, role, staff_locked, is_banned, prefs FROM users WHERE role IS NOT NULL AND id != ?"
		)
		.all(author.id);
	for (const member of others) {
		if (member.is_banned || !hasRole(member as User, CHAT_ROLE)) continue;
		if (parsePreferences(member.prefs).staff_chat !== "notify") continue;
		const waiting = db
			.query(
				"SELECT 1 FROM notifications WHERE user_id = ? AND category = 'staff_chat' AND read_at IS NULL LIMIT 1"
			)
			.get(member.id);
		if (!waiting)
			notifyUser(member.id, "staff_chat", { title: "New messages in the staff chat", link: "/admin#chat" });
	}
}

adminChatRoutes.post("/", async (c) => {
	const staff = requireStaff(c, CHAT_ROLE);
	const body = text((await readJson<{ body: string }>(c)).body, MESSAGE_MAX);
	if (!body) fail(400, "Write a message first");
	if (!checkRateLimit(`staff-chat:${staff.id}`, 30, 60 * 1000)) fail(429, "You are sending messages too quickly");
	const id = Number(
		db.run("INSERT INTO staff_chat (author_id, author_username, body) VALUES (?, ?, ?)", [
			staff.id,
			staff.username,
			body,
		]).lastInsertRowid
	);
	/** Their own message is not news to them. */
	db.run("UPDATE users SET staff_chat_read = ? WHERE id = ?", [id, staff.id]);
	tellStaff(staff);
	return c.json({ id });
});

/** Anyone may delete what they wrote; senior staff may delete a lower role's message, and that is logged. */
adminChatRoutes.delete("/:id", (c) => {
	const staff = requireStaff(c, CHAT_ROLE);
	const message = findMessage(idParam(c)) ?? fail(404, "That message has already gone");
	const own = message.author_id === staff.id;
	if (!allowed(staff, message).delete)
		fail(
			403,
			hasRole(staff, CHAT_MODERATOR_ROLE)
				? "You can only delete messages from roles below yours"
				: "You can only delete your own messages"
		);
	db.run("DELETE FROM staff_chat WHERE id = ?", [message.id]);
	if (!own)
		auditLog(staff, "staff_chat_delete", {
			targetType: "user",
			targetId: message.author_id ?? undefined,
			targetUsername: message.author_username ?? undefined,
			details: message.body.slice(0, 200),
		});
	return c.json({ success: true });
});

/** Pins a message or takes the pin off. Pinning what is already pinned changes nothing. */
adminChatRoutes.post("/:id/pin", async (c) => {
	const staff = requireStaff(c, CHAT_ROLE);
	const pinned = (await readJson<{ pinned: boolean }>(c)).pinned !== false;
	const message = findMessage(idParam(c)) ?? fail(404, "That message has gone");
	const may = allowed(staff, message);
	if (pinned) {
		if (message.pinned_at !== null) return c.json({ success: true });
		if (!may.pin) fail(403, "You can only pin your own messages, or ones from roles below yours");
		const limit = pinLimit(staff);
		if (pinsHeldBy(staff) >= limit)
			fail(409, `You have ${limit} pinned messages, the most your role allows. Unpin one first.`);
		db.run("UPDATE staff_chat SET pinned_at = unixepoch(), pinned_by = ?, pinned_by_username = ? WHERE id = ?", [
			staff.id,
			staff.username,
			message.id,
		]);
	} else if (message.pinned_at !== null) {
		if (!may.unpin) fail(403, "Only whoever pinned it, or senior staff above them, can unpin it");
		db.run("UPDATE staff_chat SET pinned_at = NULL, pinned_by = NULL, pinned_by_username = NULL WHERE id = ?", [
			message.id,
		]);
	}
	return c.json({ success: true });
});

/** Pinned messages are kept however old they are. */
export function pruneStaffChat() {
	db.run("DELETE FROM staff_chat WHERE pinned_at IS NULL AND created_at < unixepoch() - ?", [
		CHAT_RETENTION_DAYS * DAY,
	]);
}
