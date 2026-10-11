/* ---- System (operators): maintenance mode, updates, backups and the server log ---- */

let systemLogLevel = "";
let systemLogSearch = "";
let systemUpdatePoll = null;

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatUptime(seconds) {
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function systemCard(title, icon, body, actions = "") {
	return `<section class="bg-zinc-900 rounded-2xl p-5 mb-4">
		<div class="flex items-center justify-between gap-3 mb-3 flex-wrap">
			<h2 class="font-bold flex items-center gap-2"><span class="material-symbols-outlined text-xl text-zinc-500">${icon}</span>${title}</h2>
			<div class="flex items-center gap-2">${actions}</div>
		</div>
		${body}
	</section>`;
}

async function loadSystem() {
	clearInterval(systemUpdatePoll);
	el("tab-content").innerHTML = `
		<div id="system-info"></div>
		<div id="system-maintenance"></div>
		<div id="system-update"></div>
		<div id="system-backups"></div>
		<div id="system-logs"></div>`;
	loadSystemInfo();
	loadMaintenance();
	loadUpdate(false);
	loadBackups();
	loadSystemLogs();
}

/** Overview */

async function loadSystemInfo() {
	try {
		const info = await api("/api/admin/system/info");
		const stat = (label, value, sub = "") =>
			`<div class="bg-zinc-800/60 rounded-xl px-3.5 py-2.5"><div class="text-xs text-zinc-500">${label}</div><div class="font-semibold mt-0.5">${value}</div>${sub ? `<div class="text-xs text-zinc-500 mt-0.5">${sub}</div>` : ""}</div>`;
		el("system-info").innerHTML = systemCard(
			"Server",
			"dns",
			`<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
				${stat("Running for", formatUptime(info.uptime), info.supervised ? "Managed by PM2" : "No process manager")}
				${stat("Memory", formatBytes(info.memory), info.runtime)}
				${stat("Database", formatBytes(info.database), `${info.backups.files} backups, ${formatBytes(info.backups.bytes)}`)}
				${stat("Screenshots", info.uploads.files.toLocaleString(), formatBytes(info.uploads.bytes))}
				${stat("Duels in memory", info.live.duel_rooms)}
				${stat("Team rooms", info.live.team_rooms)}
				${stat("Solo games", info.live.solo_games)}
				${stat("Errors, last 24h", info.logs.errors_24h, info.logs.errors_24h ? "See the log below" : "")}
			</div>`,
			`<button onclick="loadSystemInfo()" class="m-icon-btn" title="Refresh" aria-label="Refresh"><span class="material-symbols-outlined">refresh</span></button>`
		);
	} catch (err) {
		el("system-info").innerHTML = systemCard(
			"Server",
			"dns",
			`<p class="text-red-300 text-sm">${escHtml(err.message)}</p>`
		);
	}
}

/** Maintenance mode */

async function loadMaintenance() {
	const state = await api("/api/admin/system/maintenance").catch(() => null);
	if (!state) return;
	el("system-maintenance").innerHTML = systemCard(
		"Maintenance mode",
		"construction",
		`<p class="text-sm text-zinc-400 mb-3">${
			state.enabled
				? `<span class="m-tag warn mr-1.5">On</span>Only staff can use the site. Switched on by ${escHtml(state.by || "staff")}, ${formatWhen(state.since)}.`
				: "While it is on, only staff can use the site. Everyone else sees a maintenance screen, and games in progress stop."
		}</p>
		<label class="m-label" for="maintenance-message">Message shown to players</label>
		<input id="maintenance-message" class="m-field mb-3" maxlength="300" placeholder="${escHtml(state.default_message)}" value="${escHtml(state.message || "")}" />
		<div class="flex justify-end">
			${
				state.enabled
					? '<button onclick="setMaintenanceMode(false)" class="m-btn m-btn-filled">Switch off and reopen the site</button>'
					: '<button onclick="setMaintenanceMode(true)" class="m-btn m-btn-tonal">Switch on</button>'
			}
		</div>`
	);
}

async function setMaintenanceMode(enabled) {
	if (
		enabled &&
		!(await showConfirm(
			"Switch on maintenance mode?",
			"Players will be locked out at once, including any who are mid-game. Staff can carry on.",
			{
				confirmLabel: "Switch on",
			}
		))
	)
		return;
	try {
		await api("/api/admin/system/maintenance", { json: { enabled, message: el("maintenance-message").value } });
		showToast(enabled ? "Maintenance mode is on" : "The site is open again", "success");
		loadMaintenance();
		renderMaintenanceBanner(enabled ? el("maintenance-message").value || true : false);
	} catch (err) {
		showToast(err.message, "error");
	}
}

/** Updates */

async function loadUpdate(refresh) {
	clearInterval(systemUpdatePoll);
	const box = el("system-update");
	if (!box) return;
	const check = `<button onclick="loadUpdate(true)" class="m-btn m-btn-tonal m-btn-sm"><span class="material-symbols-outlined">sync</span>Check for updates</button>`;
	let status;
	try {
		if (refresh) box.querySelector("button")?.setAttribute("disabled", "");
		status = await api(`/api/admin/system/update${refresh ? "?refresh=1" : ""}`);
	} catch (err) {
		// While the server restarts it is simply not there; keep asking until it is back.
		if (box.dataset.restarting) {
			systemUpdatePoll = setInterval(() => loadUpdate(false), 2000);
			return;
		}
		box.innerHTML = systemCard(
			"Updates",
			"system_update_alt",
			`<p class="text-red-300 text-sm">${escHtml(err.message)}</p>`,
			check
		);
		return;
	}
	if (box.dataset.restarting && status.job?.state === "idle") {
		delete box.dataset.restarting;
		showToast("The server is back up", "success");
		loadSystemInfo();
	}
	if (!status.available) {
		box.innerHTML = systemCard(
			"Updates",
			"system_update_alt",
			`<p class="text-sm text-zinc-400">${escHtml(status.reason)}</p>`
		);
		return;
	}

	const commitRow = (c) => `<div class="flex items-baseline gap-3 py-1.5 text-sm">
		<code class="text-xs text-zinc-500 flex-shrink-0">${escHtml(c.hash.slice(0, 7))}</code>
		<span class="flex-1 min-w-0 truncate">${escHtml(c.subject)}</span>
		<span class="text-xs text-zinc-500 flex-shrink-0">${escHtml(c.author)}, ${new Date(c.date * 1000).toLocaleDateString()}</span>
	</div>`;
	const job = status.job;
	const busy = job.state === "running" || job.state === "restarting";
	if (job.state === "restarting") box.dataset.restarting = "1";

	const blockers = [
		!status.enabled ? "Updates from the panel are switched off on this server (PANEL_UPDATES=off)." : "",
		status.local_changes
			? `${status.local_changes} file(s) on the server have been edited by hand. Commit or discard them before updating.`
			: "",
		status.ahead ? "The server has commits that the remote does not." : "",
		status.fetch_error ? `Could not reach the remote: ${status.fetch_error}` : "",
	].filter(Boolean);

	const pending = status.pending.length
		? `<div class="text-sm text-zinc-300 mb-1">${status.pending.length} update${status.pending.length === 1 ? "" : "s"} waiting on <code class="text-xs">${escHtml(status.tracking)}</code></div>
			<div class="divide-y divide-zinc-800 max-h-64 overflow-y-auto mb-3">${status.pending.map(commitRow).join("")}</div>`
		: `<p class="text-sm text-zinc-400 mb-3">${status.checked_at ? "Up to date." : "Press Check for updates to ask GitHub what is new."}</p>`;
	const jobLog =
		job.state !== "idle"
			? `<div class="bg-black/30 rounded-xl p-3 mb-3">
				<div class="text-sm font-semibold mb-1 ${job.state === "failed" ? "text-red-300" : ""}">${
					job.state === "failed"
						? `Update failed at "${escHtml(job.step)}". The server was not restarted.`
						: escHtml(job.step || "Starting")
				}</div>
				<pre class="text-xs text-zinc-400 whitespace-pre-wrap max-h-48 overflow-y-auto">${escHtml(job.log.join("\n"))}</pre>
			</div>`
			: "";

	box.innerHTML = systemCard(
		"Updates",
		"system_update_alt",
		`<div class="text-xs text-zinc-500 mb-3">Running ${status.current ? `<code>${escHtml(status.current.hash.slice(0, 7))}</code> ${escHtml(status.current.subject)}` : "an unknown version"} on <code>${escHtml(status.branch)}</code></div>
		${blockers.map((b) => `<p class="text-sm text-amber-300 mb-2">${escHtml(b)}</p>`).join("")}
		${jobLog}
		${pending}
		<div class="flex items-center justify-end gap-2 flex-wrap">
			${status.supervised ? `<button onclick="restartServerNow()" class="m-btn m-btn-text" ${busy ? "disabled" : ""}>Restart server</button>` : '<span class="text-xs text-zinc-500 mr-auto">Not running under PM2, so the panel cannot restart the server.</span>'}
			<button onclick="installUpdate(${status.pending.length})" class="m-btn m-btn-filled" ${busy || blockers.length || !status.pending.length ? "disabled" : ""}>
				<span class="material-symbols-outlined">download</span>${status.supervised ? "Update and restart" : "Install update"}
			</button>
		</div>`,
		check
	);
	if (busy) systemUpdatePoll = setInterval(() => loadUpdate(false), 2000);
}

async function installUpdate(count) {
	const ok = await showConfirm(
		`Install ${count} update${count === 1 ? "" : "s"}?`,
		"The database is backed up first. The server then downloads the update and restarts, which ends every game in progress.",
		{ confirmLabel: "Update", confirmClass: "bg-blue-600 hover:bg-blue-500" }
	);
	if (!ok) return;
	try {
		await api("/api/admin/system/update", { json: { confirm: true } });
		loadUpdate(false);
	} catch (err) {
		showToast(err.message, "error");
		loadUpdate(false);
	}
}

async function restartServerNow() {
	if (
		!(await showConfirm(
			"Restart the server?",
			"Every game in progress ends. The site is back within a few seconds.",
			{ confirmLabel: "Restart" }
		))
	)
		return;
	try {
		await api("/api/admin/system/restart", { json: { confirm: true } });
		el("system-update").dataset.restarting = "1";
		showToast("Restarting…");
		systemUpdatePoll = setInterval(() => loadUpdate(false), 2000);
	} catch (err) {
		showToast(err.message, "error");
	}
}

/** Backups */

const BACKUP_KIND_LABELS = { daily: "Daily", upgrade: "Before upgrade", update: "Before update", manual: "Manual" };

async function loadBackups() {
	const box = el("system-backups");
	if (!box) return;
	try {
		const { backups, limits } = await api("/api/admin/system/backups");
		const rows = backups
			.map(
				(b) => `<div class="flex items-center gap-3 py-2 text-sm flex-wrap">
					<span class="m-tag">${BACKUP_KIND_LABELS[b.kind] || b.kind}</span>
					<span class="flex-1 min-w-0 truncate font-mono text-xs text-zinc-400">${escHtml(b.name)}</span>
					<span class="text-xs text-zinc-500">${formatWhen(b.created_at)} · ${formatBytes(b.size)}</span>
					<a href="/api/admin/system/backups/${encodeURIComponent(b.name)}/download" class="m-icon-btn" title="Download" aria-label="Download ${escHtml(b.name)}"><span class="material-symbols-outlined">download</span></a>
					<button onclick="deleteBackupFile('${escHtml(b.name)}')" class="m-icon-btn" title="Delete" aria-label="Delete ${escHtml(b.name)}"><span class="material-symbols-outlined">delete</span></button>
				</div>`
			)
			.join("");
		box.innerHTML = systemCard(
			"Backups",
			"backup",
			`<p class="text-xs text-zinc-500 mb-2">Kept automatically: the last ${limits.daily} daily, ${limits.upgrade} before upgrades, ${limits.update} before updates and ${limits.manual} manual. Older ones are removed. A backup holds every account, so downloads are logged.</p>
			<div class="divide-y divide-zinc-800">${rows || '<p class="text-zinc-500 text-sm py-3">No backups yet. The first daily one is made within the hour.</p>'}</div>`,
			`<button onclick="makeBackup()" class="m-btn m-btn-tonal m-btn-sm"><span class="material-symbols-outlined">add</span>Back up now</button>`
		);
	} catch (err) {
		box.innerHTML = systemCard("Backups", "backup", `<p class="text-red-300 text-sm">${escHtml(err.message)}</p>`);
	}
}

async function makeBackup() {
	try {
		await api("/api/admin/system/backups", { method: "POST" });
		showToast("Backup made", "success");
		loadBackups();
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function deleteBackupFile(name) {
	if (
		!(await showConfirm("Delete this backup?", `${name} will be removed from the server for good.`, {
			confirmLabel: "Delete",
		}))
	)
		return;
	try {
		await api(`/api/admin/system/backups/${encodeURIComponent(name)}`, { method: "DELETE" });
		loadBackups();
	} catch (err) {
		showToast(err.message, "error");
	}
}

/** Server log */

const LOG_LEVEL_TONE = { error: "danger", warn: "warn", info: "" };

async function loadSystemLogs(before = 0) {
	const box = el("system-logs");
	if (!box) return;
	const query = new URLSearchParams({ limit: "100" });
	if (systemLogLevel) query.set("level", systemLogLevel);
	if (systemLogSearch) query.set("q", systemLogSearch);
	if (before) query.set("before", String(before));
	let data;
	try {
		data = await api(`/api/admin/system/logs?${query}`);
	} catch (err) {
		box.innerHTML = systemCard(
			"Server log",
			"terminal",
			`<p class="text-red-300 text-sm">${escHtml(err.message)}</p>`
		);
		return;
	}
	const rows = data.logs
		.map(
			(log) => `<details class="py-2 text-sm group">
				<summary class="flex items-baseline gap-2.5 cursor-pointer list-none">
					<span class="m-tag ${LOG_LEVEL_TONE[log.level] ?? ""} flex-shrink-0">${log.level}</span>
					<span class="flex-1 min-w-0 truncate group-open:whitespace-normal group-open:break-words">${escHtml(log.message)}</span>
					<span class="text-xs text-zinc-500 flex-shrink-0">${formatWhen(log.created_at)}</span>
				</summary>
				${log.detail ? `<pre class="text-xs text-zinc-400 whitespace-pre-wrap break-words bg-black/30 rounded-xl p-3 mt-2 max-h-72 overflow-y-auto">${escHtml(log.detail)}</pre>` : ""}
			</details>`
		)
		.join("");
	if (before) {
		el("system-log-more")?.remove();
		el("system-log-rows").insertAdjacentHTML("beforeend", rows);
	} else {
		const level = (key, label) =>
			`<button onclick="setSystemLogLevel('${key}')" aria-pressed="${systemLogLevel === key}">${label}${key && data.counts[key] ? ` <span class="count">${data.counts[key]}</span>` : ""}</button>`;
		box.innerHTML = systemCard(
			"Server log",
			"terminal",
			`<p class="text-xs text-zinc-500 mb-3">Warnings and errors from the server, plus starts, updates and restarts. Kept for 30 days, up to 3,000 entries.</p>
			<div class="flex items-center gap-2 mb-2 flex-wrap">
				<div class="m-segmented">${level("", "All")}${level("error", "Errors")}${level("warn", "Warnings")}${level("info", "Info")}</div>
				<label class="m-search flex-1 min-w-[10rem]">
					<span class="material-symbols-outlined">search</span>
					<input id="system-log-search" type="search" class="m-field" placeholder="Search the log" value="${escHtml(systemLogSearch)}" />
				</label>
			</div>
			<div class="divide-y divide-zinc-800" id="system-log-rows">${rows || '<p class="text-zinc-500 text-sm py-3">Nothing logged.</p>'}</div>`,
			`<button onclick="loadSystemLogs()" class="m-icon-btn" title="Refresh" aria-label="Refresh"><span class="material-symbols-outlined">refresh</span></button>
			<button onclick="clearSystemLogs()" class="m-icon-btn" title="Clear the log" aria-label="Clear the log"><span class="material-symbols-outlined">delete_sweep</span></button>`
		);
		let debounce;
		el("system-log-search").addEventListener("input", (e) => {
			clearTimeout(debounce);
			debounce = setTimeout(async () => {
				systemLogSearch = e.target.value.trim();
				await loadSystemLogs();
				const field = el("system-log-search");
				field.focus();
				field.setSelectionRange(field.value.length, field.value.length);
			}, 300);
		});
	}
	if (data.logs.length === 100) {
		const last = data.logs[data.logs.length - 1].id;
		el("system-log-rows").insertAdjacentHTML(
			"afterend",
			`<div id="system-log-more" class="text-center mt-3"><button onclick="loadSystemLogs(${last})" class="m-btn m-btn-text m-btn-sm">Show older</button></div>`
		);
	}
}

function setSystemLogLevel(level) {
	systemLogLevel = level;
	loadSystemLogs();
}

async function clearSystemLogs() {
	if (
		!(await showConfirm("Clear the server log?", "Every entry is removed. This is recorded in the audit log.", {
			confirmLabel: "Clear",
		}))
	)
		return;
	try {
		await api("/api/admin/system/logs", { method: "DELETE" });
		loadSystemLogs();
		loadSystemInfo();
	} catch (err) {
		showToast(err.message, "error");
	}
}
