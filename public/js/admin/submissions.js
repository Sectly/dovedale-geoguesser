import { el, errorStateHtml, escHtml, locId } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { refreshAttention } from "../lib/attention.js";
import { addKeybinds } from "../lib/keys.js";
import {
	LABEL_MAX_LENGTH,
	LABEL_MIN_LENGTH,
	bindPanelSearch,
	claimChanged,
	currentTab,
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
import { formatWhen } from "./users.js";

let _submissions = [];
export let _openSubmission = null;
let _submissionUser = "";
export let _submissionView = "waiting";
let _submissionHistory = [];

/** Closer than this and the row is marked as a possible duplicate before it is even opened. */
const DUPLICATE_UNITS = 150;

const subCode = (id) => `SUB-${String(id).padStart(4, "0")}`;

export async function loadSubmissions() {
	try {
		_submissions = await api("/api/admin/submissions");
		/** Open on the oldest, so the queue can be worked from the keyboard straight away. */
		_openSubmission = _submissions[0]?.id ?? null;
		if (_submissionView === "reviewed") return setSubmissionView("reviewed");
		renderSubmissions();
	} catch (err) {
		el("tab-content").innerHTML = errorStateHtml(
			err.message || "Couldn't load the submissions.",
			"loadSubmissions()"
		);
	}
}

const shownSubmissions = () => _submissions.filter((s) => !_submissionUser || s.username === _submissionUser);

function setSubmissionUser(name) {
	_submissionUser = name;
	_openSubmission = shownSubmissions()[0]?.id ?? null;
	renderSubmissions();
}

async function setSubmissionView(view) {
	_submissionUser = "";
	if (view === "reviewed") {
		try {
			_submissionHistory = await api("/api/admin/submissions/history");
		} catch (err) {
			return showToast(err.message || "Couldn't load the reviewed list.", "error");
		}
	}
	_submissionView = view;
	renderSubmissions();
}

const reviewedSubmissionHtml = (s) =>
	reviewedRowHtml({
		code: subCode(s.id),
		title: s.label,
		image: s.image_path,
		userId: s.submitted_by,
		username: s.username,
		displayName: s.display_name,
		status: s.status,
		reviewer: s.reviewed_by_username,
		reviewedAt: s.reviewed_at,
		reason: s.deny_reason,
	});

function renderSubmissions() {
	const reviewed = _submissionView === "reviewed";
	const list = reviewed ? _submissionHistory : _submissions;
	if (_submissionUser && !list.some((s) => s.username === _submissionUser)) _submissionUser = "";
	const shown = list.filter((s) => !_submissionUser || s.username === _submissionUser);
	const search = el("submissions-list") ? el("panel-search")?.value : "";
	el("tab-content").innerHTML = `
		${reviewHeader("Submissions", _submissions.length, "loadSubmissions()")}
		${panelSearchInput("Search submission ID, label, username or coordinates...")}
		<div class="flex items-center gap-1.5 flex-wrap mb-3">
			${reviewViewChips(_submissionView, "setSubmissionView", _submissions.length)}
			<span class="ml-auto"></span>
			${userFilterSelect(list, (s) => s.username, _submissionUser, "setSubmissionUser")}
		</div>
		<div class="flex flex-col gap-2" id="submissions-list">
			${shown.map(reviewed ? reviewedSubmissionHtml : submissionRowHtml).join("")}
			<div id="panel-search-empty" class="hidden text-zinc-500 text-center py-8">No submissions match your search.</div>
		</div>
		${shown.length ? "" : reviewed ? '<p class="text-sm text-zinc-500 text-center py-8">Nothing has been reviewed yet.</p>' : emptyQueueHtml("No submissions are waiting for review.")}
		${reviewed || !shown.length ? "" : '<p class="hidden sm:block text-xs text-zinc-600 mt-4"><kbd class="kbd">J</kbd> <kbd class="kbd">K</kbd> next and previous · <kbd class="kbd">A</kbd> approve · <kbd class="kbd">D</kbd> deny</p>'}`;
	bindPanelSearch("#submissions-list [data-search]");
	restorePanelSearch(search);
	if (!reviewed) mountSubmissionMap();
	claimChanged();
}

const nearbyLocations = (s) => (s.nearby ?? []).map((loc) => ({ loc, distance: loc.distance }));

function nearbyHtml(near) {
	if (!near.length) return "";
	return `<div>
		<div class="m-label">Already in the game close by <span class="text-zinc-600">Check this is not a duplicate (U4).</span></div>
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
			${near
				.map(
					({
						loc,
						distance,
					}) => `<a href="/uploads/${escHtml(loc.image_path)}" target="_blank" rel="noopener" class="block bg-zinc-800/60 hover:bg-zinc-800 transition rounded-xl overflow-hidden" title="Open full size">
						<img loading="lazy" decoding="async" src="/uploads/${escHtml(loc.image_path)}" alt="" class="w-full h-20 object-cover" />
						<span class="block px-2 py-1.5 text-xs">
							<span class="block truncate text-zinc-200">${escHtml(loc.label || locId(loc.id))}</span>
							<span class="text-zinc-500">${locId(loc.id)} · ${Math.round(distance).toLocaleString()} units away${loc.is_active ? "" : " · out of play"}</span>
						</span>
					</a>`
				)
				.join("")}
		</div>
	</div>`;
}

function submissionHints(s) {
	try {
		const hints = JSON.parse(s.hints || "[]");
		return Array.isArray(hints) ? hints.filter((hint) => typeof hint === "string" && hint.trim()) : [];
	} catch {
		return [];
	}
}

function submissionRowHtml(s) {
	const open = _openSubmission === s.id;
	const hints = submissionHints(s);
	const near = nearbyLocations(s);
	const searchText = [
		s.id,
		subCode(s.id),
		s.label,
		s.username && `@${s.username}`,
		s.display_name,
		s.world_x,
		s.world_y,
		s.image_path,
	].join(" ");
	return `<div class="bg-zinc-900 rounded-2xl overflow-hidden ${open ? "ring-1 ring-zinc-700" : ""}" id="sub-${s.id}" data-search="${escHtml(searchText)}">
		<button data-on-click="toggleSubmission(${s.id})" aria-expanded="${open}" class="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/50 transition">
			<img loading="lazy" decoding="async" src="/uploads/${escHtml(s.image_path)}" alt="" class="w-16 h-10 rounded-lg object-cover flex-shrink-0" />
			<span class="flex-1 min-w-0">
				<span class="block text-sm font-semibold truncate">${s.label ? escHtml(s.label) : '<span class="text-zinc-500 font-normal">No label</span>'}</span>
				<span class="block text-xs text-zinc-500 mt-0.5 truncate">@${escHtml(s.username || "unknown")} · ${shortAgo(s.created_at)} ago${hints.length ? ` · ${hints.length} hint${hints.length === 1 ? "" : "s"}` : ""}</span>
			</span>
			${near[0]?.distance <= DUPLICATE_UNITS ? '<span class="m-tag warn flex-shrink-0">Possible duplicate</span>' : ""}
			<span data-claim="submission:${s.id}" class="flex-shrink-0 empty:hidden"></span>
			<span class="text-xs font-mono text-zinc-600 flex-shrink-0">${subCode(s.id)}</span>
			<span class="material-symbols-outlined text-zinc-500 text-base flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}">expand_more</span>
		</button>
		${
			open
				? `<div class="border-t border-zinc-800 p-4 flex flex-col gap-4">
					<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
						<a href="/uploads/${escHtml(s.image_path)}" target="_blank" rel="noopener" title="Open full size">
							<img decoding="async" src="/uploads/${escHtml(s.image_path)}" alt="Submitted screenshot" class="w-full rounded-xl object-contain bg-black max-h-[26rem]" />
						</a>
						<div class="flex flex-col gap-2 min-h-[16rem]">
							<div id="review-map-slot" class="relative flex-1 min-h-[14rem] rounded-xl overflow-hidden bg-zinc-800"></div>
							<div class="text-xs text-zinc-500 flex flex-wrap gap-x-4 gap-y-1">
								<span>Pin <span class="text-zinc-300 font-mono">${Math.round(s.world_x)}, ${Math.round(s.world_y)}</span></span>
								<span>Sent <span class="text-zinc-300">${formatWhen(s.created_at)}</span></span>
								<span>By ${staffUserLink(s.submitted_by, s.username)}</span>
							</div>
						</div>
					</div>
					${
						hints.length
							? `<div><div class="m-label">Hints</div><ol class="text-sm text-zinc-300 list-decimal pl-5 flex flex-col gap-0.5">${hints.map((hint) => `<li>${escHtml(hint)}</li>`).join("")}</ol></div>`
							: ""
					}
					${nearbyHtml(near)}
					<div>
						<label class="m-label" for="sub-label-${s.id}">Label <span class="text-zinc-600">${LABEL_MIN_LENGTH} to ${LABEL_MAX_LENGTH} characters. You can tidy it before approving.</span></label>
						<input id="sub-label-${s.id}" type="text" value="${escHtml(s.label || "")}" placeholder="e.g. Near Dovedale Central" maxlength="${LABEL_MAX_LENGTH}" class="m-field" />
					</div>
					<div class="flex gap-2 justify-end">
						<button data-on-click="openDenyModal(${s.id})" class="m-btn m-btn-text danger">Deny</button>
						<button data-on-click="approveSubmission(${s.id})" class="m-btn m-btn-filled"><span class="material-symbols-outlined">check</span>Approve</button>
					</div>
				</div>`
				: ""
		}
	</div>`;
}

function mountSubmissionMap() {
	const s = _submissions.find((item) => item.id === _openSubmission);
	const slot = el("review-map-slot");
	if (!s || !slot) return;
	const map = mountReviewMap(slot);
	map.clearPin();
	map.setPin(s.world_x, s.world_y);
	const near = nearbyLocations(s);
	for (const { loc } of near) map.setNamePin(`near-${loc.id}`, loc.world_x, loc.world_y, "#a1a1aa", locId(loc.id));
	map.fitTo([{ x: s.world_x, y: s.world_y }, ...near.map(({ loc }) => ({ x: loc.world_x, y: loc.world_y }))]);
}

export function toggleSubmission(id) {
	_openSubmission = _openSubmission === id ? null : id;
	renderSubmissions();
	el(`sub-${id}`)?.scrollIntoView({ block: "nearest" });
}

function stepSubmission(step) {
	const shown = shownSubmissions();
	if (!shown.length) return;
	const at = shown.findIndex((s) => s.id === _openSubmission);
	const next = shown[Math.min(shown.length - 1, Math.max(0, at + step))];
	if (next && next.id !== _openSubmission) toggleSubmission(next.id);
}

function submissionReviewed(id) {
	const at = shownSubmissions().findIndex((s) => s.id === id);
	_submissions = _submissions.filter((s) => s.id !== id);
	const shown = shownSubmissions();
	_openSubmission = (shown[at] ?? shown[at - 1])?.id ?? null;
	renderSubmissions();
	refreshAttention();
}

async function approveSubmission(id) {
	const input = el(`sub-label-${id}`);
	const label = (input?.value ?? "").trim();
	if (label.length < LABEL_MIN_LENGTH || label.length > LABEL_MAX_LENGTH) {
		showToast(`The label must be ${LABEL_MIN_LENGTH} to ${LABEL_MAX_LENGTH} characters.`, "error");
		return input?.focus();
	}
	try {
		await api(`/api/admin/submissions/${id}/approve`, { json: { label } });
		showToast(`${subCode(id)} approved.`, "success");
		submissionReviewed(id);
	} catch (err) {
		showToast(err.message || "Couldn't approve it.", "error");
	}
}

function openDenyModal(id) {
	openDenyDialog(`Deny ${subCode(id)}`, id);
}

export async function denySubmission(id, reason) {
	try {
		await api(`/api/admin/submissions/${id}/deny`, { json: { reason } });
		showToast(`${subCode(id)} denied.`);
		submissionReviewed(id);
	} catch (err) {
		showToast(err.message || "Couldn't deny it.", "error");
	}
}

const reviewingSubmissions = () =>
	currentTab === "submissions" &&
	_submissionView === "waiting" &&
	!document.querySelector(".modal-fade:not(.hidden)");
addKeybinds("Reviewing submissions", [
	[["J"], "Next submission", () => (reviewingSubmissions() ? stepSubmission(1) : false)],
	[["K"], "Previous submission", () => (reviewingSubmissions() ? stepSubmission(-1) : false)],
	[
		["A"],
		"Approve the open one",
		() => (reviewingSubmissions() && _openSubmission ? approveSubmission(_openSubmission) : false),
	],
	[
		["D"],
		"Deny the open one",
		() => (reviewingSubmissions() && _openSubmission ? openDenyModal(_openSubmission) : false),
	],
]);

Object.assign(window, {
	approveSubmission,
	loadSubmissions,
	openDenyModal,
	setSubmissionUser,
	setSubmissionView,
	toggleSubmission,
});
