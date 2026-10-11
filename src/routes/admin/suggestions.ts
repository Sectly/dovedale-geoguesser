import { Hono } from "hono";
import { db, type Location } from "../../db";
import { LIMITS } from "../../config";
import { requireStaff } from "../../auth/guards";
import { cleanHints, parseHints } from "../../game/locations";
import { parseGuess } from "../../game/round";
import { auditLog } from "../../lib/audit";
import { fail, idParam, readJson, text } from "../../lib/http";
import { deleteUpload } from "../../lib/uploads";
import { displayName, notify } from "../../lib/webhook";
import { requireReason } from "../../moderation";
import { notifyUser } from "../../notifications";

export const adminSuggestionRoutes = new Hono();

type PendingSuggestion = {
	id: number;
	user_id: number;
	location_id: number;
	type: string;
	content: string | null;
	image_path: string | null;
	location_label: string | null;
};

function pendingSuggestion(id: number): PendingSuggestion {
	return (
		db
			.query<PendingSuggestion, [number]>(
				`SELECT ls.id, ls.user_id, ls.location_id, ls.type, ls.content, ls.image_path, l.label AS location_label
				FROM location_suggestions ls JOIN locations l ON l.id = ls.location_id
				WHERE ls.id = ? AND ls.status = 'pending'`
			)
			.get(id) ?? fail(404, "This suggestion no longer exists or was already reviewed")
	);
}

/**
 * Applies an approved suggestion to its location. Returns the screenshot that was
 * replaced, if any, so the caller can delete the file once the change is saved.
 */
function applySuggestion(sug: PendingSuggestion): string | null {
	const location = db.query<Location, [number]>("SELECT * FROM locations WHERE id = ?").get(sug.location_id)!;
	let content: Record<string, unknown> = {};
	try {
		content = JSON.parse(sug.content || "{}");
	} catch {}
	const set = (column: string, value: string | number) =>
		db.run(`UPDATE locations SET ${column} = ? WHERE id = ?`, [value, location.id]);

	let replacedImage: string | null = null;
	const useImage = () => {
		if (!sug.image_path) return;
		replacedImage = location.image_path;
		set("image_path", sug.image_path);
	};
	const useCoords = (required: boolean) => {
		const coords = parseGuess(content.world_x, content.world_y);
		if (!coords && required) fail(400, "This suggestion has no usable coordinates. Deny it instead.");
		if (coords)
			db.run("UPDATE locations SET world_x = ?, world_y = ? WHERE id = ?", [coords.x, coords.y, location.id]);
	};

	switch (sug.type) {
		case "hint": {
			const hint = text(content.text, LIMITS.hintLength);
			const hints = parseHints(location.hints);
			if (!hint) fail(400, "This suggestion is empty. Deny it instead.");
			if (hints.includes(hint)) break;
			if (hints.length >= LIMITS.hintsPerLocation)
				fail(
					400,
					`This location already has ${LIMITS.hintsPerLocation} hints. Remove one first, or deny this suggestion.`
				);
			set("hints", JSON.stringify([...hints, hint]));
			break;
		}
		case "screenshot":
			if (!sug.image_path) fail(400, "This suggestion has no image. Deny it instead.");
			useImage();
			break;
		case "coordinates":
			useCoords(true);
			break;
		case "full_edit": {
			useImage();
			useCoords(false);
			const hints = cleanHints(content.hints);
			if (hints.length) set("hints", JSON.stringify(hints));
			const label = text(content.label, LIMITS.labelMax);
			if (label.length >= LIMITS.labelEditMin) set("label", label);
			break;
		}
		case "removal":
			set("is_active", 0);
			break;
		default:
			fail(400, "Unknown suggestion type");
	}
	return replacedImage;
}

adminSuggestionRoutes.get("/", (c) => {
	requireStaff(c);
	return c.json(
		db
			.query(
				`SELECT ls.*, u.username, u.display_name, u.avatar_url,
					l.label AS location_label, l.image_path AS location_image,
					l.world_x AS location_x, l.world_y AS location_y, l.hints AS location_hints
				FROM location_suggestions ls
				JOIN users u ON u.id = ls.user_id
				JOIN locations l ON l.id = ls.location_id
				WHERE ls.status = 'pending'
				ORDER BY ls.created_at ASC`
			)
			.all()
	);
});

adminSuggestionRoutes.post("/:id/approve", async (c) => {
	const staff = requireStaff(c);
	const sug = pendingSuggestion(idParam(c));
	const target = sug.location_label || `#${sug.location_id}`;

	const replacedImage = db.transaction(() => {
		const replaced = applySuggestion(sug);
		db.run(
			"UPDATE location_suggestions SET status = 'approved', reviewed_by = ?, reviewed_at = unixepoch() WHERE id = ?",
			[staff.id, sug.id]
		);
		return replaced;
	})();
	await deleteUpload(replacedImage);

	notify(
		"suggestions",
		`**${sug.type.replace("_", " ")} suggestion approved** on "${target}" by **${displayName(staff)}**`,
		"/admin#suggestions"
	);
	notifyUser(sug.user_id, "suggestions", {
		title: "Your suggestion was accepted",
		body: `Your ${sug.type.replace("_", " ")} suggestion for "${target}" has been applied.`,
		link: "/submit",
	});
	auditLog(staff, "suggestion_approve", {
		targetType: "suggestion",
		targetId: sug.id,
		details: `${sug.type} on ${target}`,
	});
	return c.json({ success: true });
});

adminSuggestionRoutes.post("/:id/deny", async (c) => {
	const staff = requireStaff(c);
	const sug = pendingSuggestion(idParam(c));
	// The player is shown this, so a denial always says why.
	const reason = requireReason((await readJson<{ reason: string }>(c)).reason, "A reason for denying");

	db.run(
		"UPDATE location_suggestions SET status = 'denied', reviewed_by = ?, reviewed_at = unixepoch(), deny_reason = ? WHERE id = ?",
		[staff.id, reason, sug.id]
	);
	await deleteUpload(sug.image_path);
	notifyUser(sug.user_id, "suggestions", {
		title: "Your suggestion was not accepted",
		body: `Your ${sug.type.replace("_", " ")} suggestion for "${sug.location_label || `#${sug.location_id}`}"${reason ? `: ${reason}` : " was declined."}`,
		link: "/submit",
	});
	auditLog(staff, "suggestion_deny", { targetType: "suggestion", targetId: sug.id, details: reason });
	return c.json({ success: true });
});
