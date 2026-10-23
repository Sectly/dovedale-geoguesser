import { EXTERNAL_ICON, el, errorStateHtml, escHtml, isExternalLink, scrollBehavior, show } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { checkAnnouncement } from "../lib/announcements.js";
import { showConfirm } from "./core.js";
import { formatWhen } from "./users.js";

const BANNER_LABELS = { 0: "No banner", 1: "1 hour", 6: "6 hours", 24: "1 day", 72: "3 days", 168: "1 week" };

const ANNOUNCEMENT_PRESETS = {
	privacy: [
		"Privacy Policy",
		"Privacy Policy updated",
		"We have updated our Privacy Policy. Please read what changed.",
		"/privacy",
	],
	tos: [
		"Terms of Service",
		"Terms of Service updated",
		"We have updated our Terms of Service. Please read what changed.",
		"/tos",
	],
	fairplay: [
		"Fair Play",
		"Fair Play Policy updated",
		"We have updated our Fair Play Policy. Please read what changed.",
		"/fairplay",
	],
	guidelines: [
		"Upload Guidelines",
		"Upload Guidelines updated",
		"We have updated our Upload Guidelines. Please read them before your next submission.",
		"/guidelines",
	],
	several: [
		"Several documents",
		"Our policies have been updated",
		"We have updated our Terms of Service, Privacy Policy, Fair Play Policy and Upload Guidelines. Please read what changed.",
		"/tos",
	],
	maintenance: [
		"Planned downtime",
		"Planned maintenance",
		"The site will be down for maintenance on [day and time, UK time] for about [how long]. Games still open then will be closed.",
		"",
	],
	update: ["New update", "New update", "[What is new, in a sentence or two.]", ""],
	special: [
		"Special event",
		"[Event name] is live",
		"A new special is open until [date]. Find it on the Specials page.",
		"/specials",
	],
	scores: [
		"Scores changed",
		"Leaderboard corrected",
		"Some scores were [removed or reset] because [reason].",
		"/leaderboard",
	],
	issue: ["Known issue", "Known issue: [what]", "We know about a problem with [what] and are working on it.", ""],
	fixed: [
		"Issue fixed",
		"Fixed: [what]",
		"The problem with [what] is fixed. Reload the page if anything still looks off.",
		"",
	],
};
const DOCUMENT_PRESETS = ["privacy", "tos", "fairplay", "guidelines", "several"];
/** Presets mark staff-only parts in [brackets]; nothing sends while one is left. */
const UNFILLED = /\[[^\]]+\]/;

const presetChip = (key) =>
	`<button data-on-click="useAnnouncementPreset('${key}')" class="m-chip">${ANNOUNCEMENT_PRESETS[key][0]}</button>`;

function useAnnouncementPreset(key) {
	const [, title, body, link] = ANNOUNCEMENT_PRESETS[key];
	el("announce-title").value = title;
	el("announce-body").value = body;
	el("announce-link").value = link;
	updateAnnouncementPreview();
}

const AUDIENCE_LABELS = {
	everyone: "Everyone",
	active: "Active players (played in 30 days)",
	new: "New players (joined in 7 days)",
	inactive: "Away players (not played in 30 days)",
	contributors: "Contributors (have a location in the game)",
	helpers: "Helpers only",
	staff: "Staff only (curators and up)",
	player: "One player",
};
/** Audiences that are not all players: no banner or news page entry. */
const PRIVATE_AUDIENCES = ["helpers", "staff", "player"];
const STYLE_LOOK = {
	info: ["Info", "campaign"],
	success: ["Good news", "celebration"],
	warning: ["Warning", "warning"],
};
const EXPIRE_LABELS = {
	0: "Stays in inboxes",
	1: "Leaves after 1 day",
	3: "Leaves after 3 days",
	7: "Leaves after a week",
	30: "Leaves after 30 days",
};
const REPEAT_LABELS = { "": "Once", weekly: "Every week", monthly: "Every month" };
/** UK hours between which a push notification would wake people up. */
const QUIET_HOURS = [22, 7];

let _announcements = null;
let _changelog = [];
let _announceLimit = 20;
let _announceSearch = "";
let _fromDraft = null;
let _editingEntry = null;

export function loadAnnouncementsTab() {
	el("tab-content").innerHTML = '<div id="announcements-panel"></div>';
	loadAnnouncements();
}

async function loadAnnouncements() {
	try {
		[_announcements, _changelog] = await Promise.all([
			api(`/api/admin/announcements?limit=${_announceLimit}`),
			api("/api/admin/announcements/changelog"),
		]);
	} catch (err) {
		const box = el("announcements-panel");
		if (box)
			box.innerHTML = errorStateHtml(err.message || "Couldn't load the announcements.", "loadAnnouncements()");
		return;
	}
	renderAnnouncements();
}

const ukHour = (date) =>
	Number(
		new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Europe/London" }).format(date)
	);
const isQuietHour = (date) => {
	const hour = ukHour(date);
	return hour >= QUIET_HOURS[0] || hour < QUIET_HOURS[1];
};

function announcementReachHtml(a) {
	if (a.draft) return "Draft, not sent";
	if (a.send_at && !a.recalled_at)
		return `<span class="text-amber-300">Goes out ${formatWhen(a.send_at)}${a.repeat ? `, then ${REPEAT_LABELS[a.repeat].toLowerCase()}` : ""}</span>`;
	if (a.recalled_at) return a.send_at ? "Called off" : "Taken back";
	const clicks = a.link ? ` · link opened ${a.clicks.toLocaleString()} time${a.clicks === 1 ? "" : "s"}` : "";
	if (a.silent) return `Banner only${clicks}`;
	const who =
		a.audience === "player"
			? `@${escHtml(a.target_username || "player")}`
			: `${a.sent_to.toLocaleString()} account${a.sent_to === 1 ? "" : "s"}`;
	if (!a.in_inboxes) return `${who} · no longer in any inbox${clicks}`;
	const share = Math.round((a.read / a.in_inboxes) * 100);
	return `${who} · read by ${a.read.toLocaleString()} of ${a.in_inboxes.toLocaleString()} (${share}%)${clicks}
		<span class="block h-1 rounded-full bg-zinc-800 overflow-hidden mt-1"><span class="block h-full bg-blue-500" style="width:${share}%"></span></span>`;
}

function announcementRowHtml(a) {
	const sent = !a.draft && !a.send_at && !a.recalled_at;
	const tags = [
		a.draft ? '<span class="m-tag">Draft</span>' : "",
		a.banner_live ? '<span class="m-tag info">Banner showing</span>' : "",
		a.send_at && !a.recalled_at && !a.draft ? '<span class="m-tag warn">Scheduled</span>' : "",
		a.recalled_at ? `<span class="m-tag danger">${a.send_at ? "Called off" : "Taken back"}</span>` : "",
		a.must_ack ? '<span class="m-tag">Must be acknowledged</span>' : "",
		a.no_push ? '<span class="m-tag">No push</span>' : "",
		a.expires_at
			? `<span class="m-tag">${a.expires_at * 1000 < Date.now() ? "Expired" : `Leaves ${formatWhen(a.expires_at)}`}</span>`
			: "",
	].join(" ");
	const button = (handler, label, tone = "") =>
		`<button data-on-click="${handler}" class="m-btn m-btn-text m-btn-sm ${tone}">${label}</button>`;
	const publicOne = !PRIVATE_AUDIENCES.includes(a.audience);
	const actions = [
		a.draft
			? button(`reuseAnnouncement(${a.id}, true)`, "Open draft")
			: button(`reuseAnnouncement(${a.id})`, "Use again"),
		sent && publicOne
			? `<select data-on-change="setAnnouncementBanner(${a.id}, this.value)" class="m-field text-xs" style="width:auto;padding-block:0.25rem" aria-label="Banner">
				<option value="">${a.banner_live ? "Change banner" : "Put up a banner"}</option>
				${_announcements.banner_hours
					.filter((h) => h > 0)
					.map((h) => `<option value="${h}">For ${BANNER_LABELS[h].toLowerCase()} from now</option>`)
					.join("")}
				${a.banner_live ? '<option value="0">Take it down</option>' : ""}
			</select>`
			: "",
		sent && (a.audience === "staff" || a.audience === "helpers") && a.in_inboxes > a.read
			? button(`showUnreadStaff(${a.id})`, "Who has not read it")
			: "",
		a.can_recall
			? button(`correctAnnouncement(${a.id})`, "Fix wording") +
				button(`recallAnnouncement(${a.id}, ${!!a.send_at})`, a.send_at ? "Call off" : "Take back", "danger")
			: "",
		a.can_delete ? button(`deleteAnnouncement(${a.id})`, "Remove", "danger") : "",
	].join("");
	const search = [a.title, a.body, a.created_by, a.audience, a.target_username].join(" ");
	return `<div class="py-2.5 flex flex-col gap-1" data-search="${escHtml(search)}">
		<div class="text-sm font-semibold break-words ${a.recalled_at ? "text-zinc-500" : ""}">${escHtml(a.title)} ${tags}</div>
		<div class="text-xs text-zinc-400 break-words">${escHtml(a.body)}</div>
		<div class="text-[11px] text-zinc-600 break-words">${a.send_at || a.draft ? "Written" : "Sent"} ${formatWhen(a.created_at)} · by ${escHtml(a.created_by || "staff")} · ${escHtml(AUDIENCE_LABELS[a.audience] || a.audience)}${a.link ? ` · links to ${escHtml(a.link)}${isExternalLink(a.link) ? EXTERNAL_ICON : ""}` : ""}</div>
		<div class="text-[11px] text-zinc-500">${announcementReachHtml(a)}</div>
		<div id="announce-unread-${a.id}" class="text-[11px] text-zinc-400 empty:hidden"></div>
		<div class="flex flex-wrap items-center gap-1 -ml-3">${actions}</div>
	</div>`;
}

function changelogRowHtml(entry) {
	return `<div class="py-2.5">
		<div class="flex items-baseline gap-2">
			<span class="text-sm font-semibold flex-1 min-w-0 break-words">${escHtml(entry.title)}</span>
			<span class="text-[11px] text-zinc-600 flex-shrink-0">${new Date(entry.released_at * 1000).toLocaleDateString(undefined, { dateStyle: "medium" })}</span>
		</div>
		<ul class="text-xs text-zinc-400 list-disc pl-4 mt-1">${entry.body
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => `<li>${escHtml(line.replace(/^[-*]\s*/, ""))}</li>`)
			.join("")}</ul>
		<div class="flex gap-1 -ml-3 mt-1">
			<button data-on-click="editChangelogEntry(${entry.id})" class="m-btn m-btn-text m-btn-sm">Edit</button>
			<button data-on-click="deleteChangelogEntry(${entry.id})" class="m-btn m-btn-text m-btn-sm danger">Remove</button>
		</div>
	</div>`;
}

function renderAnnouncements() {
	const box = el("announcements-panel");
	if (!box || !_announcements) return;
	const draft = announcementDraft();
	const sizes = _announcements.audiences;
	const field =
		"bg-zinc-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600";
	const options = (list, current, label) =>
		list
			.map(
				(value) =>
					`<option value="${value}" ${String(current) === String(value) ? "selected" : ""}>${label(value)}</option>`
			)
			.join("");
	const check = (id, on, label, hint) =>
		`<label class="flex items-start gap-2 text-sm cursor-pointer" title="${escHtml(hint)}"><input id="${id}" type="checkbox" class="accent-blue-500 mt-0.5" ${on ? "checked" : ""} /><span>${label}<span class="block text-xs text-zinc-500">${hint}</span></span></label>`;
	const today = new Date().toISOString().slice(0, 10);

	box.innerHTML = `<div class="flex items-center gap-2 mb-1 flex-wrap">
			<h2 class="font-bold text-lg flex-1">Announcements</h2>
			<a href="/news" target="_blank" rel="noopener" class="m-btn m-btn-text m-btn-sm"><span class="material-symbols-outlined">open_in_new</span>News page</a>
		</div>
		<p class="text-zinc-500 text-xs mb-4">A notification to many accounts at once, or to one player. It is sent whatever their notification settings are, so use it sparingly.</p>
		<div class="grid md:grid-cols-2 gap-4 items-start">
			<div class="bg-zinc-900 rounded-2xl p-4 flex flex-col gap-2">
				<div class="m-label">Start from a preset</div>
				<div class="flex flex-wrap gap-1.5">
					${Object.keys(ANNOUNCEMENT_PRESETS)
						.filter((key) => !DOCUMENT_PRESETS.includes(key))
						.map(presetChip)
						.join("")}
				</div>
				<div class="flex flex-wrap gap-1.5 mb-2">${DOCUMENT_PRESETS.map(presetChip).join("")}</div>
				<label class="m-label" for="announce-title">Title <span id="announce-title-count" class="text-zinc-600 font-normal"></span></label>
				<input id="announce-title" maxlength="120" placeholder="What is it about?" class="${field}" value="${escHtml(draft.title)}" />
				<label class="m-label mt-1" for="announce-body">Message <span id="announce-body-count" class="text-zinc-600 font-normal"></span></label>
				<textarea id="announce-body" rows="4" maxlength="400" placeholder="What do players need to know?" class="${field} resize-none">${escHtml(draft.body)}</textarea>
				<div class="flex items-center gap-2 flex-wrap">
					<input id="announce-date" type="datetime-local" class="m-field text-xs" style="width:auto;padding-block:0.3rem" aria-label="A date and time to put in the message" />
					<button data-on-click="insertAnnouncementDate()" class="m-btn m-btn-text m-btn-sm" title="Adds the date to the message, written out in UK time">Put this date in the message</button>
				</div>
				<label class="m-label mt-1" for="announce-link">Link <span class="text-zinc-600 font-normal">(optional, a page on this site or an https:// address)</span></label>
				<input id="announce-link" maxlength="200" placeholder="/daily" class="${field}" value="${escHtml(draft.link)}" />
				<div class="grid grid-cols-2 gap-2 mt-1">
					<div>
						<label class="m-label" for="announce-audience">Send to</label>
						<select id="announce-audience" class="m-field">${options(Object.keys(AUDIENCE_LABELS), draft.audience, (key) => `${AUDIENCE_LABELS[key]}${key in sizes ? ` (${sizes[key].toLocaleString()})` : ""}`)}</select>
						<input id="announce-username" maxlength="40" placeholder="Username" class="${field} w-full mt-2 ${draft.audience === "player" ? "" : "hidden"}" value="${escHtml(draft.username)}" aria-label="Username" />
					</div>
					<div>
						<label class="m-label" for="announce-expire">In the inbox</label>
						<select id="announce-expire" class="m-field">${options(_announcements.expire_days, draft.expire_days, (days) => EXPIRE_LABELS[days])}</select>
					</div>
					<div>
						<label class="m-label" for="announce-banner">Banner on every page</label>
						<select id="announce-banner" class="m-field">${options(_announcements.banner_hours, draft.banner_hours, (h) => BANNER_LABELS[h] || `${h} hours`)}</select>
					</div>
					<div>
						<label class="m-label" for="announce-style">Banner style</label>
						<select id="announce-style" class="m-field">${options(_announcements.banner_styles, draft.style, (style) => STYLE_LOOK[style][0])}</select>
					</div>
					<div>
						<label class="m-label" for="announce-when">Send later <span class="text-zinc-600 font-normal">(your time)</span></label>
						<input id="announce-when" type="datetime-local" class="m-field" value="${escHtml(draft.when)}" />
					</div>
					<div>
						<label class="m-label" for="announce-repeat">Repeat</label>
						<select id="announce-repeat" class="m-field">${options(Object.keys(REPEAT_LABELS), draft.repeat, (key) => REPEAT_LABELS[key])}</select>
					</div>
				</div>
				<div class="flex flex-col gap-2 mt-1">
					${check("announce-silent", draft.silent, "Banner only", "Nothing goes to any inbox")}
					${check("announce-nopush", draft.no_push, "No push notification", "It waits in the inbox without buzzing phones or desktops")}
					${check("announce-ack", draft.must_ack, "Must be acknowledged", "Shown as a dialog on the player's next visit until they press OK. For changes to the terms")}
				</div>
				<p id="announce-hint" class="text-xs text-zinc-500 min-h-[1rem]"></p>
				<p id="announce-quiet" class="hidden text-xs text-amber-300"></p>
				<div class="flex justify-end gap-2 flex-wrap">
					<button id="announce-draft" data-on-click="sendAnnouncement(false, true)" class="m-btn m-btn-text mr-auto" title="Keeps it here for you or another administrator to finish">Save as draft</button>
					<button id="announce-test" data-on-click="sendAnnouncement(true)" class="m-btn m-btn-text" title="Sends it to you alone, so you can see it in your inbox first">Send me a test</button>
					<button id="announce-send" data-on-click="sendAnnouncement(false)" class="m-btn m-btn-filled"><span class="material-symbols-outlined">campaign</span><span id="announce-send-label">Send</span></button>
				</div>
			</div>
			<div>
				<div class="m-label">How it will look</div>
				<div id="announce-preview"></div>
				<div class="flex items-center gap-2 mt-4 mb-1.5">
					<div class="m-label !mb-0 flex-1">Drafts, scheduled and sent</div>
					<input id="announce-search" type="search" placeholder="Search" class="m-field text-xs" style="width:9rem;padding-block:0.3rem" value="${escHtml(_announceSearch)}" />
				</div>
				<div id="announce-history" class="bg-zinc-900 rounded-2xl px-4 divide-y divide-zinc-800 max-h-[36rem] overflow-y-auto">
					${_announcements.history.map(announcementRowHtml).join("") || '<p class="text-zinc-500 text-sm py-3">Nothing has been sent yet.</p>'}
				</div>
				${_announcements.history.length >= _announceLimit ? '<button data-on-click="moreAnnouncements()" class="m-btn m-btn-text m-btn-sm mt-1">Show older</button>' : ""}
				<p class="text-[11px] text-zinc-600 mt-1">One that went out can be removed from this list once it is ${_announcements.keep_days} days old and has no banner showing.</p>
			</div>
		</div>

		<h3 class="font-bold mt-8 mb-1">Changelog</h3>
		<p class="text-zinc-500 text-xs mb-3">What changed in each update. Shown on the <a href="/news" target="_blank" rel="noopener" class="underline">news page</a> together with announcements made to all players. Nobody is notified.</p>
		<div class="grid md:grid-cols-2 gap-4 items-start">
			<div class="bg-zinc-900 rounded-2xl p-4 flex flex-col gap-2">
				<label class="m-label" for="changelog-title">${_editingEntry ? "Editing an entry" : "New entry"}</label>
				<input id="changelog-title" maxlength="120" placeholder="e.g. October update" class="${field}" />
				<label class="m-label mt-1" for="changelog-body">What changed <span class="text-zinc-600 font-normal">(one change per line)</span></label>
				<textarea id="changelog-body" rows="6" maxlength="4000" placeholder="New special: Flash&#10;Report a location from the result screen" class="${field}"></textarea>
				<label class="m-label mt-1" for="changelog-date">Date</label>
				<input id="changelog-date" type="date" class="m-field" value="${today}" />
				<div class="flex justify-end gap-2">
					${_editingEntry ? '<button data-on-click="cancelChangelogEdit()" class="m-btn m-btn-text">Cancel</button>' : ""}
					<button data-on-click="saveChangelogEntry()" class="m-btn m-btn-filled">${_editingEntry ? "Save changes" : "Add entry"}</button>
				</div>
			</div>
			<div class="bg-zinc-900 rounded-2xl px-4 divide-y divide-zinc-800 max-h-[30rem] overflow-y-auto">
				${_changelog.map(changelogRowHtml).join("") || '<p class="text-zinc-500 text-sm py-3">No entries yet.</p>'}
			</div>
		</div>`;

	for (const id of [
		"announce-title",
		"announce-body",
		"announce-link",
		"announce-audience",
		"announce-banner",
		"announce-style",
		"announce-when",
		"announce-repeat",
		"announce-silent",
		"announce-nopush",
		"announce-ack",
		"announce-username",
	])
		el(id).addEventListener("input", updateAnnouncementPreview);
	el("announce-audience").addEventListener("change", (e) => show("announce-username", e.target.value === "player"));
	el("announce-search").addEventListener("input", (e) => {
		_announceSearch = e.target.value;
		filterAnnouncementHistory();
	});
	if (_editingEntry) {
		el("changelog-title").value = _editingEntry.title;
		el("changelog-body").value = _editingEntry.body;
		el("changelog-date").value = new Date(_editingEntry.released_at * 1000).toISOString().slice(0, 10);
	}
	filterAnnouncementHistory();
	updateAnnouncementPreview();
}

function filterAnnouncementHistory() {
	const query = _announceSearch.trim().toLowerCase();
	for (const row of document.querySelectorAll("#announce-history [data-search]"))
		row.classList.toggle("hidden", !!query && !row.dataset.search.toLowerCase().includes(query));
}

function moreAnnouncements() {
	_announceLimit += 40;
	loadAnnouncements();
}

function announcementDraft() {
	const value = (id, fallback) => el(id)?.value ?? fallback;
	const ticked = (id) => !!el(id)?.checked;
	return {
		title: value("announce-title", "").trim(),
		body: value("announce-body", "").trim(),
		link: value("announce-link", "").trim(),
		audience: value("announce-audience", "everyone"),
		banner_hours: Number(value("announce-banner", 0)),
		style: value("announce-style", "info"),
		expire_days: Number(value("announce-expire", 0)),
		repeat: value("announce-repeat", ""),
		username: value("announce-username", "").trim(),
		when: value("announce-when", ""),
		silent: ticked("announce-silent"),
		no_push: ticked("announce-nopush"),
		must_ack: ticked("announce-ack"),
	};
}

function reuseAnnouncement(id, isDraft = false) {
	const a = _announcements?.history.find((item) => item.id === id);
	if (!a) return;
	const set = (field, value) => (el(field).value = value);
	set("announce-title", a.title);
	set("announce-body", a.body);
	set("announce-link", a.link || "");
	set("announce-audience", a.audience);
	set("announce-username", a.target_username || "");
	set("announce-banner", String(a.banner_hours || 0));
	set("announce-style", a.style || "info");
	set("announce-expire", String(a.expire_days || 0));
	set("announce-repeat", a.repeat || "");
	el("announce-silent").checked = !!a.silent;
	el("announce-nopush").checked = !!a.no_push;
	el("announce-ack").checked = !!a.must_ack;
	show("announce-username", a.audience === "player");
	_fromDraft = isDraft ? id : null;
	updateAnnouncementPreview();
	el("announce-title").scrollIntoView({ block: "center", behavior: scrollBehavior() });
	el("announce-title").focus();
}

function insertAnnouncementDate() {
	const picked = el("announce-date").value;
	if (!picked) return showToast("Pick a date and time first.", "error");
	const text = `${new Date(picked).toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })} UK time`;
	const box = el("announce-body");
	const at = box.selectionStart ?? box.value.length;
	box.value = `${box.value.slice(0, at)}${text}${box.value.slice(box.selectionEnd ?? at)}`.slice(0, 400);
	box.focus();
	updateAnnouncementPreview();
}

function updateAnnouncementPreview() {
	const draft = announcementDraft();
	const noBanner = PRIVATE_AUDIENCES.includes(draft.audience);
	if (noBanner) {
		el("announce-banner").value = "0";
		el("announce-silent").checked = false;
	}
	el("announce-banner").disabled = el("announce-silent").disabled = noBanner;
	const banner = noBanner ? 0 : draft.banner_hours;
	const silent = draft.silent && !noBanner;
	el("announce-style").disabled = !banner;
	el("announce-nopush").disabled = el("announce-ack").disabled = el("announce-expire").disabled = silent;
	el("announce-repeat").disabled = !draft.when;
	el("announce-title-count").textContent = `${draft.title.length}/120`;
	el("announce-body-count").textContent = `${draft.body.length}/400`;

	const linkOk = !draft.link || /^\/(?!\/)/.test(draft.link) || /^https:\/\/\S+$/i.test(draft.link);
	const external = linkOk && isExternalLink(draft.link);
	const problem =
		draft.title.length < 5
			? "The title needs at least 5 characters."
			: draft.body.length < 10
				? "The message needs at least 10 characters."
				: !linkOk
					? "The link has to be a page on this site, like /daily, or start with https://."
					: UNFILLED.test(draft.title + draft.body)
						? "Fill in the parts in [brackets] first."
						: draft.audience === "player" && !draft.username
							? "Say which player it is for."
							: silent && !banner
								? "A banner-only announcement needs a banner length."
								: "";
	const reach = _announcements?.audiences?.[draft.audience] ?? 0;
	const to =
		draft.audience === "player"
			? `@${draft.username}`
			: `${reach.toLocaleString()} account${reach === 1 ? "" : "s"}`;
	el("announce-hint").textContent =
		problem ||
		`${silent ? "No notification is sent" : `Goes to ${to}`}${banner ? `${silent ? ". It" : ", and"} stays on every page for ${BANNER_LABELS[banner].toLowerCase()} (logged-out visitors see it too)` : ""}.`;
	el("announce-hint").classList.toggle("text-amber-300", !!problem);
	el("announce-send").disabled = el("announce-test").disabled = el("announce-draft").disabled = !!problem;
	el("announce-send-label").textContent = draft.when ? "Schedule" : "Send";

	const goesAt = draft.when ? new Date(draft.when) : new Date();
	const noisy = !silent && !draft.no_push && !PRIVATE_AUDIENCES.includes(draft.audience) && isQuietHour(goesAt);
	el("announce-quiet").textContent = noisy
		? `That is ${String(ukHour(goesAt)).padStart(2, "0")}:00 in the UK. Push notifications will buzz phones at night: tick "No push notification" or pick another time.`
		: "";
	show("announce-quiet", noisy);

	const title = escHtml(draft.title || "Title");
	const body = escHtml(draft.body || "Your message appears here.");
	const [, icon] = STYLE_LOOK[draft.style] || STYLE_LOOK.info;
	const caption = (text) => `<div class="text-[11px] text-zinc-600 mt-1 mb-3 break-words">${text}</div>`;
	el("announce-preview").innerHTML =
		(silent
			? ""
			: `<div class="bg-zinc-900 rounded-2xl px-4 py-3 flex items-start gap-3">
				<span class="material-symbols-outlined text-xl text-purple-400 flex-shrink-0 mt-0.5">campaign</span>
				<div class="min-w-0">
					<div class="text-sm font-semibold break-words">${title}</div>
					<div class="text-xs text-zinc-400 break-words">${body}</div>
				</div>
			</div>
			${caption(`In the inbox · opens ${escHtml(draft.link && linkOk ? draft.link : "the notifications page")}${external ? " after a warning about leaving the site" : ""}`)}
			${
				draft.no_push
					? ""
					: `<div class="bg-zinc-800 rounded-xl px-3 py-2 flex items-start gap-2.5 max-w-xs">
						<img src="/icons/icon-192.png" alt="" class="w-8 h-8 rounded-lg flex-shrink-0" />
						<div class="min-w-0"><div class="text-xs font-semibold truncate">${title}</div><div class="text-[11px] text-zinc-400 line-clamp-2">${body}</div></div>
					</div>
					${caption("As a push notification, for players who turned those on")}`
			}
			<div class="bg-white rounded-xl px-3 py-2 max-w-xs"><div class="text-xs font-semibold text-zinc-900 truncate">${title}</div><div class="text-[11px] text-zinc-600 line-clamp-2">${body}</div></div>
			${caption("One line in the email summary, for players who get those")}
			${
				draft.must_ack
					? `<div class="bg-zinc-900 border border-zinc-700 rounded-2xl p-4 max-w-xs"><div class="font-bold text-sm mb-1">${title}</div><div class="text-xs text-zinc-400 mb-3">${body}</div><span class="m-btn m-btn-filled m-btn-sm">OK</span></div>
					${caption("As a dialog on their next visit, until they press OK")}`
					: ""
			}`) +
		(banner
			? `<div class="site-announcement" data-style="${escHtml(draft.style)}" style="position:static;width:auto;animation:none">
				<span class="site-announcement-icon" aria-hidden="true"><span class="material-symbols-outlined">${icon}</span></span>
				<div class="site-announcement-text">
					<div class="site-announcement-title">${title}</div>
					<div class="site-announcement-body">${body}</div>
					${draft.link && linkOk ? `<span class="site-announcement-link">Take a look${external ? EXTERNAL_ICON : ""}</span>` : ""}
				</div>
				<span class="m-icon-btn" aria-hidden="true"><span class="material-symbols-outlined">close</span></span>
			</div>
			${caption("The banner, in the bottom corner of every page")}`
			: "");
}

async function sendAnnouncement(test, asDraft = false) {
	const draft = announcementDraft();
	const sendAt = draft.when ? Math.floor(new Date(draft.when).getTime() / 1000) : null;
	if (!test && !asDraft) {
		const reach = _announcements?.audiences?.[draft.audience] ?? 0;
		const to =
			draft.audience === "player"
				? `@${draft.username}`
				: `${AUDIENCE_LABELS[draft.audience].toLowerCase()} (${reach.toLocaleString()} account${reach === 1 ? "" : "s"})`;
		const ok = await showConfirm(
			sendAt ? "Schedule this announcement?" : "Send this announcement?",
			`"${draft.title}" ${draft.silent ? "goes up as a banner only" : `goes to ${to}`}${sendAt ? ` on ${formatWhen(sendAt)}` : ""}${draft.banner_hours && !draft.silent ? ` and is pinned to every page for ${BANNER_LABELS[draft.banner_hours].toLowerCase()}` : ""}. ${sendAt ? "It can be called off until then." : `It can be corrected or taken back for ${_announcements.recall_hours} hours.`}`,
			{ confirmLabel: sendAt ? "Schedule" : "Send", confirmClass: "m-btn-filled" }
		);
		if (!ok) return;
	}
	try {
		const { sent, scheduled } = await api("/api/admin/announcements", {
			json: {
				...draft,
				test,
				when: undefined,
				draft: asDraft,
				...(sendAt && !test ? { send_at: sendAt } : {}),
				...(_fromDraft && !test ? { from_draft: _fromDraft } : {}),
			},
		});
		if (test) return showToast("Test sent. Check your notifications.", "success");
		showToast(
			asDraft
				? "Draft saved."
				: scheduled
					? "Announcement scheduled."
					: draft.silent
						? "Banner is up."
						: `Announcement sent to ${sent.toLocaleString()} account${sent === 1 ? "" : "s"}.`,
			"success"
		);
		_fromDraft = null;
		for (const id of ["announce-title", "announce-body", "announce-link", "announce-when", "announce-username"])
			el(id).value = "";
		for (const id of ["announce-silent", "announce-nopush", "announce-ack"]) el(id).checked = false;
		await loadAnnouncements();
		if (draft.banner_hours) checkAnnouncement();
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function announcementAction(request, done) {
	try {
		const result = await request();
		showToast(typeof done === "function" ? done(result) : done, "success");
		await loadAnnouncements();
		checkAnnouncement();
	} catch (err) {
		showToast(err.message || "That didn't work.", "error");
	}
}

async function recallAnnouncement(id, scheduled = false) {
	const ok = scheduled
		? await showConfirm("Call off this announcement?", "It will not be sent.", { confirmLabel: "Call off" })
		: await showConfirm(
				"Take this announcement back?",
				"It is removed from every inbox and its banner comes down. A notification already shown on someone's phone or desktop cannot be pulled back.",
				{ confirmLabel: "Take back" }
			);
	if (!ok) return;
	announcementAction(
		() => api(`/api/admin/announcements/${id}/recall`, { method: "POST" }),
		({ removed }) =>
			scheduled ? "Called off." : `Taken back from ${removed.toLocaleString()} inbox${removed === 1 ? "" : "es"}.`
	);
}

function setAnnouncementBanner(id, hours) {
	if (hours === "") return;
	announcementAction(
		() => api(`/api/admin/announcements/${id}/banner`, { json: { hours: Number(hours) } }),
		Number(hours) ? "Banner is up." : "Banner taken down."
	);
}

async function deleteAnnouncement(id) {
	const ok = await showConfirm(
		"Remove it from this list?",
		"Copies still in players' inboxes stay there. This only clears it from the history.",
		{ confirmLabel: "Remove" }
	);
	if (ok)
		announcementAction(
			() => api(`/api/admin/announcements/${id}`, { method: "DELETE" }),
			"Removed from the history."
		);
}

async function showUnreadStaff(id) {
	try {
		const names = await api(`/api/admin/announcements/${id}/unread`);
		el(`announce-unread-${id}`).textContent = names.length
			? `Not read yet: ${names.map((name) => `@${name}`).join(", ")}`
			: "Everyone has read it.";
	} catch (err) {
		showToast(err.message, "error");
	}
}

function correctAnnouncement(id) {
	const a = _announcements?.history.find((item) => item.id === id);
	if (!a || el("announcement-fix")) return;
	const box = document.createElement("div");
	box.id = "announcement-fix";
	box.className = "fixed inset-0 z-[70] bg-black/60 flex items-center justify-center px-4 modal-fade";
	box.innerHTML = `<div class="bg-zinc-900 rounded-2xl p-6 w-full max-w-md flex flex-col gap-2" role="dialog" aria-modal="true" aria-label="Fix the wording">
		<h3 class="font-bold">Fix the wording</h3>
		<p class="text-xs text-zinc-500 mb-1">Changes it in every inbox and on the banner. Nobody is notified again.</p>
		<input id="fix-title" type="text" maxlength="120" class="m-field" aria-label="Title" />
		<textarea id="fix-body" rows="4" maxlength="400" class="m-field" aria-label="Message"></textarea>
		<input id="fix-link" type="text" maxlength="200" placeholder="Link (optional), e.g. /daily or https://..." class="m-field" aria-label="Link" />
		<div class="flex gap-2 justify-end mt-2">
			<button id="fix-cancel" class="m-btn m-btn-text">Cancel</button>
			<button id="fix-save" class="m-btn m-btn-filled">Save</button>
		</div>
	</div>`;
	document.body.appendChild(box);
	el("fix-title").value = a.title;
	el("fix-body").value = a.body;
	el("fix-link").value = a.link || "";
	const close = () => box.remove();
	box.addEventListener("keydown", (e) => e.key === "Escape" && close());
	el("fix-cancel").addEventListener("click", close);
	el("fix-save").addEventListener("click", () => {
		const json = { title: el("fix-title").value, body: el("fix-body").value, link: el("fix-link").value };
		close();
		announcementAction(() => api(`/api/admin/announcements/${id}/correct`, { json }), "Wording updated.");
	});
	el("fix-title").focus();
}

function editChangelogEntry(id) {
	_editingEntry = _changelog.find((entry) => entry.id === id) ?? null;
	renderAnnouncements();
	el("changelog-title")?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
}

function cancelChangelogEdit() {
	_editingEntry = null;
	renderAnnouncements();
}

async function saveChangelogEntry() {
	const json = {
		title: el("changelog-title").value.trim(),
		body: el("changelog-body").value.trim(),
		/** Midday UTC, so the date reads the same in every timezone. */
		released_at: Math.floor(new Date(`${el("changelog-date").value}T12:00:00Z`).getTime() / 1000),
	};
	try {
		await api(`/api/admin/announcements/changelog${_editingEntry ? `/${_editingEntry.id}` : ""}`, { json });
		showToast(_editingEntry ? "Entry updated." : "Entry added.", "success");
		_editingEntry = null;
		loadAnnouncements();
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function deleteChangelogEntry(id) {
	if (
		!(await showConfirm("Remove this changelog entry?", "It disappears from the news page.", {
			confirmLabel: "Remove",
		}))
	)
		return;
	try {
		await api(`/api/admin/announcements/changelog/${id}`, { method: "DELETE" });
		showToast("Entry removed.", "success");
		if (_editingEntry?.id === id) _editingEntry = null;
		loadAnnouncements();
	} catch (err) {
		showToast(err.message, "error");
	}
}

Object.assign(window, {
	cancelChangelogEdit,
	correctAnnouncement,
	deleteAnnouncement,
	deleteChangelogEntry,
	editChangelogEntry,
	insertAnnouncementDate,
	loadAnnouncements,
	moreAnnouncements,
	recallAnnouncement,
	reuseAnnouncement,
	saveChangelogEntry,
	sendAnnouncement,
	setAnnouncementBanner,
	showUnreadStaff,
	useAnnouncementPreset,
});
