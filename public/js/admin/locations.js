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
        ${panelSearchInput("Search location ID, label, filename, hints or status…")}
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
        <input type="text" placeholder="Hint text…" class="hint-input flex-1 bg-zinc-800 rounded px-2 py-1 text-xs focus:outline-none" data-idx="${idx}" data-loc="${locId}" />
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

async function loadStats() {
	try {
		const r = await fetch("/api/admin/stats");
		if (!r.ok) throw new Error();
		renderStats(await r.json());
	} catch {
		el("tab-content").innerHTML = '<div class="text-red-400">Failed to load stats.</div>';
	}
}

function renderStats(s) {
	const statCard = (label, value, sub) => `
        <div class="bg-zinc-900 rounded-2xl px-5 py-4 text-center">
            <div class="text-2xl font-bold font-mono">${value}</div>
            <div class="text-zinc-400 text-sm mt-1">${label}</div>
            ${sub ? `<div class="text-zinc-600 text-xs mt-0.5">${sub}</div>` : ""}
        </div>`;
	el("tab-content").innerHTML = `
        <h2 class="font-bold text-lg mb-4">Site Stats</h2>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
            ${statCard("Total Users", (s.users?.total ?? 0).toLocaleString())}
            ${statCard("Active Locations", (s.locations?.active ?? 0).toLocaleString(), `${s.locations?.total ?? 0} total`)}
            ${statCard("Solo Games", (s.scores?.total_games ?? 0).toLocaleString())}
            ${statCard("Duel Rooms", (s.duels?.total_rooms ?? 0).toLocaleString())}
            ${statCard("Daily Plays", (s.daily?.total_plays ?? 0).toLocaleString())}
            ${statCard("Pending Submissions", (s.submissions?.pending ?? 0).toLocaleString(), `${s.submissions?.total ?? 0} total`)}
        </div>
        <h3 class="font-semibold text-zinc-300 mb-3">Recent Activity</h3>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
            ${statCard("New Users (7d)", (s.users?.last_7d ?? 0).toLocaleString())}
            ${statCard("Games (7d)", (s.scores?.last_7d ?? 0).toLocaleString())}
            ${statCard("Daily Plays (7d)", (s.daily?.last_7d ?? 0).toLocaleString())}
        </div>
        ${
			currentUser.role === "operator"
				? `<h3 class="font-semibold text-zinc-300 mt-8 mb-1">Announcement</h3>
        <p class="text-zinc-500 text-xs mb-3">Sends a notification to every account. Use it for rule or policy changes, planned downtime and new features.</p>
        <div class="bg-zinc-900 rounded-2xl p-4 max-w-xl flex flex-col gap-2">
            <input id="announce-title" maxlength="120" placeholder="Title" class="bg-zinc-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600" />
            <textarea id="announce-body" rows="3" maxlength="400" placeholder="Message" class="bg-zinc-800 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-zinc-600"></textarea>
            <button onclick="sendAnnouncement()" class="self-end bg-blue-600 hover:bg-blue-500 transition px-4 py-2 rounded-xl text-sm font-semibold">Send to everyone</button>
        </div>`
				: ""
		}`;
}

async function sendAnnouncement() {
	const title = el("announce-title").value.trim();
	const body = el("announce-body").value.trim();
	const ok = await showConfirm(
		"Send announcement",
		`"${title}" will be sent to every account. This cannot be taken back.`,
		{
			confirmLabel: "Send",
			confirmClass: "bg-blue-600 hover:bg-blue-500",
		}
	);
	if (!ok) return;
	try {
		const { sent } = await api("/api/admin/announcements", { json: { title, body } });
		showToast(`Announcement sent to ${sent} account${sent === 1 ? "" : "s"}.`, "success");
		el("announce-title").value = el("announce-body").value = "";
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
