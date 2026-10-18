import "./lib/site.js";
import { avatarSrc, el, escHtml, scoreTone } from "./lib/dom.js";
import { api, fetchUser } from "./lib/api.js";
import { copyText } from "./lib/toast.js";

const _pathMatch = location.pathname.match(/^\/u\/([^/]+)/);
const username = _pathMatch ? decodeURIComponent(_pathMatch[1]) : new URLSearchParams(location.search).get("u") || "";

/** Role badge tooltips, written for players: what the person does, not what they can access. */
const ROLE_BADGES = {
	operator: ["Operator", "Runs Dovedale GeoGuesser."],
	admin: ["Administrator", "Helps run the site and the staff team."],
	supervisor: ["Supervisor", "Leads the moderators."],
	moderator: ["Moderator", "Answers tickets and keeps play fair."],
	curator: ["Curator", "Looks after the locations in the game."],
	helper: ["Helper", "A player who helps review new locations."],
};
const ROLE_TONES = {
	operator: "bg-yellow-900/60 text-yellow-300",
	admin: "bg-orange-900/60 text-orange-300",
	supervisor: "bg-purple-900/60 text-purple-300",
	moderator: "bg-blue-900/60 text-blue-300",
	curator: "bg-green-900/60 text-green-300",
	helper: "bg-teal-900/60 text-teal-300",
};

async function init() {
	const me = await fetchUser();

	if (!username) {
		el("main").innerHTML = notFoundMsg("No user specified.");
		return;
	}

	const r = await fetch(`/api/profile/${encodeURIComponent(username)}`);
	if (!r.ok) {
		const msg = r.status === 403 ? "This profile is private." : "User not found.";
		el("main").innerHTML = notFoundMsg(msg);
		return;
	}
	const p = await r.json();
	render(p, me);
}

function notFoundMsg(msg) {
	return `<div class="text-center py-16">
	<span class="material-symbols-outlined text-5xl text-zinc-700 block mb-4">search_off</span>
	<div class="text-zinc-400 text-lg font-semibold mb-1">${escHtml(msg)}</div>
	<a href="/" class="m-btn m-btn-tonal mt-6">
		<span class="material-symbols-outlined text-base leading-none">home</span> Return home
	</a>
</div>`;
}

function stat(label, value, sub) {
	return `<div class="bg-zinc-900 rounded-2xl px-5 py-4 text-center">
	<div class="text-2xl font-bold font-mono">${value ?? "-"}</div>
	<div class="text-zinc-400 text-sm mt-1">${label}</div>
	${sub ? `<div class="text-zinc-600 text-xs mt-0.5">${sub}</div>` : ""}
</div>`;
}

function render(p, me) {
	const isMe = me?.id === p.id;
	document.title = `${p.display_name || p.username} | Dovedale GeoGuesser`;
	document.title = `${p.display_name || p.username} | Dovedale GeoGuesser`;
	const ogImg = `/og.png?type=profile&u=${encodeURIComponent(p.username)}`;
	document
		.querySelector('meta[property="og:title"]')
		?.setAttribute("content", `${p.display_name || p.username} | Dovedale GeoGuesser`);
	document
		.querySelector('meta[property="og:description"]')
		?.setAttribute("content", `View ${p.display_name || p.username}'s GeoGuesser stats on the Dovedale Railway.`);
	document.querySelector('meta[property="og:image"]')?.setAttribute("content", ogImg);
	document.querySelector('meta[name="twitter:image"]')?.setAttribute("content", ogImg);

	const soloGames = p.solo?.total_games ?? 0;
	const duelGames = p.duels?.games ?? 0;
	const duelWins = p.duels?.wins ?? 0;
	const winRate = duelGames > 0 ? Math.round((duelWins / duelGames) * 100) : null;
	const joined = new Date(p.created_at * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long" });

	el("main").innerHTML = `
	<div class="flex items-center gap-x-5 gap-y-3 mb-8 flex-wrap">
		${
			p.avatar_url
				? `<img src="${escHtml(avatarSrc(p.avatar_url, 80))}" alt="" decoding="async" class="w-20 h-20 rounded-full border-2 border-zinc-700" />`
				: `<div class="w-20 h-20 rounded-full bg-zinc-800 flex items-center justify-center"><span class="material-symbols-outlined text-4xl text-zinc-600">person</span></div>`
		}
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-2 flex-wrap">
				<h1 class="text-2xl sm:text-3xl font-bold break-words">${escHtml(p.display_name || p.username)}</h1>
				${ROLE_BADGES[p.role] ? `<span title="${escHtml(ROLE_BADGES[p.role][1])}" tabindex="0" class="text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1 cursor-help ${ROLE_TONES[p.role]}"><span class="material-symbols-outlined" style="font-size:12px;font-variation-settings:'FILL' 1">${p.role === "helper" ? "volunteer_activism" : "shield"}</span>${ROLE_BADGES[p.role][0]}</span>` : ""}
			</div>
			<div class="text-zinc-500 text-sm">@${escHtml(p.username)}</div>
			<div class="text-zinc-600 text-xs mt-1">Member since ${joined}</div>
		</div>
		<div class="flex gap-3 items-center">
			${
				p.profile_private
					? `<span class="text-xs ${me?.role ? "text-zinc-500" : "text-zinc-600"} flex items-center gap-1"><span class="material-symbols-outlined text-sm leading-none">lock</span> Private${me?.role && !isMe ? " (staff view)" : ""}</span>`
					: `<button id="share-btn" class="text-xs text-zinc-500 hover:text-zinc-300 transition flex items-center gap-1"><span class="material-symbols-outlined text-sm leading-none">share</span> Share</button>`
			}
		</div>
	</div>

	${
		p.current_streak > 0 || p.longest_streak > 0
			? `
	<div class="flex gap-4 mb-6">
		<div class="flex-1 bg-orange-900/30 border border-orange-800/40 rounded-2xl px-5 py-4 flex items-center gap-3">
			<span class="material-symbols-outlined text-3xl text-orange-400" style="font-variation-settings:'FILL' 1">local_fire_department</span>
			<div>
				<div class="text-xl font-bold">${p.current_streak} day${p.current_streak !== 1 ? "s" : ""}</div>
				<div class="text-orange-300/70 text-xs">Current streak</div>
			</div>
		</div>
		<div class="flex-1 bg-zinc-900 rounded-2xl px-5 py-4 flex items-center gap-3">
			<span class="material-symbols-outlined text-3xl text-yellow-400" style="font-variation-settings:'FILL' 1">grade</span>
			<div>
				<div class="text-xl font-bold">${p.longest_streak}</div>
				<div class="text-zinc-400 text-xs">Longest streak</div>
			</div>
		</div>
	</div>`
			: ""
	}

	<h2 class="font-bold text-zinc-300 mb-3 mt-2">Solo</h2>
	<div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
		${stat("Best Score", p.solo?.best_score !== null ? (p.solo.best_score ?? 0).toLocaleString() : "-")}
		${stat("Games Played", soloGames.toLocaleString())}
		${stat("Avg Score", p.solo?.avg_score != null ? Math.round(p.solo.avg_score).toLocaleString() : "-")}
		${p.rounds?.solo_avg != null ? stat("Avg Per Round", p.rounds.solo_avg.toLocaleString()) : ""}
	</div>

	<h2 class="font-bold text-zinc-300 mb-3">Daily Challenge</h2>
	<div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
		${stat("Best Daily Score", p.daily?.best !== null ? (p.daily?.best ?? 0).toLocaleString() : "-")}
		${stat("Days Played", (p.daily?.played ?? 0).toLocaleString())}
		${stat("Avg Score", p.daily?.avg != null ? Math.round(p.daily.avg).toLocaleString() : "-")}
		${p.daily?.avg_distance != null ? stat("Avg Distance", `${p.daily.avg_distance.toLocaleString()} units`) : ""}
		${p.daily?.avg_time != null ? stat("Avg Time", `${p.daily.avg_time}s`) : ""}
		${p.daily?.played ? stat("Without Hints", `${p.daily.no_hints} of ${p.daily.played}`) : ""}
	</div>

	<h2 class="font-bold text-zinc-300 mb-3">Duels</h2>
	<div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
		${stat("Wins", duelWins.toLocaleString())}
		${stat("Games", duelGames.toLocaleString())}
		${stat("Win Rate", winRate !== null ? `${winRate}%` : "-")}
		${stat("Rating", p.rating?.games ? p.rating.value.toLocaleString() : "Unranked")}
		${stat("Ranked Duels", (p.rating?.games ?? 0).toLocaleString())}
		${stat("Total Score", (p.duels?.total_score ?? 0).toLocaleString())}
		${p.rounds?.duel_avg != null ? stat("Avg Per Round", p.rounds.duel_avg.toLocaleString()) : ""}
		${p.rounds?.duel_avg_time != null ? stat("Avg Guess Time", `${p.rounds.duel_avg_time}s`) : ""}
	</div>

	${achievementsHtml(p.achievements)}

	${
		(p.submissions?.total ?? 0) > 0
			? `
	<div class="flex items-center justify-between mb-3">
		<h2 class="font-bold text-zinc-300">Submissions</h2>
		${isMe ? `<a href="/settings#submissions" class="text-xs text-zinc-500 hover:text-zinc-300 transition">View my submissions</a>` : ""}
	</div>
	<div class="grid grid-cols-2 gap-3 mb-6">
		${stat("Submitted", p.submissions.total.toLocaleString())}
		${stat("Approved", p.submissions.approved?.toLocaleString() ?? "0")}
	</div>`
			: ""
	}

	${recentGamesHtml(p.recent)}
`;
	el("share-btn")?.addEventListener("click", () => shareProfile(p.username));
}

function achievementsHtml(achievements) {
	if (!achievements?.length) return "";
	const earned = achievements.filter((a) => a.earned_at).length;
	const tile = (
		a,
		i
	) => `<div class="rounded-2xl px-3 py-3 flex items-center gap-3 ${a.earned_at ? "bg-zinc-900" : "bg-zinc-900/40"}" title="${escHtml(a.description)}">
		<span class="material-symbols-outlined text-2xl flex-shrink-0 ${a.earned_at ? "achievement-lit text-yellow-400" : "text-zinc-700"}" ${a.earned_at ? `style="font-variation-settings:'FILL' 1;animation-delay:${200 + Math.min(i, 12) * 70}ms"` : ""}>${a.earned_at ? escHtml(a.icon) : "lock"}</span>
		<div class="min-w-0">
			<div class="text-sm font-semibold truncate ${a.earned_at ? "" : "text-zinc-500"}">${escHtml(a.title)}</div>
			<div class="text-xs ${a.earned_at ? "text-zinc-500" : "text-zinc-600"}">${escHtml(a.description)}</div>
		</div>
	</div>`;
	const sorted = [...achievements].sort((a, b) => (b.earned_at || 0) - (a.earned_at || 0));
	return `<div class="flex items-center justify-between mb-3" id="achievements">
		<h2 class="font-bold text-zinc-300">Achievements</h2>
		<span class="text-xs text-zinc-500">${earned} of ${achievements.length}</span>
	</div>
	<div class="stagger grid grid-cols-1 sm:grid-cols-2 gap-2 mb-6">${sorted.map(tile).join("")}</div>`;
}

const shortDate = (seconds) =>
	new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function historyCard(title, rows, empty) {
	return `<div class="bg-zinc-900 rounded-2xl p-4">
		<h3 class="font-semibold text-sm text-zinc-300 mb-2">${title}</h3>
		${rows.length ? `<div class="stagger">${rows.join("")}</div>` : `<p class="text-zinc-600 text-sm">${empty}</p>`}
	</div>`;
}

function recentGamesHtml(recent) {
	if (!recent) return "";
	const row = (left, right, extra = "") =>
		`<div class="flex items-center justify-between gap-3 py-1.5 border-b border-zinc-800 last:border-0 text-sm" ${extra}>${left}${right}</div>`;

	const solo = recent.solo.map((g) => {
		const tone = scoreTone(g.total_score, g.max_possible);
		return row(
			`<span class="text-zinc-400">${g.rounds} rounds · ${g.time_limit ? g.time_limit + "s" : "no limit"} <span class="text-zinc-600 text-xs">${shortDate(g.created_at)}</span></span>`,
			`<span class="font-mono font-bold ${tone.text}">${g.total_score.toLocaleString()}</span>`
		);
	});
	const daily = recent.daily.map((d) =>
		row(
			`<span class="text-zinc-400">${escHtml(d.date)}${d.hints_used ? ` <span class="text-zinc-600 text-xs">${d.hints_used} hint${d.hints_used === 1 ? "" : "s"}</span>` : ""}</span>`,
			`<span class="font-mono font-bold ${scoreTone(d.score).text}">${d.score.toLocaleString()}</span>`
		)
	);
	const resultTone = { win: "text-green-400", loss: "text-red-400", tie: "text-zinc-400" };
	const duels = recent.duels.map(
		(d) =>
			`<div class="border-b border-zinc-800 last:border-0">${row(
				`<button class="text-left text-zinc-400 hover:text-white transition min-w-0 truncate" data-on-click="toggleDuelRounds(${d.id}, this)" title="Show each round">
					<span class="font-semibold ${resultTone[d.result]}">${d.result === "win" ? "Won" : d.result === "loss" ? "Lost" : "Tied"}</span>
					vs ${escHtml(d.opponent_display_name || d.opponent_username || "a deleted player")}
					<span class="text-zinc-600 text-xs">${d.finished_at ? shortDate(d.finished_at) : ""}${d.quickplay ? " · quick play" : ""}</span>
				</button>`,
				`<span class="font-mono text-zinc-300 flex-shrink-0">${(d.score ?? 0).toLocaleString()} <span class="text-zinc-600">-</span> ${(d.opponent_score ?? 0).toLocaleString()}</span>`,
				'style="border:0"'
			)}<div id="duel-rounds-${d.id}" class="hidden pb-2"></div></div>`
	);

	return `<h2 class="font-bold text-zinc-300 mb-3 mt-2">Recent games</h2>
	<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
		${historyCard("Solo", solo, "No solo games yet.")}
		${historyCard("Daily challenge", daily, "No daily challenges yet.")}
		<div class="sm:col-span-2">${historyCard("Duels", duels, "No duels yet.")}</div>
	</div>`;
}

async function toggleDuelRounds(gameId, button) {
	const box = el(`duel-rounds-${gameId}`);
	if (!box.classList.toggle("hidden") || box.dataset.loaded) return;
	box.innerHTML = '<div class="skeleton h-10 rounded-lg"></div>';
	try {
		const { rounds_played } = await api(`/api/duels/history/${gameId}`);
		const byRound = new Map();
		for (const r of rounds_played) byRound.set(r.round_number, [...(byRound.get(r.round_number) || []), r]);
		box.dataset.loaded = "1";
		box.innerHTML = byRound.size
			? [...byRound]
					.map(
						([round, players]) => `<div class="text-xs text-zinc-500 flex gap-2 py-0.5">
							<span class="w-6 flex-shrink-0 text-zinc-600">R${round}</span>
							<span class="flex-1 min-w-0 truncate">${escHtml(players[0].label || "Location")}</span>
							<span class="font-mono flex-shrink-0">${players.map((pl) => `${escHtml(pl.display_name || pl.username)} ${pl.score.toLocaleString()}`).join(" · ")}</span>
						</div>`
					)
					.join("")
			: '<p class="text-xs text-zinc-600">No round details: they are kept for 180 days.</p>';
	} catch (err) {
		box.innerHTML = `<p class="text-xs text-red-400">${escHtml(err.message)}</p>`;
	}
}

async function shareProfile(username) {
	const btn = el("share-btn");
	if (!(await copyText(`${location.origin}/u/${encodeURIComponent(username)}`)) || !btn) return;
	const original = btn.innerHTML;
	btn.innerHTML = '<span class="material-symbols-outlined text-sm leading-none">check</span> Link copied';
	setTimeout(() => (btn.innerHTML = original), 2000);
}

init();

Object.assign(window, { toggleDuelRounds });
