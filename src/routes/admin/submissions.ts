import { Hono } from "hono";
import { db, type Submission } from "../../db";
import { LIMITS } from "../../config";
import { isFullStaff, requireStaff } from "../../auth/guards";
import { auditLog } from "../../lib/audit";
import { fail, idParam, readJson } from "../../lib/http";
import { deleteUpload } from "../../lib/uploads";
import { displayName, notify } from "../../lib/webhook";
import { award } from "../../achievements";
import { requireReason } from "../../moderation";
import { notifyUser } from "../../notifications";

export const adminSubmissionRoutes = new Hono();

/** How many reviewed items the Reviewed list goes back. */
const HISTORY_LIMIT = 100;

type PendingSubmission = Submission & { username: string | null };

function pendingSubmission(id: number): PendingSubmission {
	return (
		db
			.query<PendingSubmission, [number]>(
				"SELECT s.*, u.username FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by WHERE s.id = ? AND s.status = 'pending'"
			)
			.get(id) ?? fail(404, "This submission no longer exists or was already reviewed")
	);
}

/** How close an existing location has to be to a submitted pin to be shown beside it, in map units. */
const NEARBY_UNITS = 600;
const NEARBY_MAX = 4;

type Spot = {
	id: number;
	label: string | null;
	image_path: string;
	world_x: number;
	world_y: number;
	is_active: number;
};

/** The queue. Each item carries only the locations near its pin, so reviewing never reveals the answer list. */
adminSubmissionRoutes.get("/", (c) => {
	requireStaff(c, "helper");
	const pending = db
		.query<Submission & { username: string | null; display_name: string | null }, []>(
			`SELECT s.*, u.username, u.display_name
			FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by
			WHERE s.status = 'pending'
			ORDER BY s.created_at ASC`
		)
		.all();
	const spots = pending.length
		? db.query<Spot, []>("SELECT id, label, image_path, world_x, world_y, is_active FROM locations").all()
		: [];
	return c.json(
		pending.map((submission) => ({
			...submission,
			nearby: spots
				.map((spot) => ({
					...spot,
					distance: Math.round(
						Math.hypot(spot.world_x - submission.world_x, spot.world_y - submission.world_y)
					),
				}))
				.filter((spot) => spot.distance <= NEARBY_UNITS)
				.sort((a, b) => a.distance - b.distance)
				.slice(0, NEARBY_MAX),
		}))
	);
});

adminSubmissionRoutes.get("/history", (c) => {
	const staff = requireStaff(c, "helper");
	const mine = isFullStaff(staff) ? "" : `AND s.reviewed_by = ${staff.id}`;
	return c.json(
		db
			.query(
				`SELECT s.id, s.image_path, s.label, s.world_x, s.world_y, s.status, s.deny_reason, s.created_at, s.reviewed_at,
					s.submitted_by, u.username, u.display_name, r.username AS reviewed_by_username
				FROM submissions s
				LEFT JOIN users u ON u.id = s.submitted_by
				LEFT JOIN users r ON r.id = s.reviewed_by
				WHERE s.status != 'pending' ${mine}
				ORDER BY s.reviewed_at DESC, s.id DESC LIMIT ${HISTORY_LIMIT}`
			)
			.all()
	);
});

adminSubmissionRoutes.post("/:id/approve", async (c) => {
	const staff = requireStaff(c, "helper");
	const id = idParam(c);
	const body = await readJson<{ label: string }>(c);
	const sub = pendingSubmission(id);

	const label = typeof body.label === "string" ? body.label.trim() : (sub.label || "").trim();
	if (label.length < LIMITS.labelMin || label.length > LIMITS.labelMax)
		fail(400, `A label is required: ${LIMITS.labelMin}-${LIMITS.labelMax} characters (got ${label.length}).`);

	db.transaction(() => {
		db.run(
			"INSERT INTO locations (image_path, world_x, world_y, label, hints, submitted_by, approved_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[sub.image_path, sub.world_x, sub.world_y, label, sub.hints || "[]", sub.submitted_by, staff.id]
		);
		db.run("UPDATE submissions SET status = 'approved', reviewed_by = ?, reviewed_at = unixepoch() WHERE id = ?", [
			staff.id,
			id,
		]);
	})();

	notify(
		"submissions",
		`**Submission #${id} approved** by **${displayName(staff)}** - "${label}"${sub.username ? ` (originally by ${sub.username})` : ""}`,
		"/admin#submissions"
	);
	const earned = award(sub.submitted_by, "contributor", { quiet: true });
	notifyUser(sub.submitted_by, "submissions", {
		title: "Your location was approved",
		body: `"${label}" is now in the game. Thanks for contributing.${earned ? " You earned the Cartographer achievement." : ""}`,
		link: "/settings#submissions",
	});
	auditLog(staff, "submission_approve", {
		targetType: "submission",
		targetId: id,
		targetUsername: sub.username,
		details: label,
	});
	return c.json({ success: true });
});

adminSubmissionRoutes.post("/:id/deny", async (c) => {
	const staff = requireStaff(c, "helper");
	const id = idParam(c);
	const body = await readJson<{ reason: string }>(c);
	const sub = pendingSubmission(id);
	const reason = requireReason(body.reason, "A reason for denying");

	db.run(
		"UPDATE submissions SET status = 'denied', reviewed_by = ?, reviewed_at = unixepoch(), deny_reason = ? WHERE id = ?",
		[staff.id, reason, id]
	);
	await deleteUpload(sub.image_path);

	notify(
		"submissions",
		`**Submission #${id} denied** by **${displayName(staff)}**${sub.label ? ` - "${sub.label}"` : ""}${reason ? `\n> Reason: ${reason}` : ""}`,
		"/admin#submissions"
	);
	notifyUser(sub.submitted_by, "submissions", {
		title: "Your location was not accepted",
		body: `"${sub.label || "Your submission"}"${reason ? `: ${reason}` : " was denied."}`,
		link: "/settings#submissions",
	});
	auditLog(staff, "submission_deny", {
		targetType: "submission",
		targetId: id,
		targetUsername: sub.username,
		details: reason,
	});
	return c.json({ success: true });
});
