import { el, escHtml } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { showPrompt } from "./core.js";
import { askReason, formatWhen } from "./users.js";
import { openUserPanel } from "./user-panel.js";

let _scoreTab = "solo";

export async function loadScoreManager(userId, list = _scoreTab) {
	_scoreTab = list;
	const box = el("score-manager");
	if (!box) return;
	let data;
	try {
		data = await api(`/api/admin/scores/${userId}`);
	} catch (err) {
		box.innerHTML = `<p class="text-red-300 text-sm">${escHtml(err.message)}</p>`;
		return;
	}
	const icon = (name, onclick, title) =>
		`<button data-on-click="${onclick}" class="m-icon-btn" title="${title}" aria-label="${title}"><span class="material-symbols-outlined">${name}</span></button>`;
	const row = (main, sub, actions) => `<div class="flex items-center gap-2 py-1.5">
		<div class="flex-1 min-w-0"><div class="text-sm font-mono">${main}</div><div class="text-[11px] text-zinc-500 truncate">${sub}</div></div>${actions}
	</div>`;
	const empty = '<p class="text-zinc-500 text-sm py-2">Nothing here.</p>';
	const lists = {
		solo: data.solo
			.map((s) =>
				row(
					`${s.total_score.toLocaleString()} <span class="text-zinc-500">/ ${s.max_possible.toLocaleString()}</span>`,
					`${s.rounds} rounds · ${s.time_limit ? `${s.time_limit}s` : "no limit"} · ${formatWhen(s.created_at)}`,
					icon(
						"edit",
						`editScore(${userId}, 'solo', ${s.id}, ${s.total_score}, ${s.max_possible})`,
						"Correct this score"
					) + icon("delete", `removeScore(${userId}, 'solo', ${s.id})`, "Remove this score")
				)
			)
			.join(""),
		daily: data.daily
			.map((d) =>
				row(
					d.score.toLocaleString(),
					`${escHtml(d.date)} · ${d.distance === null ? "no guess" : `${d.distance} studs`} · ${d.hints_used} hint${d.hints_used === 1 ? "" : "s"}`,
					icon("edit", `editScore(${userId}, 'daily', ${d.id}, ${d.score}, 5000)`, "Correct this score") +
						icon("delete", `removeScore(${userId}, 'daily', ${d.id})`, "Remove this score")
				)
			)
			.join(""),
		duels: data.duels
			.map((g) =>
				row(
					`${(g.score ?? 0).toLocaleString()} <span class="text-zinc-500">to ${(g.opponent_score ?? 0).toLocaleString()}</span> <span class="m-tag ${g.status !== "finished" ? "" : g.result === "win" ? "success" : g.result === "loss" ? "danger" : ""}">${g.status !== "finished" ? g.status : g.result}</span>`,
					`vs @${escHtml(g.opponent_username || "nobody")} · ${g.quickplay ? "Quick Play" : "room"} ${escHtml(g.room_code)} · ${formatWhen(g.finished_at || g.created_at)}`,
					g.status === "in_progress"
						? ""
						: icon("block", `removeScore(${userId}, 'duels', ${g.id})`, "Void this duel for both players")
				)
			)
			.join(""),
	};
	const counts = { solo: data.solo.length, daily: data.daily.length, duels: data.duels.length };
	const tab = (key, label) =>
		`<button data-on-click="loadScoreManager(${userId}, '${key}')" aria-pressed="${_scoreTab === key}">${label} <span class="count">${counts[key]}</span></button>`;
	const resetBtn = (scope, label) =>
		`<button data-on-click="resetScores(${userId}, '${scope}', '${label}')" class="m-btn m-btn-text m-btn-sm danger">${label}</button>`;

	box.innerHTML = `
		<div class="bg-zinc-800/50 rounded-xl px-3 py-2.5 mb-3 flex items-center gap-3 flex-wrap">
			<span class="material-symbols-outlined text-lg text-amber-300">local_fire_department</span>
			<div class="flex-1 min-w-0 text-sm">Streak <span class="font-mono font-bold">${data.streak.current}</span> <span class="text-zinc-500">· best ${data.streak.longest}${data.streak.last_played_date ? ` · last played ${escHtml(data.streak.last_played_date)}` : ""}</span></div>
			${icon("edit", `editStreak(${userId}, ${data.streak.current}, ${data.streak.longest})`, "Change the streak")}
		</div>
		<div class="bg-zinc-800/50 rounded-xl px-3 py-2.5 mb-3 flex items-center gap-3 flex-wrap">
			<span class="material-symbols-outlined text-lg text-blue-300">swords</span>
			<div class="flex-1 min-w-0 text-sm">Duel rating <span class="font-mono font-bold">${data.rating.value.toLocaleString()}</span> <span class="text-zinc-500">· ${data.rating.games} ranked duel${data.rating.games === 1 ? "" : "s"}</span></div>
			${icon("edit", `editRating(${userId}, ${data.rating.value})`, "Change the rating")}
		</div>
		<details class="bg-zinc-800/50 rounded-xl px-3 py-2.5 mb-3">
			<summary class="flex items-center gap-3 cursor-pointer list-none">
				<span class="material-symbols-outlined text-lg text-yellow-400">emoji_events</span>
				<span class="flex-1 text-sm">Achievements <span class="text-zinc-500">· ${data.achievements.filter((a) => a.earned_at).length} of ${data.achievements.length}</span></span>
				<span class="material-symbols-outlined text-zinc-500">expand_more</span>
			</summary>
			<div class="divide-y divide-zinc-800 mt-2">${data.achievements
				.map((a) =>
					row(
						`<span class="font-sans ${a.earned_at ? "" : "text-zinc-500"}">${escHtml(a.title)}</span>`,
						a.earned_at ? `Earned ${formatWhen(a.earned_at)}` : escHtml(a.description),
						a.earned_at
							? icon(
									"remove_circle",
									`setAchievement(${userId}, '${a.id}', false)`,
									"Take this achievement away"
								)
							: icon("add_circle", `setAchievement(${userId}, '${a.id}', true)`, "Give this achievement")
					)
				)
				.join("")}</div>
		</details>
		<div class="m-segmented mb-2">${tab("solo", "Solo")}${tab("daily", "Daily")}${tab("duels", "Duels")}</div>
		<div class="divide-y divide-zinc-800 max-h-72 overflow-y-auto pr-1">${lists[_scoreTab] || empty}</div>
		<p class="text-[11px] text-zinc-500 mt-2">The newest 200 of each are listed. Voiding a duel removes it for both players. Every change needs a reason, is logged, and the player is told.</p>
		<div class="flex gap-1 flex-wrap mt-2 -ml-2">
			${resetBtn("solo", "Reset solo")}${resetBtn("daily", "Reset daily")}${resetBtn("duels", "Void all duels")}${resetBtn("streak", "Reset streak")}${resetBtn("achievements", "Reset achievements")}${resetBtn("all", "Reset everything")}
		</div>`;
}

async function changeScores(userId, path, options, done) {
	try {
		await api(`/api/admin/scores/${userId}${path}`, options);
		showToast(done, "success");
		await openUserPanel(userId);
		loadScoreManager(userId);
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function editScore(userId, kind, id, current, max) {
	const value = await showPrompt("Correct this score", String(current), {
		note: `A whole number from 0 to ${max.toLocaleString()}. It was ${current.toLocaleString()}.`,
		type: "number",
		okLabel: "Next",
	});
	if (value === null || value === "") return;
	const answer = await askReason({ title: "Why is this score being corrected?", button: "Save score", rules: "F" });
	if (!answer) return;
	const body = kind === "solo" ? { total_score: Number(value) } : { score: Number(value) };
	changeScores(userId, `/${kind}/${id}`, { json: { ...body, reason: answer.reason } }, "Score corrected");
}

async function removeScore(userId, kind, id) {
	const duel = kind === "duels";
	const answer = await askReason({
		title: duel ? "Void this duel?" : "Remove this score?",
		note: duel
			? "The duel is removed for both players, so neither keeps a win or a loss from it. This cannot be undone."
			: "This cannot be undone.",
		button: duel ? "Void duel" : "Remove score",
		tone: "bg-red-700 hover:bg-red-600",
		rules: "F",
	});
	if (!answer) return;
	changeScores(
		userId,
		`/${kind}/${id}`,
		{ method: "DELETE", json: { reason: answer.reason } },
		duel ? "Duel voided" : "Score removed"
	);
}

async function editStreak(userId, current, longest) {
	const now = await showPrompt("Current streak", String(current), {
		note: "In days.",
		type: "number",
		okLabel: "Next",
	});
	if (now === null || now === "") return;
	const best = await showPrompt("Longest streak", String(Math.max(longest, Number(now))), {
		note: "Cannot be shorter than the current streak.",
		type: "number",
		okLabel: "Next",
	});
	if (best === null || best === "") return;
	const answer = await askReason({ title: "Why is this streak being changed?", button: "Save streak" });
	if (!answer) return;
	changeScores(
		userId,
		"/streak",
		{ json: { current: Number(now), longest: Number(best), reason: answer.reason } },
		"Streak changed"
	);
}

async function editRating(userId, current) {
	const value = await showPrompt("Duel rating", String(current), {
		note: "A whole number from 100 to 4,000. New players start on 1,000.",
		type: "number",
		okLabel: "Next",
	});
	if (value === null || value === "") return;
	const answer = await askReason({ title: "Why is this rating being changed?", button: "Save rating", rules: "F" });
	if (!answer) return;
	changeScores(userId, "/rating", { json: { rating: Number(value), reason: answer.reason } }, "Rating changed");
}

async function setAchievement(userId, key, earned) {
	const answer = await askReason({
		title: earned ? "Give this achievement?" : "Take this achievement away?",
		note: "The player is told, with your reason.",
		button: earned ? "Give" : "Take away",
	});
	if (!answer) return;
	changeScores(
		userId,
		`/achievements/${key}`,
		{ json: { earned, reason: answer.reason } },
		earned ? "Achievement given" : "Achievement removed"
	);
}

async function resetScores(userId, scope, label) {
	const answer = await askReason({
		title: `${label}?`,
		note:
			scope === "all"
				? "Every solo and daily score, every finished duel, the duel rating, the streak and every achievement are wiped. This cannot be undone."
				: "This cannot be undone. A backup can be made first from the System tab.",
		button: label,
		tone: "bg-red-700 hover:bg-red-600",
		rules: "F",
	});
	if (!answer) return;
	changeScores(userId, "/reset", { json: { scope, reason: answer.reason } }, "Done");
}

Object.assign(window, {
	editRating,
	editScore,
	editStreak,
	loadScoreManager,
	removeScore,
	resetScores,
	setAchievement,
});
