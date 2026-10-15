import { el, errorStateHtml, escHtml, locId } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { refreshAttention } from "../lib/attention.js";
import {
	atLeast,
	bindPanelSearch,
	emptyQueueHtml,
	mountReviewMap,
	panelSearchInput,
	restorePanelSearch,
	reviewHeader,
	reviewViewChips,
	reviewedRowHtml,
	openDenyDialog,
	staffUserLink,
	userFilterSelect,
} from "./core.js";
import { shortAgo } from "./overview.js";

let _suggestions = [];
let _suggestionUser = "";
let _suggestionView = "waiting";
let _suggestionHistory = [];

const SUGGESTION_TYPES = {
	hint: ["New hint", "info"],
	screenshot: ["New screenshot", "info"],
	coordinates: ["Move the pin", "warn"],
	full_edit: ["Full edit", "warn"],
	removal: ["Remove location", "danger"],
};
const sugCode = (id) => `SUG-${String(id).padStart(4, "0")}`;

export async function loadSuggestions() {
	try {
		_suggestions = await api("/api/admin/suggestions");
		if (_suggestionView === "reviewed") return setSuggestionView("reviewed");
		renderSuggestions();
	} catch (err) {
		el("tab-content").innerHTML = errorStateHtml(
			err.message || "Couldn't load the suggestions.",
			"loadSuggestions()"
		);
	}
}

function suggestionContent(s) {
	try {
		return JSON.parse(s.content || "{}") || {};
	} catch {
		return {};
	}
}

function suggestedPin(s, content) {
	const moves = s.type === "coordinates" || s.type === "full_edit";
	return moves && Number.isFinite(content.world_x) && Number.isFinite(content.world_y)
		? { x: content.world_x, y: content.world_y }
		: null;
}

const beforeAfterHtml = (s) => `<div class="grid grid-cols-2 gap-2">
	<a href="/uploads/${escHtml(s.location_image)}" target="_blank" rel="noopener"><div class="m-label">Now</div><img loading="lazy" decoding="async" src="/uploads/${escHtml(s.location_image)}" alt="Current screenshot" class="w-full rounded-xl object-cover aspect-video bg-black" /></a>
	<a href="/uploads/${escHtml(s.image_path)}" target="_blank" rel="noopener"><div class="m-label">Suggested</div><img loading="lazy" decoding="async" src="/uploads/${escHtml(s.image_path)}" alt="Suggested screenshot" class="w-full rounded-xl object-cover aspect-video bg-black" /></a>
</div>`;

const changeRow = (name, html) =>
	`<div class="flex gap-3 py-1.5 border-b border-zinc-800 last:border-0 text-sm"><span class="w-16 flex-shrink-0 text-zinc-500">${name}</span><span class="flex-1 min-w-0 break-words">${html}</span></div>`;

function suggestionBodyHtml(s, content) {
	const quote = (text) => (text ? `<p class="text-sm text-zinc-400 italic">"${escHtml(text)}"</p>` : "");
	const pin = suggestedPin(s, content);
	const moved = pin ? Math.round(Math.hypot(pin.x - s.location_x, pin.y - s.location_y)) : 0;
	const pinRow = pin
		? changeRow(
				"Pin",
				`${Math.round(s.location_x)}, ${Math.round(s.location_y)} <span class="text-zinc-500">to</span> <span class="text-zinc-100">${Math.round(pin.x)}, ${Math.round(pin.y)}</span> <span class="text-zinc-500">(${moved.toLocaleString()} units)</span>
				<button onclick="showSuggestionMap(${s.id})" class="m-btn m-btn-text m-btn-sm ml-1">Show on map</button>`
			)
		: "";
	const mapSlot = pin
		? `<div id="sug-map-${s.id}" class="hidden relative h-64 rounded-xl overflow-hidden bg-zinc-800"></div>`
		: "";

	if (s.type === "hint")
		return changeRow("Hint", `<span class="text-zinc-100">${escHtml(content.text || "")}</span>`);
	if (s.type === "screenshot") return beforeAfterHtml(s) + quote(content.note);
	if (s.type === "removal")
		return `${changeRow("Reason", `<span class="text-zinc-100">${escHtml(content.reason || "None given")}</span>`)}
			<p class="text-xs text-zinc-500">Approving takes the location out of play. It can be put back from Locations.</p>`;
	if (s.type === "coordinates") return pinRow + mapSlot + quote(content.note);
	if (s.type === "full_edit") {
		const rows = [
			content.label
				? changeRow(
						"Label",
						`${escHtml(s.location_label || "(none)")} <span class="text-zinc-500">to</span> <span class="text-zinc-100">${escHtml(content.label)}</span>`
					)
				: "",
			pinRow,
			content.hints?.length
				? changeRow(
						"Hints",
						`Replaced with: <span class="text-zinc-100">${content.hints.map((hint) => escHtml(hint)).join(" · ")}</span>`
					)
				: "",
		].join("");
		return `${s.image_path ? beforeAfterHtml(s) : ""}${rows || '<p class="text-sm text-zinc-500">No readable changes.</p>'}${mapSlot}${quote(content.note)}`;
	}
	return "";
}

function setSuggestionUser(name) {
	_suggestionUser = name;
	renderSuggestions();
}

async function setSuggestionView(view) {
	_suggestionUser = "";
	if (view === "reviewed") {
		try {
			_suggestionHistory = await api("/api/admin/suggestions/history");
		} catch (err) {
			return showToast(err.message || "Couldn't load the reviewed list.", "error");
		}
	}
	_suggestionView = view;
	renderSuggestions();
}

function reviewedSuggestionHtml(s) {
	const [typeName, tone] = SUGGESTION_TYPES[s.type] || [s.type, ""];
	return reviewedRowHtml({
		code: sugCode(s.id),
		title: s.location_label || locId(s.location_id),
		userId: s.user_id,
		username: s.username,
		displayName: s.display_name,
		status: s.status,
		reviewer: s.reviewed_by_username,
		reviewedAt: s.reviewed_at,
		reason: s.deny_reason,
		tag: `<span class="m-tag ${tone}">${typeName}</span>`,
	});
}

function suggestionCardHtml(s) {
	const content = suggestionContent(s);
	const [typeName, tone] = SUGGESTION_TYPES[s.type] || [s.type, ""];
	const searchText = [
		s.id,
		sugCode(s.id),
		s.location_id,
		locId(s.location_id),
		s.location_label,
		s.display_name,
		s.username && `@${s.username}`,
		typeName,
		JSON.stringify(content),
	].join(" ");
	return `<div class="bg-zinc-900 rounded-2xl p-4 flex flex-col gap-3" id="sug-${s.id}" data-search="${escHtml(searchText)}">
		<div class="flex items-center gap-2 flex-wrap">
			<span class="m-tag ${tone}">${typeName}</span>
			${
				atLeast("curator")
					? `<button onclick="jumpToSearch('locations', '${locId(s.location_id)}')" class="text-sm font-semibold hover:underline truncate" title="Find this location">${escHtml(s.location_label || locId(s.location_id))}</button>`
					: `<span class="text-sm font-semibold truncate">${escHtml(s.location_label || locId(s.location_id))}</span>`
			}
			<span class="text-xs font-mono text-zinc-600">${locId(s.location_id)}</span>
			<span class="ml-auto text-xs text-zinc-500 flex-shrink-0">${staffUserLink(s.user_id, s.username)} · ${shortAgo(s.created_at)} ago · <span class="font-mono text-zinc-600">${sugCode(s.id)}</span></span>
		</div>
		${suggestionBodyHtml(s, content)}
		<div class="flex gap-2 justify-end">
			<button onclick="denySuggestion(${s.id})" class="m-btn m-btn-text danger">Deny</button>
			<button onclick="approveSuggestion(${s.id})" class="m-btn m-btn-filled"><span class="material-symbols-outlined">check</span>Approve</button>
		</div>
	</div>`;
}

function renderSuggestions() {
	const reviewed = _suggestionView === "reviewed";
	const list = reviewed ? _suggestionHistory : _suggestions;
	if (_suggestionUser && !list.some((s) => s.username === _suggestionUser)) _suggestionUser = "";
	const shown = list.filter((s) => !_suggestionUser || s.username === _suggestionUser);
	const search = el("suggestions-list") ? el("panel-search")?.value : "";
	el("tab-content").innerHTML = `
		${reviewHeader("Suggestions", _suggestions.length, "loadSuggestions()")}
		${panelSearchInput("Search suggestion ID, location, user, type or details...")}
		<div class="flex items-center gap-1.5 flex-wrap mb-3">
			${reviewViewChips(_suggestionView, "setSuggestionView", _suggestions.length)}
			<span class="ml-auto"></span>
			${userFilterSelect(list, (s) => s.username, _suggestionUser, "setSuggestionUser")}
		</div>
		<div class="flex flex-col ${reviewed ? "gap-2" : "gap-3"}" id="suggestions-list">
			${shown.map(reviewed ? reviewedSuggestionHtml : suggestionCardHtml).join("")}
			<div id="panel-search-empty" class="hidden text-zinc-500 text-center py-8">No suggestions match your search.</div>
		</div>
		${shown.length ? "" : reviewed ? '<p class="text-sm text-zinc-500 text-center py-8">Nothing has been reviewed yet.</p>' : emptyQueueHtml("No suggestions are waiting for review.")}`;
	bindPanelSearch("#suggestions-list [data-search]");
	restorePanelSearch(search);
}

function showSuggestionMap(id) {
	const s = _suggestions.find((item) => item.id === id);
	const pin = s && suggestedPin(s, suggestionContent(s));
	const slot = el(`sug-map-${id}`);
	if (!pin || !slot) return;
	for (const other of document.querySelectorAll('[id^="sug-map-"]')) other.classList.toggle("hidden", other !== slot);
	const map = mountReviewMap(slot);
	map.clearPin();
	map.setNamePin("now", s.location_x, s.location_y, "#a1a1aa", "Now");
	map.setNamePin("suggested", pin.x, pin.y, "#42A5F5", "Suggested");
	map.fitTo([{ x: s.location_x, y: s.location_y }, pin]);
}

function suggestionReviewed(id) {
	_suggestions = _suggestions.filter((s) => s.id !== id);
	renderSuggestions();
	refreshAttention();
}

async function approveSuggestion(id) {
	try {
		await api(`/api/admin/suggestions/${id}/approve`, { method: "POST" });
		showToast(`${sugCode(id)} approved.`, "success");
		suggestionReviewed(id);
	} catch (err) {
		showToast(err.message || "Couldn't approve it.", "error");
	}
}

function denySuggestion(id) {
	openDenyDialog(`Deny ${sugCode(id)}`, null, async (reason) => {
		try {
			await api(`/api/admin/suggestions/${id}/deny`, { json: { reason } });
			showToast(`${sugCode(id)} denied.`);
			suggestionReviewed(id);
		} catch (err) {
			showToast(err.message || "Couldn't deny it.", "error");
		}
	});
}

/** Called from inline handlers in the markup. */
Object.assign(window, {
	approveSuggestion,
	denySuggestion,
	loadSuggestions,
	setSuggestionUser,
	setSuggestionView,
	showSuggestionMap,
});
