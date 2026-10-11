import { Hono } from "hono";
import { db, type Location } from "../../db";
import { LIMITS } from "../../config";
import { requireStaff } from "../../auth/guards";
import { cleanHints } from "../../game/locations";
import { auditLog } from "../../lib/audit";
import { fail, idParam, readJson, text } from "../../lib/http";
import { deleteUpload } from "../../lib/uploads";

export const adminLocationRoutes = new Hono();

function getLocation(id: number): Location {
	return (
		db.query<Location, [number]>("SELECT * FROM locations WHERE id = ?").get(id) ?? fail(404, "Location not found")
	);
}

/** Deletes a location together with the history rows that reference it, then its screenshot. */
export async function deleteLocation(id: number) {
	const location = getLocation(id);
	db.transaction(() => {
		db.run("DELETE FROM daily_challenges WHERE location_id = ?", [id]);
		db.run("DELETE FROM duel_round_scores WHERE location_id = ?", [id]);
		db.run("DELETE FROM locations WHERE id = ?", [id]);
	})();
	await deleteUpload(location.image_path);
	return location;
}

adminLocationRoutes.get("/", (c) => {
	requireStaff(c);
	return c.json(
		db
			.query(
				`SELECT l.*, u.username AS submitted_by_username, u.display_name AS submitted_by_display_name,
					a.username AS approved_by_username, a.display_name AS approved_by_display_name
				FROM locations l
				LEFT JOIN users u ON u.id = l.submitted_by
				LEFT JOIN users a ON a.id = l.approved_by
				ORDER BY l.created_at DESC`
			)
			.all()
	);
});

adminLocationRoutes.post("/:id/toggle", (c) => {
	const staff = requireStaff(c);
	const location = getLocation(idParam(c));
	db.run("UPDATE locations SET is_active = ? WHERE id = ?", [location.is_active ? 0 : 1, location.id]);
	auditLog(staff, location.is_active ? "location_deactivate" : "location_activate", {
		targetType: "location",
		targetId: location.id,
		details: location.label,
	});
	return c.json({ success: true, is_active: !location.is_active });
});

adminLocationRoutes.post("/:id/label", async (c) => {
	const staff = requireStaff(c);
	const location = getLocation(idParam(c));
	const label = text((await readJson<{ label: string }>(c)).label, LIMITS.labelMax + 1);
	if (label.length < LIMITS.labelEditMin || label.length > LIMITS.labelMax)
		fail(400, `Label must be ${LIMITS.labelEditMin}-${LIMITS.labelMax} characters`);
	db.run("UPDATE locations SET label = ? WHERE id = ?", [label, location.id]);
	auditLog(staff, "location_label_edit", {
		targetType: "location",
		targetId: location.id,
		details: `"${location.label ?? ""}" to "${label}"`.slice(0, 300),
	});
	return c.json({ success: true });
});

adminLocationRoutes.post("/:id/hints", async (c) => {
	const staff = requireStaff(c);
	const location = getLocation(idParam(c));
	const hints = cleanHints((await readJson<{ hints: string[] }>(c)).hints);
	db.run("UPDATE locations SET hints = ? WHERE id = ?", [JSON.stringify(hints), location.id]);
	auditLog(staff, "location_hints_edit", {
		targetType: "location",
		targetId: location.id,
		details:
			`${location.label ?? `#${location.id}`}: now ${hints.length} hint${hints.length === 1 ? "" : "s"}${hints.length ? ` (${hints.join(" / ")})` : ""}`.slice(
				0,
				300
			),
	});
	return c.json({ success: true });
});

adminLocationRoutes.delete("/:id", async (c) => {
	const staff = requireStaff(c, "operator");
	const location = await deleteLocation(idParam(c));
	auditLog(staff, "location_delete", { targetType: "location", targetId: location.id, details: location.label });
	return c.json({ success: true });
});
