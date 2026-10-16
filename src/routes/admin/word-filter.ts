import { Hono } from "hono";
import { requireStaff } from "../../auth/guards";
import {
	addList,
	addWords,
	checkMessage,
	listLists,
	listWords,
	refreshList,
	removeList,
	removeWord,
	updateList,
	CHAT_LIMITS,
} from "../../game/chat-filter";
import { idParam, readJson } from "../../lib/http";

/** Moderators keep our own list; supervisors manage web lists. */
export const adminWordFilterRoutes = new Hono();

const everything = () => ({ words: listWords(), lists: listLists(), limits: CHAT_LIMITS });

adminWordFilterRoutes.get("/", (c) => {
	requireStaff(c);
	return c.json(everything());
});

/** `words` separated by commas or new lines; `kind` block or allow; `match` word or contains; `action` refuse, mask or hold. */
adminWordFilterRoutes.post("/words", async (c) => {
	addWords(requireStaff(c), await readJson(c));
	return c.json(everything());
});

adminWordFilterRoutes.delete("/words/:id", (c) => {
	removeWord(requireStaff(c), idParam(c));
	return c.json(everything());
});

adminWordFilterRoutes.post("/lists", async (c) => {
	await addList(requireStaff(c, "supervisor"), await readJson(c));
	return c.json(everything());
});

adminWordFilterRoutes.patch("/lists/:id", async (c) => {
	updateList(requireStaff(c, "supervisor"), idParam(c), await readJson(c));
	return c.json(everything());
});

adminWordFilterRoutes.post("/lists/:id/refresh", async (c) => {
	requireStaff(c, "supervisor");
	await refreshList(idParam(c));
	return c.json(everything());
});

adminWordFilterRoutes.delete("/lists/:id", (c) => {
	removeList(requireStaff(c, "supervisor"), idParam(c));
	return c.json(everything());
});

/** What would catch a message. */
adminWordFilterRoutes.post("/test", async (c) => {
	requireStaff(c);
	const { text } = await readJson<{ text: unknown }>(c);
	const verdict = checkMessage(typeof text === "string" ? text : "");
	return c.json({
		ok: verdict.ok,
		reason: verdict.ok ? null : verdict.reason,
		body: verdict.ok ? verdict.body : null,
		held: verdict.ok && verdict.held,
		hits: verdict.hits.map((h) => ({ word: h.word, source: h.source, action: h.action })),
	});
});
