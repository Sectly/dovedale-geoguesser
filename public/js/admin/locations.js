/** Staff panel: the location list, stats, and adding locations directly. */

async function loadLocations() {
	try {
		const r = await fetch("/api/admin/locations");
		if (!r.ok) throw new Error();
		renderLocations(await r.json());
	} catch {
		el("tab-content").innerHTML = '<div class="text-red-400">Failed to load locations.</div>';
	}
}

function renderLocations(items) {
	/** New locations go through the Submit page and the review queue, like everyone else's. */
	const uploadBtn = `<a href="/submit" class="bg-blue-600 hover:bg-blue-500 transition px-4 py-2 rounded-xl text-sm font-semibold">+ Submit a Location</a>`;
	el("tab-content").innerHTML = `
        <div class="flex items-center justify-between mb-4">
            <h2 class="font-bold text-lg">Locations (${items.length})</h2>
            ${uploadBtn}
        </div>
        ${panelSearchInput("Search location ID, label, filename, hints or status...")}
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" id="locations-list">
            ${items
				.map((loc) => {
					let parsedHints = [];
					try {
						parsedHints = JSON.parse(loc.hints || "[]");
					} catch {}
					const hintsHtml = parsedHints
						.map(
							(h, i) => `
                    <div class="flex items-center gap-1 mb-1">
                        <input type="text" value="${escHtml(h)}" class="hint-input flex-1 bg-zinc-800 rounded px-2 py-1 text-xs focus:outline-none" data-idx="${i}" data-loc="${loc.id}" />
                        <button onclick="removeHint(${loc.id},${i})" class="text-zinc-500 hover:text-red-400 transition text-xs px-1" aria-label="Remove hint"><span class="material-symbols-outlined text-sm leading-none">close</span></button>
                    </div>`
						)
						.join("");
					const searchText = [
						loc.id,
						`LOC-${String(loc.id).padStart(4, "0")}`,
						loc.label,
						loc.image_path,
						parsedHints.join(" "),
						loc.world_x,
						loc.world_y,
						loc.is_active ? "active" : "inactive",
						loc.submitted_by_username,
						loc.submitted_by_display_name,
					].join(" ");
					return `
                <div class="bg-zinc-900 rounded-2xl overflow-hidden" id="loc-${loc.id}" data-search="${escHtml(searchText)}">
                    <img loading="lazy" src="/uploads/${escHtml(loc.image_path)}" alt="Location" class="submission-img" />
                    <div class="p-3">
                        <div class="flex items-start justify-between gap-2 mb-0.5">
                            <div class="flex-1 flex items-center gap-1 min-w-0">
                                <input type="text" value="${escHtml(loc.label || "")}" placeholder="No label" class="label-input flex-1 bg-transparent text-sm font-semibold focus:bg-zinc-800 focus:outline-none rounded px-1 -mx-1 min-w-0 truncate" data-loc="${loc.id}" onkeydown="if(event.key==='Enter')saveLabel(${loc.id})" />
                                <button onclick="saveLabel(${loc.id})" class="text-xs text-zinc-500 hover:text-zinc-300 transition px-1 flex-shrink-0">Save</button>
                            </div>
                            <span class="text-xs font-mono text-zinc-600 flex-shrink-0">LOC-${String(loc.id).padStart(4, "0")}</span>
                        </div>
                        <div class="text-xs text-zinc-600 mb-2">${new Date(loc.created_at * 1000).toLocaleDateString()} · ${loc.is_active ? '<span class="text-green-400">Active</span>' : '<span class="text-zinc-500">Inactive</span>'}${loc.submitted_by ? ` · <span class="text-zinc-500">By: <span class="text-zinc-400">${escHtml(loc.submitted_by_display_name || loc.submitted_by_username || `#${loc.submitted_by}`)}</span></span>` : ""}${loc.approved_by ? ` · <span class="text-zinc-500">Approved by: <span class="text-zinc-400">${escHtml(loc.approved_by_display_name || loc.approved_by_username || `#${loc.approved_by}`)}</span></span>` : ""}</div>
                        <div class="text-xs text-zinc-500 mb-2 flex items-center gap-2 flex-wrap">
                            <span class="m-tag ${loc.difficulty === "hard" ? "danger" : loc.difficulty === "easy" ? "success" : loc.difficulty ? "warn" : ""}">${loc.difficulty ? loc.difficulty[0].toUpperCase() + loc.difficulty.slice(1) : "Ungraded"}</span>
                            <span>${loc.plays ? `${loc.plays.toLocaleString()} guess${loc.plays === 1 ? "" : "es"}, avg ${Number(loc.avg_score).toLocaleString()} pts` : "No guesses counted yet"}</span>
                            ${loc.plays ? `<button onclick="resetLocationStats(${loc.id})" class="underline hover:text-zinc-300 transition" title="Forget how players have done here, e.g. after fixing the pin or the screenshot">Reset</button>` : ""}
                        </div>
                        <div class="mb-2">
                            <div class="text-xs text-zinc-500 mb-1">Hints</div>
                            <div id="hints-${loc.id}">${hintsHtml}</div>
                            <button onclick="addHintRow(${loc.id})" class="text-xs text-zinc-500 hover:text-zinc-300 transition mt-1">+ Add hint</button>
                            <button onclick="saveHints(${loc.id})" class="text-xs bg-zinc-700 hover:bg-zinc-600 transition px-2 py-1 rounded ml-2">Save hints</button>
                        </div>
                        <div class="flex gap-2">
                            <button onclick="toggleLocation(${loc.id}, ${loc.is_active})" class="flex-1 bg-zinc-700 hover:bg-zinc-600 transition px-3 py-1.5 rounded-lg text-xs">
                                ${loc.is_active ? "Deactivate" : "Activate"}
                            </button>
                            ${currentUser?.role === "operator" ? `<button onclick="deleteLocation(${loc.id})" class="bg-red-900 hover:bg-red-800 transition px-3 py-1.5 rounded-lg text-xs">Delete</button>` : ""}
                        </div>
                    </div>
                </div>`;
				})
				.join("")}
            <div id="panel-search-empty" class="hidden col-span-full text-zinc-500 text-center py-8">No locations match your search.</div>
        </div>`;
	bindPanelSearch("#locations-list [data-search]");
}

/** Clears a location's difficulty record so it is graded afresh from the next guesses. */
async function resetLocationStats(locId) {
	if (
		!(await showConfirm(
			"Reset this location's difficulty?",
			"Its guess count and average are cleared, and it stays ungraded until enough new guesses come in.",
			{ confirmLabel: "Reset" }
		))
	)
		return;
	try {
		await api(`/api/admin/locations/${locId}/stats/reset`, { method: "POST" });
		showToast("Difficulty reset.", "success");
		loadLocations();
	} catch (err) {
		showToast(err.message || "Failed to reset.", "error");
	}
}

async function saveLabel(locId) {
	const input = document.querySelector(`.label-input[data-loc="${locId}"]`);
	if (!input) return;
	const label = input.value.trim();
	try {
		const r = await fetch(`/api/admin/locations/${locId}/label`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ label }),
		});
		if (!r.ok) throw new Error(await r.text());
		showToast("Label saved.", "success");
	} catch (err) {
		showToast(err.message || "Failed to save label.", "error");
	}
}

function addHintRow(locId) {
	const container = el(`hints-${locId}`);
	const idx = container.querySelectorAll(".hint-input").length;
	const div = document.createElement("div");
	div.className = "flex items-center gap-1 mb-1";
	div.innerHTML = `
        <input type="text" placeholder="Hint text..." class="hint-input flex-1 bg-zinc-800 rounded px-2 py-1 text-xs focus:outline-none" data-idx="${idx}" data-loc="${locId}" />
        <button onclick="this.parentElement.remove()" class="text-zinc-500 hover:text-red-400 transition text-xs px-1" aria-label="Remove hint"><span class="material-symbols-outlined text-sm leading-none">close</span></button>`;
	container.appendChild(div);
}

function removeHint(locId, idx) {
	const inputs = el(`hints-${locId}`).querySelectorAll(".hint-input");
	inputs[idx]?.closest("div")?.remove();
}

async function saveHints(locId) {
	const inputs = el(`hints-${locId}`).querySelectorAll(".hint-input");
	const hints = Array.from(inputs)
		.map((i) => i.value.trim())
		.filter(Boolean);
	try {
		const r = await fetch(`/api/admin/locations/${locId}/hints`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hints }),
		});
		if (!r.ok) throw new Error(await r.text());
		showToast("Hints saved.", "success");
	} catch (err) {
		showToast(err.message || "Failed to save hints.", "error");
	}
}

/* ---- Stats: what is happening now, what needs doing, and how the last two weeks went ---- */

let _stats = null;
let _statSeries = "games";
let _announcements = null;

/** The activity chart shows one of these at a time, so every bar means the same thing. */
const STAT_SERIES = {
	games: ["All games", (d) => d.solo + d.daily + d.duels, "game"],
	new_users: ["New players", (d) => d.new_users, "new player"],
	solo: ["Solo", (d) => d.solo, "solo game"],
	daily: ["Daily", (d) => d.daily, "daily play"],
	duels: ["Duels", (d) => d.duels, "duel"],
};

async function loadStats() {
	try {
		_stats = await api("/api/admin/stats");
	} catch (err) {
		el("tab-content").innerHTML =
			`<div class="text-red-400">${escHtml(err.message || "Failed to load stats.")}</div>`;
		return;
	}
	renderStats(_stats);
	if (currentUser.role === "operator") loadAnnouncements();
}

function statCard(label, value, sub = "", href = "") {
	const inner = `<div class="text-2xl font-bold font-mono">${value}</div>
		<div class="text-zinc-400 text-sm mt-1">${label}</div>
		${sub ? `<div class="text-zinc-600 text-xs mt-0.5">${sub}</div>` : ""}`;
	return href
		? `<a href="${href}" class="md-card block bg-zinc-900 hover:bg-zinc-800 rounded-2xl px-5 py-4 text-center">${inner}</a>`
		: `<div class="bg-zinc-900 rounded-2xl px-5 py-4 text-center">${inner}</div>`;
}

const statHeading = (title, note = "") =>
	`<div class="flex items-baseline gap-2 mb-3 mt-8"><h3 class="font-semibold text-zinc-300">${title}</h3>${note ? `<span class="text-xs text-zinc-600">${note}</span>` : ""}</div>`;

/** A bar per day for the chosen series, with the count on hover and a table for those who want the numbers. */
function statChartHtml(series) {
	const [title, valueOf, noun] = STAT_SERIES[_statSeries];
	const values = series.map(valueOf);
	const peak = Math.max(...values, 1);
	const total = values.reduce((sum, n) => sum + n, 0);
	const day = (date, options) =>
		new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", ...options });
	const plural = (n) => `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
	const tabs = Object.entries(STAT_SERIES)
		.map(
			([key, [label]]) =>
				`<button onclick="setStatSeries('${key}')" aria-pressed="${_statSeries === key}">${label}</button>`
		)
		.join("");
	return `<div class="bg-zinc-900 rounded-2xl p-5">
		<div class="flex items-center justify-between gap-3 flex-wrap mb-4">
			<div class="m-segmented">${tabs}</div>
			<div class="text-xs text-zinc-500">${plural(total)} in ${series.length} days · busiest day ${peak === 1 && total === 0 ? "none" : Math.max(...values).toLocaleString()}</div>
		</div>
		<div class="stat-chart" role="img" aria-label="${escHtml(title)} per day over the last ${series.length} days">
			${series
				.map(
					(d, i) =>
						`<div class="stat-chart-col" tabindex="0" data-tip="${escHtml(`${day(d.date, { weekday: "short", day: "numeric", month: "short" })} · ${plural(values[i])}`)}"><div class="stat-chart-bar ${values[i] ? "" : "empty"}" style="height:${values[i] ? Math.max(3, (values[i] / peak) * 100) : 0}%"></div></div>`
				)
				.join("")}
		</div>
		<div class="stat-chart-axis" aria-hidden="true">${series.map((d, i) => `<span>${i % 2 === series.length % 2 ? "" : day(d.date, { day: "numeric", month: "short" })}</span>`).join("")}</div>
		<details class="mt-3">
			<summary class="text-xs text-zinc-500 cursor-pointer hover:text-zinc-300">Show as a table</summary>
			<div class="overflow-x-auto mt-2"><table class="w-full text-xs text-left">
				<thead class="text-zinc-500"><tr><th class="py-1 pr-3 font-medium">Day (UTC)</th><th class="py-1 pr-3 font-medium text-right">New players</th><th class="py-1 pr-3 font-medium text-right">Solo</th><th class="py-1 pr-3 font-medium text-right">Daily</th><th class="py-1 font-medium text-right">Duels</th></tr></thead>
				<tbody class="font-mono text-zinc-300">${[...series]
					.reverse()
					.map(
						(d) =>
							`<tr class="border-t border-zinc-800"><td class="py-1 pr-3 font-sans text-zinc-400">${day(d.date, { weekday: "short", day: "numeric", month: "short" })}</td><td class="py-1 pr-3 text-right">${d.new_users}</td><td class="py-1 pr-3 text-right">${d.solo}</td><td class="py-1 pr-3 text-right">${d.daily}</td><td class="py-1 text-right">${d.duels}</td></tr>`
					)
					.join("")}</tbody>
			</table></div>
		</details>
	</div>`;
}

/** Redraws only the chart, so nothing else on the tab (a half-written announcement, say) is disturbed. */
function setStatSeries(key) {
	_statSeries = key;
	el("stat-chart-box").innerHTML = statChartHtml(_stats.series || []);
}

function renderStats(s) {
	const n = (value) => (value ?? 0).toLocaleString();
	const q = s.queues || {};
	const waiting = (q.submissions || 0) + (q.suggestions || 0) + (q.tickets || 0) + (q.users || 0);
	el("tab-content").innerHTML = `
		<div class="flex items-center justify-between gap-3 mb-1">
			<h2 class="font-bold text-lg">Site Stats</h2>
			<button onclick="loadStats()" class="m-icon-btn" title="Refresh" aria-label="Refresh"><span class="material-symbols-outlined">refresh</span></button>
		</div>

		${statHeading("Right now")}
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			${statCard("Duels being played", n(s.live?.duels), `${n(s.live?.duel_rooms_waiting)} waiting to start`)}
			${statCard("Watching duels", n(s.live?.spectators))}
			${statCard("Team games", n(s.live?.team_games))}
			${statCard("Solo games open", n(s.live?.solo_games))}
		</div>

		${statHeading("Waiting for staff", waiting ? "" : "Nothing is waiting")}
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			${statCard("Submissions", n(q.submissions), "to review", "#submissions")}
			${statCard("Suggestions", n(q.suggestions), "to review", "#suggestions")}
			${statCard("Tickets", n(q.tickets), "awaiting a reply", "#tickets")}
			${statCard("Evasion flags", n(q.users), "to look at", "#users")}
		</div>

		${statHeading("Last 14 days", "Days are in UTC")}
		<div id="stat-chart-box">${statChartHtml(s.series || [])}</div>

		${statHeading("Players")}
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			${statCard("Accounts", n(s.users?.total), `${n(s.users?.last_7d)} new this week`)}
			${statCard("Played today", n(s.users?.active_today))}
			${statCard("Played this week", n(s.users?.active_7d))}
			${statCard("Played this month", n(s.users?.active_30d), `${n(s.users?.banned)} banned`)}
		</div>

		${statHeading("Games")}
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			${statCard("Solo games", n(s.scores?.total_games), `${n(s.scores?.last_7d)} this week`)}
			${statCard("Daily plays", n(s.daily?.total_plays), `${n(s.daily?.today)} today · ${n(s.daily?.last_7d)} this week`)}
			${statCard("Duels finished", n(s.duels?.finished), `${n(s.duels?.last_7d)} this week`)}
			${statCard("Ranked duels", n(s.duels?.ranked), `${n(s.achievements?.earned)} achievements earned`)}
		</div>

		${statHeading("Locations")}
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			${statCard("Active", n(s.locations?.active), `${n(s.locations?.total)} in total`, "#locations")}
			${statCard("Easy", n(s.locations?.easy))}
			${statCard("Medium", n(s.locations?.medium))}
			${statCard("Hard", n(s.locations?.hard), `${n(s.locations?.ungraded)} not graded yet`)}
		</div>

		${currentUser.role === "operator" ? '<div id="announcements-panel"></div>' : ""}`;
}

/* ---- Announcements (operators): write one, check it, send it, and see what has gone out ---- */

const AUDIENCE_LABELS = {
	everyone: ["Everyone", "Every account that is not banned"],
	active: ["Active players", "Accounts that have played in the last 30 days"],
	staff: ["Staff only", "Everyone with a staff role"],
};
const BANNER_LABELS = { 0: "No banner", 1: "1 hour", 6: "6 hours", 24: "1 day", 72: "3 days" };

async function loadAnnouncements() {
	try {
		_announcements = await api("/api/admin/announcements");
	} catch {
		_announcements = null;
	}
	renderAnnouncements();
}

function renderAnnouncements() {
	const box = el("announcements-panel");
	if (!box || !_announcements) return;
	// Redrawing must not throw away what is being written.
	const draft = announcementDraft();
	const sizes = _announcements.audiences;
	const field =
		"bg-zinc-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600";
	const history = _announcements.history
		.map(
			(a) => `<div class="py-2.5 flex items-start gap-3">
				<div class="flex-1 min-w-0">
					<div class="text-sm font-semibold break-words">${escHtml(a.title)} ${a.banner_live ? '<span class="m-tag info ml-1">Banner showing</span>' : ""}</div>
					<div class="text-xs text-zinc-400 break-words">${escHtml(a.body)}</div>
					<div class="text-[11px] text-zinc-600 mt-0.5">${formatWhen(a.created_at)} · by ${escHtml(a.created_by || "staff")} · ${escHtml(AUDIENCE_LABELS[a.audience]?.[0] || a.audience)}, ${a.sent_to.toLocaleString()} account${a.sent_to === 1 ? "" : "s"}${a.link ? ` · links to ${escHtml(a.link)}` : ""}</div>
				</div>
				${a.banner_live ? `<button onclick="endAnnouncementBanner(${a.id})" class="m-btn m-btn-text m-btn-sm flex-shrink-0">Take banner down</button>` : ""}
			</div>`
		)
		.join("");

	box.innerHTML = `${statHeading("Announcement")}
		<p class="text-zinc-500 text-xs mb-3 -mt-2">A notification to many accounts at once, for rule changes, planned downtime and new features. It is sent whatever a player's notification settings are, so use it sparingly.</p>
		<div class="grid md:grid-cols-2 gap-4 items-start">
			<div class="bg-zinc-900 rounded-2xl p-4 flex flex-col gap-2">
				<label class="m-label" for="announce-title">Title <span id="announce-title-count" class="text-zinc-600 font-normal"></span></label>
				<input id="announce-title" maxlength="120" placeholder="What is it about?" class="${field}" value="${escHtml(draft.title)}" />
				<label class="m-label mt-1" for="announce-body">Message <span id="announce-body-count" class="text-zinc-600 font-normal"></span></label>
				<textarea id="announce-body" rows="4" maxlength="400" placeholder="What do players need to know?" class="${field} resize-none">${escHtml(draft.body)}</textarea>
				<label class="m-label mt-1" for="announce-link">Link <span class="text-zinc-600 font-normal">(optional, a page on this site)</span></label>
				<input id="announce-link" maxlength="200" placeholder="/daily" class="${field}" value="${escHtml(draft.link)}" />
				<div class="grid grid-cols-2 gap-2 mt-1">
					<div>
						<label class="m-label" for="announce-audience">Send to</label>
						<select id="announce-audience" class="m-field">${Object.entries(AUDIENCE_LABELS)
							.map(
								([key, [label]]) =>
									`<option value="${key}" ${draft.audience === key ? "selected" : ""}>${label} (${(sizes[key] ?? 0).toLocaleString()})</option>`
							)
							.join("")}</select>
					</div>
					<div>
						<label class="m-label" for="announce-banner">Banner on every page</label>
						<select id="announce-banner" class="m-field">${_announcements.banner_hours
							.map(
								(h) =>
									`<option value="${h}" ${Number(draft.banner_hours) === h ? "selected" : ""}>${BANNER_LABELS[h] || `${h} hours`}</option>`
							)
							.join("")}</select>
					</div>
				</div>
				<p id="announce-hint" class="text-xs text-zinc-500 min-h-[1rem]"></p>
				<div class="flex justify-end gap-2 flex-wrap">
					<button id="announce-test" onclick="sendAnnouncement(true)" class="m-btn m-btn-text" title="Sends it to you alone, so you can see it in your inbox first">Send me a test</button>
					<button id="announce-send" onclick="sendAnnouncement(false)" class="m-btn m-btn-filled"><span class="material-symbols-outlined">campaign</span>Send</button>
				</div>
			</div>
			<div>
				<div class="m-label">Preview</div>
				<div id="announce-preview"></div>
				<div class="m-label mt-4">Sent before</div>
				<div class="bg-zinc-900 rounded-2xl px-4 divide-y divide-zinc-800 max-h-80 overflow-y-auto">${history || '<p class="text-zinc-500 text-sm py-3">Nothing has been sent yet.</p>'}</div>
			</div>
		</div>`;
	for (const id of ["announce-title", "announce-body", "announce-link", "announce-audience", "announce-banner"])
		el(id).addEventListener("input", updateAnnouncementPreview);
	updateAnnouncementPreview();
}

function announcementDraft() {
	const value = (id, fallback) => el(id)?.value ?? fallback;
	return {
		title: value("announce-title", "").trim(),
		body: value("announce-body", "").trim(),
		link: value("announce-link", "").trim(),
		audience: value("announce-audience", "everyone"),
		banner_hours: Number(value("announce-banner", 0)),
	};
}

/** Shows the notification as players will get it, and holds the buttons back until it can be sent. */
function updateAnnouncementPreview() {
	const draft = announcementDraft();
	const staffOnly = draft.audience === "staff";
	if (staffOnly) el("announce-banner").value = "0";
	el("announce-banner").disabled = staffOnly;
	const banner = staffOnly ? 0 : draft.banner_hours;
	el("announce-title-count").textContent = `${draft.title.length}/120`;
	el("announce-body-count").textContent = `${draft.body.length}/400`;

	const linkOk = !draft.link || /^\/(?!\/)/.test(draft.link);
	const problem =
		draft.title.length < 5
			? "The title needs at least 5 characters."
			: draft.body.length < 10
				? "The message needs at least 10 characters."
				: !linkOk
					? "The link has to start with a single /, like /daily."
					: "";
	const reach = _announcements?.audiences?.[draft.audience] ?? 0;
	el("announce-hint").textContent =
		problem ||
		`Goes to ${reach.toLocaleString()} account${reach === 1 ? "" : "s"}${banner ? `, and stays on every page for ${BANNER_LABELS[banner].toLowerCase()} (logged-out visitors see it too)` : ""}.`;
	el("announce-hint").classList.toggle("text-amber-300", !!problem);
	el("announce-send").disabled = el("announce-test").disabled = !!problem;

	el("announce-preview").innerHTML = `<div class="bg-zinc-900 rounded-2xl px-4 py-3 flex items-start gap-3">
			<span class="material-symbols-outlined text-xl text-purple-400 flex-shrink-0 mt-0.5">campaign</span>
			<div class="min-w-0">
				<div class="text-sm font-semibold break-words">${escHtml(draft.title || "Title")}</div>
				<div class="text-xs text-zinc-400 break-words">${escHtml(draft.body || "Your message appears here.")}</div>
				<div class="text-[11px] text-zinc-600 mt-0.5">In the inbox · opens ${escHtml(draft.link && linkOk ? draft.link : "the notifications page")}</div>
			</div>
		</div>
		${
			banner
				? `<div class="site-announcement mt-2" style="position:static;width:auto;animation:none">
					<span class="site-announcement-icon" aria-hidden="true"><span class="material-symbols-outlined">campaign</span></span>
					<div class="site-announcement-text">
						<div class="site-announcement-title">${escHtml(draft.title || "Title")}</div>
						<div class="site-announcement-body">${escHtml(draft.body || "Your message appears here.")}</div>
						${draft.link && linkOk ? '<span class="site-announcement-link">Take a look</span>' : ""}
					</div>
					<span class="m-icon-btn" aria-hidden="true"><span class="material-symbols-outlined">close</span></span>
				</div>
				<div class="text-[11px] text-zinc-600 mt-1">The banner, in the bottom corner of every page</div>`
				: ""
		}`;
}

async function sendAnnouncement(test) {
	const draft = announcementDraft();
	if (!test) {
		const [audience] = AUDIENCE_LABELS[draft.audience] || ["Everyone"];
		const reach = _announcements?.audiences?.[draft.audience] ?? 0;
		const ok = await showConfirm(
			"Send this announcement?",
			`"${draft.title}" goes to ${audience.toLowerCase()} (${reach.toLocaleString()} account${reach === 1 ? "" : "s"})${draft.banner_hours ? ` and is pinned to every page for ${BANNER_LABELS[draft.banner_hours].toLowerCase()}` : ""}. Notifications cannot be taken back once sent.`,
			{ confirmLabel: "Send", confirmClass: "bg-blue-600 hover:bg-blue-500" }
		);
		if (!ok) return;
	}
	try {
		const { sent } = await api("/api/admin/announcements", { json: { ...draft, test } });
		if (test) return showToast("Test sent. Check your notifications.", "success");
		showToast(`Announcement sent to ${sent.toLocaleString()} account${sent === 1 ? "" : "s"}.`, "success");
		for (const id of ["announce-title", "announce-body", "announce-link"]) el(id).value = "";
		await loadAnnouncements();
		if (draft.banner_hours) checkAnnouncement();
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function endAnnouncementBanner(id) {
	if (
		!(await showConfirm(
			"Take this banner down?",
			"It disappears from every page. The notifications already sent stay in people's inboxes.",
			{
				confirmLabel: "Take down",
			}
		))
	)
		return;
	try {
		await api(`/api/admin/announcements/${id}/end-banner`, { method: "POST" });
		showToast("Banner taken down.", "success");
		await loadAnnouncements();
		checkAnnouncement();
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function toggleLocation(id, currentActive) {
	try {
		const r = await fetch(`/api/admin/locations/${id}/toggle`, { method: "POST" });
		if (!r.ok) throw new Error(await r.text());
		loadLocations();
	} catch (err) {
		showToast(err.message || "Failed to toggle.", "error");
	}
}

async function deleteLocation(id) {
	const ok = await showConfirm("Delete location", "This will permanently remove the location and cannot be undone.", {
		confirmLabel: "Delete",
	});
	if (!ok) return;
	try {
		const r = await fetch(`/api/admin/locations/${id}`, { method: "DELETE" });
		if (!r.ok) throw new Error(await r.text());
		el(`loc-${id}`)?.remove();
		showToast("Location deleted.", "success");
	} catch (err) {
		showToast(err.message || "Failed to delete.", "error");
	}
}
