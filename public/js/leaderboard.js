let currentTab = "solo";
let currentUser = null;
let soloSort = "total";
let soloRounds = 0;
let soloTimeLimit = -1;
let duelsSort = "wins";
let duelsMode = "all";
let dailySort = "score";
/** Days back from today for the daily board; 0 is today. */
let dailyDaysAgo = 0;

const PAGE_SIZE = 50;
/** The rows on screen, in order. "Load more" adds the next page to the end. */
let entries = [];
/** Counts board loads, so a page that arrives after the filters changed is dropped. */
let loadId = 0;

function dailyDate() {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - dailyDaysAgo);
	return d.toISOString().slice(0, 10);
}

/** Puts the highlight behind the current tab; it slides there unless told to jump. */
function moveTabPill(slide = true) {
	const tab = el(`tab-${currentTab}`);
	const pill = el("tab-pill");
	const track = tab.parentElement.clientWidth;
	pill.style.transition = slide ? "" : "none";
	/** As shares of the track, so it stays on its tab when the page's width changes (a scrollbar appearing, say). */
	pill.style.left = `${(tab.offsetLeft / track) * 100}%`;
	pill.style.width = `${(tab.offsetWidth / track) * 100}%`;
}
moveTabPill(false);

async function init() {
	currentUser = await fetchUser();
	renderSortToggle();
	loadLeaderboard("solo");
	el("tab-solo").addEventListener("click", () => switchTab("solo"));
	el("tab-duels").addEventListener("click", () => switchTab("duels"));
	el("tab-daily").addEventListener("click", () => switchTab("daily"));
	el("load-more").addEventListener("click", loadMore);
}

function renderSortToggle() {
	const existing = document.getElementById("leaderboard-filters");
	if (existing) existing.remove();
	const wrap = document.createElement("div");
	wrap.id = "leaderboard-filters";
	wrap.className = "flex flex-wrap gap-2 mb-4";

	if (currentTab === "solo") {
		const tlLabels = [
			[-1, "All"],
			[30, "30s"],
			[60, "60s"],
			[90, "90s"],
			[120, "120s"],
			[0, '<span class="material-symbols-outlined text-sm leading-none align-middle">all_inclusive</span>'],
		];
		wrap.innerHTML = `
		<div class="flex items-center gap-1 overflow-x-auto pb-1">
			<button id="sort-total" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${soloSort === "total" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">Best total</button>
			<button id="sort-avg" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${soloSort === "avg" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">Avg/round</button>
			<span class="text-zinc-700 text-xs px-0.5">|</span>
			<button id="rounds-0" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${soloRounds === 0 ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">All R</button>
			<button id="rounds-3" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${soloRounds === 3 ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">3R</button>
			<button id="rounds-5" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${soloRounds === 5 ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">5R</button>
			<button id="rounds-10" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${soloRounds === 10 ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">10R</button>
			<span class="text-zinc-700 text-xs px-0.5">|</span>
			${tlLabels.map(([v, l]) => `<button id="tl-${v}" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${soloTimeLimit === v ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">${l}</button>`).join("")}
		</div>`;
		el("leaderboard-content").before(wrap);
		document.getElementById("sort-total").addEventListener("click", () => {
			soloSort = "total";
			renderSortToggle();
			loadLeaderboard("solo");
		});
		document.getElementById("sort-avg").addEventListener("click", () => {
			soloSort = "avg";
			renderSortToggle();
			loadLeaderboard("solo");
		});
		[0, 3, 5, 10].forEach((r) => {
			document.getElementById(`rounds-${r}`).addEventListener("click", () => {
				soloRounds = r;
				renderSortToggle();
				loadLeaderboard("solo");
			});
		});
		tlLabels.forEach(([v]) => {
			document.getElementById(`tl-${v}`).addEventListener("click", () => {
				soloTimeLimit = v;
				renderSortToggle();
				loadLeaderboard("solo");
			});
		});
	} else if (currentTab === "duels") {
		wrap.innerHTML = `
		<div class="flex items-center gap-1 overflow-x-auto pb-1">
			<button id="dsort-rating" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${duelsSort === "rating" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">Rating</button>
			<button id="dsort-wins" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${duelsSort === "wins" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">Wins</button>
			<button id="dsort-score" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${duelsSort === "score" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">Total score</button>
			<button id="dsort-avg" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${duelsSort === "avg" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">Avg/round</button>
			<span class="text-zinc-700 text-xs px-0.5">|</span>
			<button id="dmode-all" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${duelsMode === "all" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">All</button>
			<button id="dmode-quickplay" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${duelsMode === "quickplay" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}"><span class="material-symbols-outlined text-xs leading-none align-middle" style="font-variation-settings:'FILL' 1">bolt</span> Quick Play</button>
			<button id="dmode-room" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${duelsMode === "room" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}"><span class="material-symbols-outlined text-xs leading-none align-middle">meeting_room</span> Room</button>
		</div>`;
		el("leaderboard-content").before(wrap);
		["rating", "wins", "score", "avg"].forEach((s) => {
			document.getElementById(`dsort-${s}`).addEventListener("click", () => {
				duelsSort = s;
				renderSortToggle();
				loadLeaderboard("duels");
			});
		});
		["all", "quickplay", "room"].forEach((m) => {
			document.getElementById(`dmode-${m}`).addEventListener("click", () => {
				duelsMode = m;
				renderSortToggle();
				loadLeaderboard("duels");
			});
		});
	} else if (currentTab === "daily") {
		wrap.innerHTML = `
		<div class="flex items-center gap-1 overflow-x-auto pb-1">
			<button id="daysort-score" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${dailySort === "score" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">Score</button>
			<button id="daysort-distance" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${dailySort === "distance" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">Distance</button>
			<button id="daysort-time" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${dailySort === "time" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">Time</button>
			<button id="daysort-hints" class="px-2.5 py-1 rounded-lg text-xs font-semibold transition whitespace-nowrap ${dailySort === "hints" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}">Hints</button>
			<span class="text-zinc-700 text-xs px-0.5">|</span>
			<button id="day-prev" title="Previous day" aria-label="Previous day" class="px-1.5 py-1 rounded-lg text-zinc-400 hover:text-white transition"><span class="material-symbols-outlined text-base leading-none align-middle">chevron_left</span></button>
			<span class="text-xs font-semibold text-zinc-300 whitespace-nowrap">${dailyDaysAgo === 0 ? "Today" : dailyDaysAgo === 1 ? "Yesterday" : dailyDate()}</span>
			<button id="day-next" title="Next day" aria-label="Next day" ${dailyDaysAgo === 0 ? "disabled" : ""} class="px-1.5 py-1 rounded-lg text-zinc-400 hover:text-white transition disabled:opacity-30 disabled:hover:text-zinc-400"><span class="material-symbols-outlined text-base leading-none align-middle">chevron_right</span></button>
		</div>`;
		el("leaderboard-content").before(wrap);
		for (const [id, step] of [
			["day-prev", 1],
			["day-next", -1],
		]) {
			document.getElementById(id).addEventListener("click", () => {
				dailyDaysAgo = Math.min(365, Math.max(0, dailyDaysAgo + step));
				renderSortToggle();
				loadLeaderboard("daily");
			});
		}
		["score", "distance", "time", "hints"].forEach((s) => {
			document.getElementById(`daysort-${s}`).addEventListener("click", () => {
				dailySort = s;
				renderSortToggle();
				loadLeaderboard("daily");
			});
		});
	}
}

function switchTab(tab) {
	currentTab = tab;
	["solo", "duels", "daily"].forEach((t) => {
		el(`tab-${t}`).className =
			`relative flex-1 py-2 rounded-lg text-sm font-semibold transition ${tab === t ? "text-white" : "text-zinc-400 hover:text-white"}`;
	});
	moveTabPill();
	renderSortToggle();
	loadLeaderboard(tab);
}

function leaderboardUrl(tab, offset) {
	/** One more than a page shows: getting it back is how we know there is more to load. */
	const page = `limit=${PAGE_SIZE + 1}&offset=${offset}`;
	if (tab === "solo") {
		let url = `/api/leaderboard/solo?${page}&sort=${soloSort}`;
		if (soloRounds) url += `&rounds=${soloRounds}`;
		if (soloTimeLimit >= 0) url += `&time_limit=${soloTimeLimit}`;
		return url;
	}
	if (tab === "duels")
		return `/api/leaderboard/duels?${page}&sort=${duelsSort}${duelsMode !== "all" ? `&mode=${duelsMode}` : ""}`;
	if (tab === "daily")
		return `/api/leaderboard/daily?${page}&date=${dailyDate()}${dailySort !== "score" ? `&sort=${dailySort}` : ""}`;
	return `/api/leaderboard/${tab}?${page}`;
}

async function fetchPage(tab, offset) {
	/**
	 * A request that never arrives throws the browser's own wording ("Failed to fetch"), which is not for players.
	 */
	const r = await fetch(leaderboardUrl(tab, offset)).catch(() => {
		throw new Error("Can't reach the server. Check your connection and try again.");
	});
	/** A rate-limit answer carries a message written for the player. */
	if (r.status === 429) throw new Error(await r.text());
	if (!r.ok) throw new Error();
	const rows = await r.json();
	return { rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE };
}

async function loadLeaderboard(tab) {
	const id = ++loadId;
	el("leaderboard-content").innerHTML = skeletonRows(6);
	show("load-more-wrap", false);
	try {
		const page = await fetchPage(tab, 0);
		if (id !== loadId) return;
		entries = page.rows;
		renderLeaderboard(tab);
		show("load-more-wrap", page.more);
	} catch (err) {
		if (id !== loadId) return;
		el("leaderboard-content").innerHTML = errorStateHtml(
			err.message || "Couldn't load the leaderboard.",
			"loadLeaderboard(currentTab)"
		);
	}
}

/** Adds the next page under the rows already showing. */
async function loadMore() {
	const id = loadId;
	const tab = currentTab;
	const button = el("load-more");
	button.disabled = true;
	button.textContent = "Loading...";
	try {
		const page = await fetchPage(tab, entries.length);
		if (id !== loadId) return;
		const from = entries.length;
		entries.push(...page.rows);
		el("leaderboard-content").insertAdjacentHTML(
			"beforeend",
			page.rows.map((e, i) => entryHtml(tab, e, from + i)).join("")
		);
		/** Capped, so a long page does not keep its last rows waiting. */
		[...el("leaderboard-content").children]
			.slice(from)
			.forEach((row, i) => (row.style.animationDelay = `${Math.min(i, 12) * 25}ms`));
		show("load-more-wrap", page.more);
	} catch (err) {
		if (id === loadId) showToast(err.message || "Couldn't load more of the leaderboard. Try again.", "error");
	} finally {
		button.disabled = false;
		button.textContent = "Load more";
	}
}

function renderLeaderboard(tab) {
	if (!entries.length) {
		el("leaderboard-content").innerHTML = `<div class="text-zinc-500 text-center py-12">${
			tab === "daily" && dailyDaysAgo > 0
				? "Nobody played the daily challenge that day."
				: tab === "duels" && duelsSort === "rating"
					? "Nobody has a rating yet. Play a Quick Play duel to be the first."
					: "No scores yet. Be the first."
		}</div>`;
		return;
	}
	el("leaderboard-content").innerHTML = entries.map((e, i) => entryHtml(tab, e, i)).join("");
}

const medalIcons = ["emoji_events", "military_tech", "workspace_premium"];
const medalColors = ["text-yellow-400", "text-zinc-300", "text-amber-600"];

/** One row of the board; `i` is its place counting from zero. */
function entryHtml(tab, e, i) {
	const isMe = currentUser && e.user_id === currentUser.id;
	const medal =
		i < 3
			? `<span class="material-symbols-outlined ${medalColors[i]}" style="font-variation-settings:'FILL' 1">${medalIcons[i]}</span>`
			: `<span class="text-zinc-500 font-mono text-sm w-7 text-center">#${i + 1}</span>`;
	let score;
	if (tab === "solo") {
		const mainVal =
			soloSort === "avg"
				? `${Math.round(e.avg_per_round || 0).toLocaleString()} <span class="text-sm font-normal text-zinc-400">avg/round</span>`
				: (e.total_score || 0).toLocaleString();
		const tlLabel =
			e.time_limit > 0
				? `${e.time_limit}s`
				: '<span class="material-symbols-outlined text-xs align-middle leading-none">all_inclusive</span>';
		score = `<div class="font-mono font-bold text-lg">${mainVal}</div><div class="text-xs text-zinc-500">${e.rounds}R · ${tlLabel} · ${Math.round(((e.total_score || 0) / (e.max_possible || 25000)) * 100)}%</div>`;
	} else if (tab === "duels") {
		const qp = e.quickplay_games || 0;
		const rm = e.room_games || 0;
		const breakdown =
			qp || rm
				? ` · <span class="material-symbols-outlined text-xs align-middle leading-none" style="font-variation-settings:'FILL' 1">bolt</span>${qp} <span class="material-symbols-outlined text-xs align-middle leading-none">meeting_room</span>${rm}`
				: "";
		let mainVal, subVal;
		if (duelsSort === "rating") {
			mainVal = `${(e.rating || 0).toLocaleString()} <span class="text-sm font-normal text-zinc-400">rating</span>`;
			subVal = `${e.rated_games} ranked · ${e.wins}W / ${e.games_played}G`;
		} else if (duelsSort === "wins") {
			mainVal = `${e.wins || 0} <span class="text-sm font-normal text-zinc-400">wins</span>`;
			subVal = `${(e.total_score || 0).toLocaleString()} pts · ${e.games_played}G${breakdown}`;
		} else if (duelsSort === "avg") {
			mainVal = `${Math.round(e.avg_per_round || 0).toLocaleString()} <span class="text-sm font-normal text-zinc-400">avg/round</span>`;
			subVal = `${e.wins}W / ${e.games_played}G${breakdown}`;
		} else {
			mainVal = (e.total_score || 0).toLocaleString();
			subVal = `${e.wins}W / ${e.games_played}G${breakdown}`;
		}
		score = `<div class="font-mono font-bold text-lg">${mainVal}</div><div class="text-xs text-zinc-500">${subVal}</div>`;
	} else {
		const streak =
			e.current_streak > 0
				? ` <span class="material-symbols-outlined text-xs align-middle text-orange-400" style="font-variation-settings:'FILL' 1">local_fire_department</span>${e.current_streak}`
				: "";
		let mainVal, subVal;
		if (dailySort === "distance") {
			mainVal = `${(e.distance || 0).toLocaleString()} <span class="text-sm font-normal text-zinc-400">dist</span>`;
			subVal = `${(e.score || 0).toLocaleString()} pts${streak}`;
		} else if (dailySort === "time") {
			const secs = e.time_taken || 0;
			const timeStr = secs >= 60 ? `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s` : `${secs}s`;
			mainVal = `${timeStr} <span class="text-sm font-normal text-zinc-400">time</span>`;
			subVal = `${(e.score || 0).toLocaleString()} pts${streak}`;
		} else if (dailySort === "hints") {
			mainVal = `${e.hints_used || 0} <span class="text-sm font-normal text-zinc-400">hints</span>`;
			subVal = `${(e.score || 0).toLocaleString()} pts${streak}`;
		} else {
			mainVal = (e.score || 0).toLocaleString();
			subVal = `${e.date || ""}${streak}`;
		}
		score = `<div class="font-mono font-bold text-lg">${mainVal}</div><div class="text-xs text-zinc-500">${subVal}</div>`;
	}
	return `<div class="flex items-center gap-4 bg-zinc-900 rounded-2xl px-5 py-4 mb-2 ${isMe ? "ring-2 ring-blue-500" : ""}">
		${medal}
		${e.avatar_url ? `<img src="${escHtml(e.avatar_url)}" alt="" class="w-9 h-9 rounded-full" />` : `<div class="w-9 h-9 rounded-full bg-zinc-700 flex items-center justify-center"><span class="material-symbols-outlined text-sm">person</span></div>`}
		<div class="flex-1">
			<div class="font-semibold">${escHtml(e.display_name || e.username)}${isMe ? ' <span class="text-xs text-blue-400">(you)</span>' : ""}</div>
			<div class="text-xs text-zinc-500">${escHtml(e.username)}</div>
		</div>
		<div class="text-right">${score}</div>
	</div>`;
}

init();
