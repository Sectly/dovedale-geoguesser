import { Hono } from "hono";
import { db, type Submission } from "../../db";
import { LIMITS } from "../../config";
import { requireStaff } from "../../auth/guards";
import { auditLog } from "../../lib/audit";
import { fail, idParam, readJson } from "../../lib/http";
import { deleteUpload } from "../../lib/uploads";
import { displayName, notify } from "../../lib/webhook";
import { award } from "../../achievements";
import { requireReason } from "../../moderation";
import { notifyUser } from "../../notifications";

export const adminSubmissionRoutes = new Hono();

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

adminSubmissionRoutes.get("/", (c) => {
	requireStaff(c);
	return c.json(
		db
			.query(
				`SELECT s.*, u.username, u.display_name
				FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by
				WHERE s.status = 'pending'
				ORDER BY s.created_at ASC`
			)
			.all()
	);
});

adminSubmissionRoutes.post("/:id/approve", async (c) => {
	const staff = requireStaff(c);
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
	// Said in the same message, so a first approval does not arrive as two notifications.
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
	const staff = requireStaff(c);
	const id = idParam(c);
	const body = await readJson<{ reason: string }>(c);
	const sub = pendingSubmission(id);
	// The player is shown this, so a denial always says why.
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
