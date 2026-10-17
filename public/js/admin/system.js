import { el, escHtml } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { renderMaintenanceBanner } from "../lib/notices.js";
import { showConfirm } from "./core.js";
import { shortAgo } from "./overview.js";
import { formatWhen } from "./users.js";

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

export function systemCard(title, icon, body, actions = "") {
	return `<section class="bg-zinc-900 rounded-2xl p-5 mb-4">
		<div class="flex items-center justify-between gap-3 mb-3 flex-wrap">
			<h2 class="font-bold flex items-center gap-2"><span class="material-symbols-outlined text-xl text-zinc-500">${icon}</span>${title}</h2>
			<div class="flex items-center gap-2">${actions}</div>
		</div>
		${body}
	</section>`;
}

export async function loadSystem() {
	clearInterval(systemUpdatePoll);
	el("tab-content").innerHTML = `
		<div id="system-info"></div>
		<div id="system-maintenance"></div>
		<div id="system-features"></div>
		<div id="system-update"></div>
		<div id="system-backups"></div>
		<div id="system-breakdown"></div>
		<div id="system-logs"></div>`;
	loadBreakdown();
	loadSystemInfo();
	loadMaintenance();
	loadFeatures();
	loadUpdate(false);
	loadBackups();
	loadSystemLogs();
}

/** Breakdown: what is wrong, what might be, what is coming up */

const FINDING_LOOK = {
	problem: ["error", "text-red-400", "Needs attention"],
	warning: ["warning", "text-amber-300", "Worth a look"],
	upcoming: ["schedule", "text-blue-400", "Coming up"],
	info: ["info", "text-zinc-500", "Good to know"],
};

async function loadBreakdown() {
	const box = el("system-breakdown");
	if (!box) return;
	let findings;
	try {
		findings = await api("/api/admin/system/breakdown");
	} catch {
		return;
	}
	const groups = Object.keys(FINDING_LOOK)
		.map((level) => [level, findings.filter((finding) => finding.level === level)])
		.filter(([, list]) => list.length);
	const row = (f) => {
		const [icon, tone] = FINDING_LOOK[f.level];
		return `<div class="flex items-start gap-2.5 py-2 border-b border-zinc-800 last:border-0">
			<span class="material-symbols-outlined text-lg leading-5 flex-shrink-0 ${tone}">${icon}</span>
			<div class="flex-1 min-w-0">
				<div class="text-sm break-words">${escHtml(f.title)}${f.count > 1 ? ` <span class="m-tag ml-1">${f.count.toLocaleString()} times</span>` : ""}</div>
				${f.detail ? `<div class="text-xs text-zinc-500 break-words">${escHtml(f.detail)}</div>` : ""}
			</div>
			${f.at ? `<span class="text-xs text-zinc-600 flex-shrink-0">${f.at > Date.now() / 1000 ? formatWhen(f.at) : `${shortAgo(f.at)} ago`}</span>` : ""}
			${f.tab ? `<button data-on-click="switchTab('${f.tab}')" class="m-btn m-btn-text m-btn-sm flex-shrink-0 -my-1">Open</button>` : ""}
		</div>`;
	};
	const urgent = findings.filter((f) => f.level === "problem").length;
	box.innerHTML = systemCard(
		"Breakdown",
		"checklist",
		groups.length
			? groups
					.map(
						([level, list]) =>
							`<div class="text-xs text-zinc-500 uppercase tracking-wider font-medium mt-3 first:mt-0">${FINDING_LOOK[level][2]}</div>${list.map(row).join("")}`
					)
					.join("")
			: '<p class="text-sm text-zinc-400">Nothing to report. Everything is running as it should.</p>',
		`${urgent ? `<span class="m-tag danger">${urgent} to fix</span>` : '<span class="m-tag success">No problems</span>'}
		<button data-on-click="loadBreakdown()" class="m-icon-btn" aria-label="Refresh" title="Refresh"><span class="material-symbols-outlined">refresh</span></button>`
	);
}

/** Overview */

async function loadSystemInfo() {
	const box = el("system-info");
	if (!box) return;
	try {
		const info = await api("/api/admin/system/info");
		const stat = (label, value, sub = "") =>
			`<div class="bg-zinc-800/60 rounded-xl px-3.5 py-2.5"><div class="text-xs text-zinc-500">${label}</div><div class="font-semibold mt-0.5">${value}</div>${sub ? `<div class="text-xs text-zinc-500 mt-0.5">${sub}</div>` : ""}</div>`;
		box.innerHTML = systemCard(
			"Server",
			"dns",
			`<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
				${stat("Running for", formatUptime(info.uptime), info.supervised ? "Managed by PM2" : "No process manager")}
				${stat("Memory", formatBytes(info.memory), info.runtime)}
				${stat("Database", formatBytes(info.database), `${info.backups.files} backups, ${formatBytes(info.backups.bytes)}`)}
				${stat("Screenshots", info.uploads.files.toLocaleString(), formatBytes(info.uploads.bytes))}
				${stat("Duels in memory", info.live.duel_rooms)}
				${stat("Team rooms", info.live.team_rooms)}
				${stat("Solo games held", info.live.solo_games)}
				${stat("Errors, last 24h", info.logs.errors_24h, info.logs.errors_24h ? "See the log below" : "")}
			</div>`,
			`<button data-on-click="loadSystemInfo()" class="m-icon-btn" title="Refresh" aria-label="Refresh"><span class="material-symbols-outlined">refresh</span></button>`
		);
	} catch (err) {
		box.innerHTML = systemCard("Server", "dns", `<p class="text-red-300 text-sm">${escHtml(err.message)}</p>`);
	}
}

/** Maintenance mode */

async function loadMaintenance() {
	const box = el("system-maintenance");
	const state = await api("/api/admin/system/maintenance").catch(() => null);
	if (!state || !box) return;
	box.innerHTML = systemCard(
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
					? '<button data-on-click="setMaintenanceMode(false)" class="m-btn m-btn-filled">Switch off and reopen the site</button>'
					: '<button data-on-click="setMaintenanceMode(true)" class="m-btn m-btn-tonal">Switch on</button>'
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

/** Feature switches */

const FEATURE_INFO = {
	duel_emotes: [
		"Duel reactions",
		"The preset icons players can send each other during a duel. Switch off if they are being used to annoy people.",
	],
	tournament_chat: [
		"Tournament chat",
		"Spectator chat on tournament pages. Each tournament also has its own switch, off until staff turn it on.",
	],
	submissions: ["Submissions", "Players sending in new locations. Staff can still submit while it is off."],
	suggestions: ["Suggestions", "Players suggesting changes to existing locations."],
	new_duels: ["New duels", "Starting duels, Quick Play and team games. Games already open carry on to the end."],
	signups: [
		"New accounts",
		"People logging in for the first time. Everyone who already has an account is unaffected.",
	],
};

async function loadFeatures() {
	const box = el("system-features");
	const state = await api("/api/admin/system/features").catch(() => null);
	if (!state || !box) return;
	box.innerHTML = systemCard(
		"Features",
		"toggle_on",
		Object.entries(FEATURE_INFO)
			.map(
				([key, [title, blurb]]) => `<div class="flex items-center gap-3 py-1.5">
					<div class="flex-1 min-w-0">
						<div class="text-sm font-semibold">${title} ${state[key] ? '<span class="m-tag success ml-1">On</span>' : '<span class="m-tag ml-1">Off</span>'}</div>
						<div class="text-xs text-zinc-500">${blurb}</div>
					</div>
					<button data-on-click="setFeature('${key}', ${!state[key]})" class="m-btn m-btn-tonal m-btn-sm flex-shrink-0">${state[key] ? "Switch off" : "Switch on"}</button>
				</div>`
			)
			.join("") +
			`<div class="flex items-center gap-3 mt-3 pt-3 border-t border-zinc-800">
				<div class="flex-1 min-w-0">
					<div class="text-sm font-semibold">Achievements from history</div>
					<div class="text-xs text-zinc-500">Gives players any achievement their saved scores, streaks and duels show they earned. Done automatically once; run it again after restoring or correcting scores. Nothing is taken away.</div>
				</div>
				<button data-on-click="backfillAchievementsNow()" class="m-btn m-btn-tonal m-btn-sm flex-shrink-0">Recalculate</button>
			</div>`
	);
}

async function backfillAchievementsNow() {
	try {
		const { given } = await api("/api/admin/system/achievements/backfill", { method: "POST" });
		showToast(
			given ? `${given} achievement${given === 1 ? "" : "s"} given` : "Everyone already has what they earned",
			"success"
		);
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function setFeature(feature, enabled) {
	try {
		await api("/api/admin/system/features", { json: { feature, enabled } });
		showToast(
			enabled
				? "Switched on"
				: feature === "duel_emotes"
					? "Switched off. Duels already open keep it until their next update."
					: "Switched off",
			"success"
		);
		loadFeatures();
	} catch (err) {
		showToast(err.message, "error");
	}
}

/** Updates */

async function loadUpdate(refresh) {
	clearInterval(systemUpdatePoll);
	const box = el("system-update");
	if (!box) return;
	const check = `<button data-on-click="loadUpdate(true)" class="m-btn m-btn-tonal m-btn-sm"><span class="material-symbols-outlined">sync</span>Check for updates</button>`;
	let status;
	try {
		if (refresh) box.querySelector("button")?.setAttribute("disabled", "");
		status = await api(`/api/admin/system/update${refresh ? "?refresh=1" : ""}`);
	} catch (err) {
		/** While the server restarts it is not there at all; keep asking until it is back. */
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
	if (box.dataset.restarting && status.job && status.job.state !== "restarting") {
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
	const jobLog = job.state !== "idle" ? updateJobHtml(job, status.restart_in) : "";
	/** A redraw must not throw the reader back to the top of the output, or away from its end. */
	const oldLog = box.querySelector(".update-log");
	const followEnd = !oldLog || oldLog.scrollTop + oldLog.clientHeight >= oldLog.scrollHeight - 8;
	const keptScroll = oldLog?.scrollTop ?? 0;

	box.innerHTML = systemCard(
		"Updates",
		"system_update_alt",
		`<div class="text-xs text-zinc-500 mb-3">Running ${status.current ? `<code>${escHtml(status.current.hash.slice(0, 7))}</code> ${escHtml(status.current.subject)}` : "an unknown version"} on <code>${escHtml(status.branch)}</code></div>
		${blockers.map((b) => `<p class="text-sm text-amber-300 mb-2">${escHtml(b)}</p>`).join("")}
		${jobLog}
		${pending}
		<div class="flex items-center justify-end gap-2 flex-wrap">
			${job.state === "restarting" && status.restart_in ? '<button data-on-click="cancelRestartNow()" class="m-btn m-btn-tonal">Cancel restart</button>' : ""}
			${status.supervised ? `<button data-on-click="restartServerNow()" class="m-btn m-btn-text" ${busy ? "disabled" : ""}>Restart server</button>` : '<span class="text-xs text-zinc-500 mr-auto">Not running under PM2, so the panel cannot restart the server.</span>'}
			<button data-on-click="installUpdate(${status.pending.length})" class="m-btn m-btn-filled" ${busy || blockers.length || !status.pending.length ? "disabled" : ""}>
				<span class="material-symbols-outlined">download</span>${status.supervised ? "Update and restart" : "Install update"}
			</button>
		</div>`,
		check
	);
	const newLog = box.querySelector(".update-log");
	if (newLog) newLog.scrollTop = followEnd ? newLog.scrollHeight : keptScroll;
	if (busy) systemUpdatePoll = setInterval(() => loadUpdate(false), 1500);
}

const UPDATE_STEP_ICONS = {
	waiting: ["radio_button_unchecked", "text-zinc-600"],
	running: ["progress_activity", "text-blue-400 animate-spin"],
	done: ["check_circle", "text-green-400"],
	failed: ["error", "text-red-400"],
};

/** "1m 05s", or "12s" under a minute. */
const durationText = (seconds) =>
	seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;

/** The update in progress, or the last one: what it is doing, each step, and everything it printed. */
function updateJobHtml(job, restartIn) {
	const now = Math.floor(Date.now() / 1000);
	const took = job.started_at ? durationText((job.ended_at ?? now) - job.started_at) : "";
	const what =
		job.kind === "restart"
			? "Restart"
			: `Update${job.from && job.to ? ` <code class="text-xs">${escHtml(job.from)}</code> to <code class="text-xs">${escHtml(job.to)}</code>` : ""}`;
	const headline = {
		running: `<span class="material-symbols-outlined text-base text-blue-400 animate-spin">progress_activity</span>Busy: ${escHtml(job.step || "starting")} <span class="text-zinc-500 font-normal">(${took} so far)</span>`,
		restarting: `<span class="material-symbols-outlined text-base text-amber-300 animate-spin">progress_activity</span>${escHtml(job.step)}${restartIn !== null ? ` <span class="text-zinc-500 font-normal">(${restartIn}s)</span>` : ""}`,
		failed: `<span class="material-symbols-outlined text-base text-red-400">error</span><span class="text-red-300">Failed at "${escHtml(job.step)}". The server was not restarted.</span>`,
		needs_restart: `<span class="material-symbols-outlined text-base text-amber-300">restart_alt</span>${escHtml(job.step)}`,
		done: `<span class="material-symbols-outlined text-base text-green-400">check_circle</span>${escHtml(job.step)}${job.ended_at ? ` <span class="text-zinc-500 font-normal">${formatWhen(job.ended_at)}</span>` : ""}`,
	}[job.state];
	const steps = job.steps?.length
		? `<ol class="grid gap-1 my-2">${job.steps
				.map((step) => {
					const [icon, tone] = UPDATE_STEP_ICONS[step.state] ?? UPDATE_STEP_ICONS.waiting;
					const time = step.started_at ? durationText((step.ended_at ?? now) - step.started_at) : "";
					return `<li class="flex items-center gap-2 text-sm ${step.state === "waiting" ? "text-zinc-500" : ""}">
						<span class="material-symbols-outlined text-base ${tone}">${icon}</span>
						<span class="flex-1">${escHtml(step.name)}</span>
						<span class="text-xs text-zinc-500 tabular-nums">${time}</span>
					</li>`;
				})
				.join("")}</ol>`
		: "";
	return `<div class="bg-black/30 rounded-xl p-3 mb-3">
		<div class="text-sm font-semibold flex items-center gap-2 flex-wrap">${headline}</div>
		<div class="text-xs text-zinc-500 mt-0.5">${what}${job.started_by ? `, started by ${escHtml(job.started_by)}` : ""}${took && job.state !== "running" ? `, took ${took}` : ""}</div>
		${steps}
		${job.log?.length ? `<pre class="update-log text-xs text-zinc-400 whitespace-pre-wrap max-h-72 overflow-y-auto bg-black/30 rounded-lg p-2">${escHtml(job.log.join("\n"))}</pre>` : ""}
	</div>`;
}

async function installUpdate(count) {
	const ok = await showConfirm(
		`Install ${count} update${count === 1 ? "" : "s"}?`,
		"The database is backed up first, then the update is downloaded. Players get a warning with a countdown: up to 3 minutes while duels or team games are being played, so they can finish, and sooner once they have. Any still open are then closed, and the server restarts. Solo games carry on afterwards.",
		{ confirmLabel: "Update", confirmClass: "m-btn-filled" }
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
			"Players get a warning with a countdown: up to 3 minutes while duels or team games are being played, so they can finish, and sooner once they have. Any still open are then closed. Solo games carry on afterwards. The site is back within a few seconds.",
			{ confirmLabel: "Restart" }
		))
	)
		return;
	try {
		await api("/api/admin/system/restart", { json: { confirm: true } });
		el("system-update").dataset.restarting = "1";
		showToast("Restarting...");
		systemUpdatePoll = setInterval(() => loadUpdate(false), 2000);
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function cancelRestartNow() {
	try {
		await api("/api/admin/system/restart/cancel", { method: "POST" });
		delete el("system-update")?.dataset.restarting;
		showToast("Restart called off", "success");
	} catch (err) {
		showToast(err.message, "error");
	}
	loadUpdate(false);
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
					<button data-on-click="deleteBackupFile('${escHtml(b.name)}')" class="m-icon-btn" title="Delete" aria-label="Delete ${escHtml(b.name)}"><span class="material-symbols-outlined">delete</span></button>
				</div>`
			)
			.join("");
		box.innerHTML = systemCard(
			"Backups",
			"backup",
			`<p class="text-xs text-zinc-500 mb-2">Kept automatically: the last ${limits.daily} daily, ${limits.upgrade} before upgrades, ${limits.update} before updates and ${limits.manual} manual. Older ones are removed. A backup holds every account, so downloads are logged.</p>
			<div class="divide-y divide-zinc-800">${rows || '<p class="text-zinc-500 text-sm py-3">No backups yet. The first daily one is made within the hour.</p>'}</div>`,
			`<button data-on-click="makeBackup()" class="m-btn m-btn-tonal m-btn-sm"><span class="material-symbols-outlined">add</span>Back up now</button>`
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
		if (!box.isConnected) return;
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
	/** The tab was redrawn or left while the request was out; the newer load owns the page now. */
	if (!box.isConnected) return;
	if (before) {
		el("system-log-more")?.remove();
		el("system-log-rows").insertAdjacentHTML("beforeend", rows);
	} else {
		const level = (key, label) =>
			`<button data-on-click="setSystemLogLevel('${key}')" aria-pressed="${systemLogLevel === key}">${label}${key && data.counts[key] ? ` <span class="count">${data.counts[key]}</span>` : ""}</button>`;
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
			`<button data-on-click="loadSystemLogs()" class="m-icon-btn" title="Refresh" aria-label="Refresh"><span class="material-symbols-outlined">refresh</span></button>
			<button data-on-click="clearSystemLogs()" class="m-icon-btn" title="Clear the log" aria-label="Clear the log"><span class="material-symbols-outlined">delete_sweep</span></button>`
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
			`<div id="system-log-more" class="text-center mt-3"><button data-on-click="loadSystemLogs(${last})" class="m-btn m-btn-text m-btn-sm">Show older</button></div>`
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

Object.assign(window, {
	backfillAchievementsNow,
	cancelRestartNow,
	clearSystemLogs,
	deleteBackupFile,
	installUpdate,
	loadBreakdown,
	loadSystemInfo,
	loadSystemLogs,
	loadUpdate,
	makeBackup,
	restartServerNow,
	setFeature,
	setMaintenanceMode,
	setSystemLogLevel,
});
