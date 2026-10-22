import { avatarHtml, el, errorStateHtml, escHtml } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { copyText, showToast } from "../lib/toast.js";
import { live, onLive } from "../lib/live.js";
import { atLeast, currentTab, reviewHeader, showConfirm, showPrompt } from "./core.js";
import { formatWhen } from "./users.js";
import { staffChatSlot, stopStaffChat, wordFilterHtml } from "./tournament-chat.js";

let _tournamentId = null;
let _tournament = null;
let _editing = false;
let _busy = false;
let _clock = null;

const CHECKIN_CHOICES = [
	[10, "10 minutes before"],
	[15, "15 minutes before"],
	[30, "30 minutes before"],
	[60, "1 hour before"],
	[120, "2 hours before"],
	[1440, "A day before"],
];

const STATUS_TAGS = {
	draft: ["Draft", "warn"],
	announced: ["Announced", "info"],
	open: ["Check-in open", "info"],
	live: ["Live", "danger"],
	finished: ["Finished", "success"],
	cancelled: ["Cancelled", ""],
};

const BREAK_CHOICES = [15, 30, 60, 120, 180, 300, 600, 900, 1800];
const BREAK_FIELDS = [
	["start", "Before the first match"],
	["match", "Between matches"],
	["round", "Between rounds"],
	["final", "Before the final"],
];
const PHASE_TEXT = {
	lobby: "Not started",
	break: "Break",
	hold: "Waiting for staff",
	match: "Match being played",
	result: "Showing the result",
	done: "Over",
};
const HOLD_REASONS = {
	not_ready: "A player isn't ready. Continue gives a 10-second countdown, then anyone not there loses the match.",
	no_show: "A player didn't join their match.",
	no_winner: "Both players left the match.",
	closed: "The match was stopped.",
	restart: "The server restarted during the tournament.",
	staff: "",
};

const roundsText = (n) => `${n} round${n === 1 ? "" : "s"}`;
const seconds = (s) => (s >= 60 ? `${s / 60} min` : `${s}s`);
const statusTag = (status) => {
	const [label, tone] = STATUS_TAGS[status] || [status, ""];
	return `<span class="m-tag ${tone}">${label}</span>`;
};

export async function loadTournaments(openId = null) {
	if (openId) _tournamentId = openId;
	clearInterval(_clock);
	if (_tournamentId) return openTournament(_tournamentId);
	let list;
	let rules;
	try {
		[list, rules] = await Promise.all([api("/api/admin/tournaments"), api("/api/admin/tournaments/rules")]);
	} catch (err) {
		el("tab-content").innerHTML = errorStateHtml(err.message || "Couldn't load tournaments.", "loadTournaments()");
		return;
	}
	el("tab-content").innerHTML = `
		${reviewHeader("Tournaments", 0, "loadTournaments()")}
		<p class="text-sm text-zinc-400 mb-4 max-w-2xl">A knockout bracket for game nights, with spectators and chat. Pick the players, open check-in, then start it when everyone is here.</p>
		${atLeast("supervisor") ? '<button data-on-click="newTournament()" class="m-btn m-btn-filled mb-5"><span class="material-symbols-outlined">add</span>New tournament</button>' : '<p class="text-xs text-zinc-500 mb-5">Supervisors create, open, start and cancel tournaments. You can run them once they are set up.</p>'}
		${guideHtml(rules)}
		<div id="tournament-form-slot"></div>
		<div class="flex flex-col gap-2">${
			list.length
				? list
						.map(
							(
								t
							) => `<button data-on-click="openTournament(${t.id})" class="bg-zinc-900 hover:bg-zinc-800 transition rounded-2xl px-4 py-3 flex items-center gap-3 text-left">
								<span class="material-symbols-outlined text-zinc-400">trophy</span>
								<span class="flex-1 min-w-0">
									<span class="block font-semibold truncate">${escHtml(t.title)}</span>
									<span class="block text-xs text-zinc-500 mt-0.5">${t.players} player${t.players === 1 ? "" : "s"}${t.starts_at ? ` · starts ${escHtml(new Date(t.starts_at * 1000).toLocaleString())}` : ""}${t.winner_username ? ` · won by @${escHtml(t.winner_username)}` : ""} · created ${formatWhen(t.created_at)}</span>
								</span>
								${statusTag(t.status)}
								<span class="material-symbols-outlined text-zinc-600">chevron_right</span>
							</button>`
						)
						.join("")
				: '<p class="text-sm text-zinc-500 py-8 text-center">No tournaments yet.</p>'
		}</div>
		${wordFilterHtml()}
		${
			atLeast("operator") && list.length
				? `<div class="mt-10 pt-4 border-t border-zinc-800 flex items-center gap-3 flex-wrap max-w-3xl">
					<button data-on-click="resetTournamentHistory()" class="m-btn m-btn-text m-btn-sm danger"><span class="material-symbols-outlined">delete_sweep</span>Clear all tournament history</button>
					<span class="text-xs text-zinc-500">Operators only. Deletes every tournament and its matches, and the next one starts from number 1.</span>
				</div>`
				: ""
		}`;
}

async function resetTournamentHistory() {
	const ok = await showConfirm(
		"Clear all tournament history?",
		"Every tournament, its player list and its matches are deleted for good, and the next tournament is number 1 again. Cancel any running tournament first.",
		{ confirmLabel: "Clear everything" }
	);
	if (!ok) return;
	try {
		const done = await api("/api/admin/tournaments", { method: "DELETE" });
		showToast(`Cleared ${done.tournaments} tournament${done.tournaments === 1 ? "" : "s"}`, "success");
		loadTournaments();
	} catch (err) {
		showToast(err.message, "error");
	}
}

const minutes = (s) => (s % 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? "" : "s"}`);

function guideHtml(r) {
	const step = (title, body) =>
		`<li class="mb-3"><div class="font-semibold text-zinc-200">${title}</div><div class="text-zinc-400">${body}</div></li>`;
	const limit = (label, value) =>
		`<div class="flex justify-between gap-4 py-1.5 border-b border-zinc-800 last:border-0"><span class="text-zinc-400">${label}</span><span class="text-zinc-200 text-right">${value}</span></div>`;
	const control = (name, body) => `<li class="mb-1.5"><span class="text-zinc-200">${name}:</span> ${body}</li>`;
	return `<details class="bg-zinc-900 rounded-2xl mb-5 max-w-3xl">
		<summary class="cursor-pointer select-none px-5 py-3 font-semibold flex items-center gap-2"><span class="material-symbols-outlined text-zinc-400">help</span>How tournaments work, and their limits</summary>
		<div class="px-5 pb-5 text-sm">
			<h3 class="text-xs text-zinc-500 uppercase tracking-wider font-medium mt-2 mb-3">Step by step</h3>
			<ol class="list-decimal pl-5">
				${step("Set it up (supervisors)", `Give it a name and, if you like, a description and a start time. The start time is only a countdown on the page; you still start it yourself. Choose how many rounds each match has (early matches, semi-finals and the final), how long each break is, and whether the two semi-final losers play for third place. Suggest changes shows every answer, so it is closed to players while the tournament runs unless you untick that.`)}
				${step("Add the players", `Add them by Discord username, or make an invite link: anyone who opens it while check-in is open joins and is checked in, and the list shows which code they used. A new code stops the old one working. The order of the list is the seeding: the first player meets the last in the opening round, and the top two can only meet in the final. Banned players and players whose duels are limited can't be added.`)}
				${step("Announce (supervisors)", `The tournament appears on the home page and under Specials with a countdown to the start, and everyone on the list gets a notification. With a start time, check-in opens by itself a set time before it (Check-in opens); without one, or to open it early, press Open check-in. You can also open check-in straight from a draft. Only one tournament can be announced, open or running at a time.`)}
				${step("Check-in", `Everyone on the list is told when check-in opens. Players press I'm here on the tournament page, or you tick them in yourself.`)}
				${step("Start (supervisors)", `The bracket is drawn from the checked-in players, seeded by duel rating; players on the same rating keep the list's order. It rounds up to 2, 4, 8, 16, 32 or 64 places, and the empty places become byes for the top seeds. Anyone not checked in is left out, but can still be put into an empty place later. Until the first match is played you can draw the bracket again.`)}
				${step("Breaks and Ready", `Before every match there is a countdown. Both players press Ready; if they both do during a break between matches, the countdown drops to ${r.readySeconds} seconds. If the countdown ends and someone isn't ready, the tournament waits for you: Continue gives a ${r.readySeconds}-second countdown, then anyone who isn't there loses the match.`)}
				${step("Rounds played all at once", `Early rounds can be played all at once to save time: with 64 players, the first three rounds take about 5 minutes each instead of over an hour. Set where it switches to one match at a time with One match at a time from (the quarter-finals by default). In a round played all at once, every match whose players are ready starts when the break ends; the others wait, start as soon as both players are ready, or when you press Start. If only one player is ready, you can put the other out. Spectators follow the featured match, or the closest one, and can switch at any time.`)}
				${step("Matches", `Each match is a duel with Quick Play rules, including the comeback round and sudden death, and ${r.roundSeconds} seconds a round. If the points are level, the closer guesses overall win. Players have ${r.joinSeconds} seconds to join; if only one does, they win, and if neither does, it waits for you. A player who drops out has ${r.reconnectSeconds} seconds to come back before they lose.`)}
				${step("Chat", `Spectator chat is off until you turn it on in the Chat card on the tournament's page, and you can turn it off at any time. Others see a message 1.5 seconds after it is sent. Players can't see chat while a round of their match is in play, can read it between rounds, and can write whenever their match isn't being played. Signed-out visitors, banned or chat-limited players and accounts under a day old can't see it. Links, emoji, other alphabets and words caught by the Chat filter are refused. From any message you can delete it or time out its sender.`)}
				${step("Results", `After the final, the page shows the champion, final standings and the bracket. The results stay on the home page and Specials for ${r.resultsHours} hours; use the Results section to change that or hide them. The page itself stays at its link, and the tournament is listed under past tournaments.`)}
			</ol>
			<h3 class="text-xs text-zinc-500 uppercase tracking-wider font-medium mt-4 mb-2">During the tournament event (moderators and up)</h3>
			<ul class="text-zinc-400 mb-4">
				${control("Start now / Move on", "ends the current break or result early")}
				${control("+1 minute", `adds ${r.addTimeSeconds} seconds to the countdown`)}
				${control("Pause / Resume", "stops and restarts the countdown")}
				${control("Continue", "used when the tournament is waiting for staff, for example after a no-show or a server restart")}
				${control("[Player] wins", "gives a match to one player without it being played to the end")}
				${control("Not ready", "when only one player is ready, puts the other out and the ready one through")}
				${control("Start / Start all waiting", "in a round played all at once, starts waiting matches now")}
				${control("Feature", "in a round played all at once, the match spectators follow on automatic")}
				${control("Restart", `stops a match being played and plays it again after a ${r.restartBreakSeconds}-second break`)}
				${control("Fill / Swap", "puts someone into an empty place or replaces a player, in a match that hasn't started")}
				${control("Take out", "removes a player; their opponent goes through, and a match they're playing ends")}
				${control("Message", "shows a line of text to everyone on the tournament page")}
			</ul>
			<h3 class="text-xs text-zinc-500 uppercase tracking-wider font-medium mb-1">Limits</h3>
			<div class="mb-4">
				${limit("Players on the list", `up to ${r.roster}`)}
				${limit("Players in the bracket", `2 to ${r.players}`)}
				${limit("Rounds per match", `${r.minRounds} to ${r.maxRounds}`)}
				${limit("Each break", `${minutes(r.breakMin)} to ${minutes(r.breakMax)}`)}
				${limit("Open or running at once", "1")}
				${limit("Name, description, message", `${r.title}, ${r.description} and ${r.message} characters`)}
				${limit("Spectators", "no limit")}
			</div>
			<p class="text-zinc-500">Tournament matches don't change ratings, leaderboards, profiles or achievements. Fair-play checks still apply. Played one at a time, 16 players is 15 matches in a row; rounds played all at once make a big bracket much shorter.</p>
		</div>
	</details>`;
}

function newTournament() {
	el("tournament-form-slot").innerHTML = formHtml(null);
}

function toLocalInput(sec) {
	if (!sec) return "";
	const d = new Date(sec * 1000);
	d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
	return d.toISOString().slice(0, 16);
}

function formHtml(t) {
	const s = t?.settings || {
		rounds: 3,
		semiRounds: 3,
		finalRounds: 3,
		breaks: { start: 300, match: 60, round: 180, final: 180 },
		thirdPlace: false,
		spotlightFrom: 2,
		lockSuggestions: true,
	};
	const roundsSelect = (name, value) =>
		`<select name="${name}" class="m-field">${Array.from({ length: 10 }, (_, i) => i + 1)
			.map(
				(n) => `<option value="${n}" ${n === value ? "selected" : ""}>${n} round${n === 1 ? "" : "s"}</option>`
			)
			.join("")}</select>`;
	const breakSelect = (key) =>
		`<select name="break_${key}" class="m-field">${[...new Set([...BREAK_CHOICES, s.breaks[key]])]
			.sort((a, b) => a - b)
			.map((n) => `<option value="${n}" ${n === s.breaks[key] ? "selected" : ""}>${seconds(n)}</option>`)
			.join("")}</select>`;
	const field = (label, input) => `<label class="flex flex-col gap-1 text-xs text-zinc-400">${label}${input}</label>`;
	return `<form data-on-submit="saveTournament(event)" class="bg-zinc-900 rounded-2xl p-5 mb-5 flex flex-col gap-4 max-w-3xl">
		<h3 class="font-bold">${t ? "Edit tournament" : "New tournament"}</h3>
		${field("Name", `<input name="title" required maxlength="80" class="m-field" value="${escHtml(t?.title || "")}" placeholder="Friday game night" />`)}
		${field("Description <span class='text-zinc-600'>Optional. Shown on the tournament page.</span>", `<textarea name="description" maxlength="500" rows="2" class="m-field">${escHtml(t?.description || "")}</textarea>`)}
		<div class="grid sm:grid-cols-2 gap-3">
			${field("Starts at <span class='text-zinc-600'>Optional. Shown as a countdown; you still start it yourself.</span>", `<input name="starts_at" type="datetime-local" class="m-field" value="${toLocalInput(t?.starts_at)}" />`)}
			${field(
				"Check-in opens <span class='text-zinc-600'>Once announced, with a start time</span>",
				`<select name="checkin_minutes" class="m-field">${CHECKIN_CHOICES.map(([n, label]) => `<option value="${n}" ${n === (s.checkinMinutes ?? 30) ? "selected" : ""}>${label}</option>`).join("")}</select>`
			)}
		</div>
		<div class="grid sm:grid-cols-3 gap-3">
			${field("Early matches", roundsSelect("rounds", s.rounds))}
			${field("Semi-finals", roundsSelect("semi_rounds", s.semiRounds))}
			${field("Final", roundsSelect("final_rounds", s.finalRounds))}
		</div>
		<div class="grid sm:grid-cols-4 gap-3">${BREAK_FIELDS.map(([key, label]) => field(label, breakSelect(key))).join("")}</div>
		${field(
			"One match at a time from <span class='text-zinc-600'>Earlier rounds play all their matches at once</span>",
			`<select name="spotlight_from" class="m-field">${SPOTLIGHT_CHOICES.map(([n, label]) => `<option value="${n}" ${n === (s.spotlightFrom ?? 2) ? "selected" : ""}>${label}</option>`).join("")}</select>`
		)}
		<label class="md-check">
			<input name="third_place" type="checkbox" ${s.thirdPlace ? "checked" : ""} />
			<span class="md-check-box" aria-hidden="true"></span>
			<span>
				<span class="block text-sm text-zinc-200">Match for third place</span>
				<span class="block text-xs text-zinc-500">The semi-final losers play once more, just before the final</span>
			</span>
		</label>
		<label class="md-check">
			<input name="lock_suggestions" type="checkbox" ${s.lockSuggestions !== false ? "checked" : ""} />
			<span class="md-check-box" aria-hidden="true"></span>
			<span>
				<span class="block text-sm text-zinc-200">Close suggestions while it runs</span>
				<span class="block text-xs text-zinc-500">Suggest changes shows every answer on the map. Staff can still use it.</span>
			</span>
		</label>
		<div class="flex gap-2">
			<button class="m-btn m-btn-filled">${t ? "Save" : "Create"}</button>
			<button type="button" data-on-click="${t ? "toggleTournamentEdit(false)" : "loadTournaments()"}" class="m-btn m-btn-text">Cancel</button>
		</div>
	</form>`;
}

async function saveTournament(e) {
	e.preventDefault();
	const form = new FormData(e.target);
	const startsAt = form.get("starts_at");
	const body = {
		title: form.get("title"),
		description: form.get("description"),
		starts_at: startsAt ? new Date(startsAt).getTime() : null,
		rounds: Number(form.get("rounds")),
		semi_rounds: Number(form.get("semi_rounds")),
		final_rounds: Number(form.get("final_rounds")),
		breaks: Object.fromEntries(BREAK_FIELDS.map(([key]) => [key, Number(form.get(`break_${key}`))])),
		third_place: form.get("third_place") === "on",
		spotlight_from: Number(form.get("spotlight_from")),
		checkin_minutes: Number(form.get("checkin_minutes")),
		lock_suggestions: form.get("lock_suggestions") === "on",
	};
	try {
		const t = _tournamentId
			? await api(`/api/admin/tournaments/${_tournamentId}`, { method: "PATCH", json: body })
			: await api("/api/admin/tournaments", { json: body });
		_editing = false;
		showToast(_tournamentId ? "Saved" : "Tournament created", "success");
		openTournament(t.id, t);
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function openTournament(id, data = null) {
	_tournamentId = id;
	if (currentTab === "tournaments") history.replaceState(null, "", `#tournaments:${id}`);
	try {
		_tournament = data || (await api(`/api/admin/tournaments/${id}`));
	} catch (err) {
		_tournamentId = null;
		el("tab-content").innerHTML = errorStateHtml(
			err.message || "Couldn't load the tournament.",
			"backToTournaments()"
		);
		return;
	}
	renderTournament();
	clearInterval(_clock);
	_clock = setInterval(tickClock, 500);
}

function backToTournaments() {
	_tournamentId = null;
	_tournament = null;
	_editing = false;
	stopStaffChat();
	history.replaceState(null, "", "#tournaments");
	loadTournaments();
}

function toggleTournamentEdit(on) {
	_editing = on;
	renderTournament();
}

const nameOf = (t, id) => {
	const p = t.players[id];
	return p ? p.display_name || p.username : "Player";
};

function renderTournament() {
	const t = _tournament;
	if (!t || currentTab !== "tournaments") return;
	const senior = atLeast("supervisor");
	const del = senior
		? `<button data-on-click="deleteTournament()" class="m-btn m-btn-text danger">Delete</button>`
		: "";
	const cancel = senior
		? `<button data-on-click="cancelTournament()" class="m-btn m-btn-text danger">Cancel tournament</button>`
		: "";
	const reset = senior
		? `<button data-on-click="backToCheckin()" class="m-btn m-btn-tonal">Back to check-in</button>`
		: "";
	const actions = {
		draft: `${senior ? `<button data-on-click="tournamentAction('announce')" class="m-btn m-btn-filled">Announce</button><button data-on-click="tournamentAction('open')" class="m-btn m-btn-tonal">Open check-in now</button>` : ""}${del}`,
		announced: senior
			? `<button data-on-click="tournamentAction('open')" class="m-btn m-btn-filled">Open check-in now</button>
				<button data-on-click="tournamentAction('unpublish')" class="m-btn m-btn-tonal">Back to draft</button>
				${cancel}`
			: "",
		open: senior
			? `<button data-on-click="startTournament()" class="m-btn m-btn-success">Start tournament</button>
				<button data-on-click="tournamentAction('unpublish')" class="m-btn m-btn-tonal">Back to draft</button>
				${cancel}`
			: "",
		live: `${reset}${cancel}`,
		finished: `${reset}${del}`,
		cancelled: del,
	}[t.status];
	const over = t.status === "finished" || t.status === "cancelled";
	el("tab-content").innerHTML = `
		<button data-on-click="backToTournaments()" class="text-sm text-zinc-400 hover:text-white flex items-center gap-1 mb-3"><span class="material-symbols-outlined text-base">arrow_back</span>All tournaments</button>
		<div class="flex items-center gap-3 flex-wrap mb-1">
			<h2 class="font-bold text-xl">${escHtml(t.title)}</h2>
			${statusTag(t.status)}
			<a href="/tournament/${t.id}" target="_blank" rel="noopener" class="m-btn m-btn-tonal m-btn-sm ml-auto"><span class="material-symbols-outlined">open_in_new</span>Open page</a>
			${over ? "" : `<button data-on-click="toggleTournamentEdit(${!_editing})" class="m-btn m-btn-tonal m-btn-sm"><span class="material-symbols-outlined">edit</span>Edit</button>`}
		</div>
		<p class="text-xs text-zinc-500 mb-4">${settingsSummary(t)}</p>
		${t.status === "announced" ? `<p class="text-sm text-zinc-300 mb-4">${t.checkin_at ? `Check-in opens by itself ${escHtml(new Date(t.checkin_at).toLocaleString())}.` : "Check-in opens when you press Open check-in now. Set a start time to open it by itself."}</p>` : ""}
		${_editing ? formHtml(t) : ""}
		<div class="flex gap-2 flex-wrap mb-6">${actions}</div>
		${t.status === "live" ? liveHtml(t) : ""}
		${t.status === "finished" ? resultsHtml(t) : ""}
		${staffChatSlot(t)}
		${["draft", "announced", "open"].includes(t.status) ? rosterHtml(t) : ""}
		${t.rounds.length ? bracketHtml(t) : ""}`;
}

const inviteLink = (t) => `${location.origin}/tournament/${t.id}?invite=${t.invite_code}`;

/** An invite link lets players add themselves, checked in, while check-in is open. */
function inviteHtml(t) {
	if (!t.invite_code)
		return `<div class="flex items-center gap-3 flex-wrap mb-3 max-w-2xl">
			<button data-on-click="setTournamentInvite(true)" class="m-btn m-btn-tonal m-btn-sm"><span class="material-symbols-outlined">link</span>Make an invite link</button>
			<span class="text-xs text-zinc-500">Players with the link can join themselves while check-in is open.</span>
		</div>`;
	return `<div class="bg-zinc-900 rounded-2xl px-4 py-3 mb-3 max-w-2xl">
		<div class="flex items-center gap-2 flex-wrap">
			<span class="text-sm font-semibold">Invite code</span>
			<span class="font-mono tracking-widest text-lg">${escHtml(t.invite_code)}</span>
			<button data-on-click="copyTournamentInvite()" class="m-btn m-btn-tonal m-btn-sm ml-auto"><span class="material-symbols-outlined">content_copy</span>Copy link</button>
			<button data-on-click="setTournamentInvite(true)" class="m-btn m-btn-text m-btn-sm">New code</button>
			<button data-on-click="setTournamentInvite(false)" class="m-btn m-btn-text m-btn-sm">Turn off</button>
		</div>
		<p class="text-xs text-zinc-500 mt-1 break-all">${escHtml(inviteLink(t))}</p>
		<p class="text-xs text-zinc-500 mt-1">${t.status === "open" ? "Players who open the link can join, checked in straight away." : "The link starts working once check-in is open."} A new code stops the old one working.</p>
	</div>`;
}

const setTournamentInvite = (on) => act("/invite", { json: { on } }, on ? "Invite code ready" : "Invites off");

async function copyTournamentInvite() {
	if (await copyText(inviteLink(_tournament))) showToast("Invite link copied", "success");
}

function rosterHtml(t) {
	const checked = t.roster.filter((r) => r.checked_in).length;
	return `<section class="mb-6">
		<div class="flex items-center gap-2 mb-2">
			<h3 class="font-bold">Players</h3>
			<span class="text-xs text-zinc-500">${t.roster.length} on the list · ${checked} checked in${t.roster.some((r) => r.invite_code) ? ` · ${t.roster.filter((r) => r.invite_code).length} joined by invite` : ""}</span>
			<button data-on-click="shuffleTournament()" class="m-btn m-btn-text m-btn-sm ml-auto"><span class="material-symbols-outlined">shuffle</span>Shuffle</button>
		</div>
		<p class="text-xs text-zinc-500 mb-3">Seeding is by duel rating, highest first; players on the same rating keep this list's order. The top seed meets the lowest in the opening round, and the top two can only meet in the final. Players check in on the tournament page; you can tick them in here too.</p>
		${inviteHtml(t)}
		<form data-on-submit="addTournamentPlayers(event)" class="flex gap-2 mb-3 max-w-2xl">
			<input name="usernames" class="m-field flex-1" placeholder="Usernames, separated by spaces or commas" autocomplete="off" />
			<button class="m-btn m-btn-filled">Add</button>
		</form>
		<div class="flex flex-col gap-1.5 max-w-2xl">${
			t.roster.length
				? t.roster
						.map((r, i) => {
							const p = t.players[r.user_id] || {};
							return `<div class="bg-zinc-900 rounded-xl px-3 py-2 flex items-center gap-3">
								<span class="text-xs font-mono text-zinc-600 w-5 text-right">${i + 1}</span>
								${avatarHtml(p.avatar_url, "w-7 h-7")}
								<button data-on-click="openUserPanel(${r.user_id})" class="flex-1 min-w-0 text-left text-sm truncate hover:underline">${escHtml(p.display_name || p.username || "Player")} <span class="text-zinc-500">@${escHtml(p.username || "")}</span></button>
								${r.invite_code ? `<span class="text-xs text-zinc-500 flex-shrink-0" title="Joined with this invite code">via <span class="font-mono">${escHtml(r.invite_code)}</span></span>` : ""}
								<button data-on-click="setTournamentCheckIn(${r.user_id}, ${!r.checked_in})" class="m-tag ${r.checked_in ? "success" : ""}" title="${r.checked_in ? "Mark as not here" : "Check them in"}">${r.checked_in ? "Checked in" : "Not checked in"}</button>
								<button data-on-click="moveTournamentPlayer(${r.user_id}, -1)" class="m-icon-btn" aria-label="Move up" ${i === 0 ? "disabled" : ""}><span class="material-symbols-outlined">arrow_upward</span></button>
								<button data-on-click="moveTournamentPlayer(${r.user_id}, 1)" class="m-icon-btn" aria-label="Move down" ${i === t.roster.length - 1 ? "disabled" : ""}><span class="material-symbols-outlined">arrow_downward</span></button>
								<button data-on-click="removeTournamentPlayer(${r.user_id})" class="m-icon-btn" aria-label="Remove"><span class="material-symbols-outlined">close</span></button>
							</div>`;
						})
						.join("")
				: '<p class="text-sm text-zinc-500 py-4">Nobody yet. Add players by username.</p>'
		}</div>
	</section>`;
}

const SPOTLIGHT_CHOICES = [
	[0, "The final"],
	[1, "The semi-finals"],
	[2, "The quarter-finals"],
	[3, "The round of 16"],
	[10, "The first round (never all at once)"],
];

/** "One at a time from the quarter-finals", in words, for a bracket of any size. */
const spotlightText = (from) =>
	from >= 10
		? "every match one at a time"
		: `all at once until ${SPOTLIGHT_CHOICES.find(([n]) => n === from)?.[1].toLowerCase() ?? "the quarter-finals"}`;

function settingsSummary(t) {
	const s = t.settings;
	const rounds =
		s.rounds === s.semiRounds && s.rounds === s.finalRounds
			? `${roundsText(s.rounds)} a match`
			: `${roundsText(s.rounds)} a match, ${s.semiRounds} in the semi-finals, ${s.finalRounds} in the final`;
	return [
		rounds,
		spotlightText(s.spotlightFrom ?? 2),
		s.thirdPlace ? "match for third place" : "",
		s.lockSuggestions !== false ? "suggestions closed while it runs" : "",
	]
		.filter(Boolean)
		.join(" · ");
}

const allTournamentMatches = (t) =>
	t.rounds.flatMap((round, r) => round.matches.map((m) => ({ ...m, round: r, roundName: round.name })));

/** "Match 5" by play order, or "3rd place". */
function matchLabel(t, m) {
	if (m.third) return "3rd place";
	const order = allTournamentMatches(t)
		.filter((x) => !x.third)
		.sort((a, b) => a.round - b.round || a.index - b.index);
	return `Match ${order.findIndex((x) => x.id === m.id) + 1}`;
}

/** A player's name, with whether they are ready when it matters. */
function playerHtml(t, m, side, { ready = false } = {}) {
	const id = m.players[side];
	if (id === null)
		return m.closed[side]
			? '<span class="text-zinc-500">Bye</span>'
			: '<span class="text-zinc-600">To be decided</span>';
	const won = m.status === "done" && m.winner === id;
	const isReady = t.ready.includes(id);
	return `<span class="inline-flex items-center gap-1 min-w-0 ${won ? "font-semibold text-white" : m.status === "done" ? "text-zinc-500" : ""}">
		${ready ? `<span class="material-symbols-outlined text-base ${isReady ? "text-green-400" : "text-zinc-600"}" title="${isReady ? "Ready" : "Not ready"}" style="font-variation-settings:'FILL' ${isReady ? 1 : 0}">${isReady ? "check_circle" : "radio_button_unchecked"}</span>` : ""}
		<span class="truncate">${escHtml(nameOf(t, id))}</span>
		${m.scores ? `<span class="font-mono text-xs text-zinc-500">${m.scores[side].toLocaleString()}</span>` : ""}
	</span>`;
}

const smallBtn = (onclick, label, tone = "m-btn-text") =>
	`<button data-on-click="${onclick}" class="m-btn ${tone} m-btn-sm">${label}</button>`;

function matchRow(t, m, { ready = false, actions = "" } = {}) {
	return `<div class="grid grid-cols-[5rem_1fr] sm:grid-cols-[5rem_1fr_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 border-b border-zinc-800 last:border-0">
		<span class="text-xs text-zinc-500">${matchLabel(t, m)}</span>
		<span class="flex flex-wrap items-center gap-x-2 text-sm min-w-0">${playerHtml(t, m, 0, { ready })}<span class="text-zinc-600">vs</span>${playerHtml(t, m, 1, { ready })}</span>
		<span class="col-span-2 sm:col-span-1 flex flex-wrap justify-end gap-1">${actions}</span>
	</div>`;
}

const card = (title, body, note = "") =>
	`<section class="bg-zinc-900 rounded-2xl mb-4 max-w-4xl overflow-hidden">
		<div class="px-4 pt-3 pb-2 flex items-baseline gap-2"><h3 class="font-semibold text-sm">${title}</h3>${note ? `<span class="text-xs text-zinc-500">${note}</span>` : ""}</div>
		${body}
	</section>`;

function liveHtml(t) {
	const phase = t.phase;
	const matches = allTournamentMatches(t);
	const timed = phase.kind === "break" || phase.kind === "result";
	const paused = phase.paused_left !== null;
	const played = matches.some((m) => m.game_id !== null);
	const batch = phase.round !== null;
	const roundName = batch ? t.rounds[phase.round].name : "";
	const current = phase.match_id !== null ? matches.find((m) => m.id === phase.match_id) : null;
	const vs = (m) => `${escHtml(nameOf(t, m.players[0]))} vs ${escHtml(nameOf(t, m.players[1]))}`;
	const headline =
		phase.kind === "break"
			? batch
				? `${roundName} starts soon`
				: current
					? `Next: ${vs(current)}`
					: "Break"
			: phase.kind === "batch"
				? `${roundName} in play`
				: phase.kind === "hold"
					? "Waiting for staff"
					: phase.kind === "match" && current
						? `Playing: ${vs(current)}`
						: (PHASE_TEXT[phase.kind] ?? phase.kind);

	const waiting = matches.filter(
		(m) =>
			m.status === "waiting" &&
			m.players.every((p, i) => p !== null && !m.closed[i]) &&
			((batch && m.round === phase.round) || (!batch && current?.id === m.id && phase.kind !== "match"))
	);
	const live = matches.filter((m) => m.status === "live");

	const waitingActions = (m) => {
		const readyCount = m.players.filter((p) => t.ready.includes(p)).length;
		const readyPlayer = m.players.find((p) => t.ready.includes(p));
		return [
			phase.kind === "batch" ? smallBtn(`startTournamentMatch(${m.id})`, "Start", "m-btn-tonal") : "",
			readyCount === 1
				? smallBtn(`removeUnreadyPlayer(${m.id})`, `Not ready: ${escHtml(nameOf(t, readyPlayer))} goes through`)
				: "",
			...m.players.map((p) => smallBtn(`awardTournamentMatch(${m.id}, ${p})`, `${escHtml(nameOf(t, p))} wins`)),
		].join("");
	};
	const liveActions = (m) =>
		[
			`<a href="/duel/${escHtml(m.code)}?spectate" target="_blank" rel="noopener" class="m-btn m-btn-tonal m-btn-sm">Watch</a>`,
			phase.kind === "batch"
				? smallBtn(
						`featureTournamentMatch(${t.featured === m.id ? "null" : m.id})`,
						t.featured === m.id ? "Featured" : "Feature",
						t.featured === m.id ? "m-btn-filled" : "m-btn-text"
					)
				: "",
			smallBtn(`restartTournamentMatch(${m.id})`, "Restart"),
			...m.players.map((p) => smallBtn(`awardTournamentMatch(${m.id}, ${p})`, `${escHtml(nameOf(t, p))} wins`)),
		].join("");

	const now = `<section class="bg-zinc-900 rounded-2xl p-5 mb-4 max-w-4xl">
		<div class="flex items-start gap-4">
			<div class="flex-1 min-w-0">
				<div class="text-xs uppercase tracking-wider text-zinc-500 font-medium">Now</div>
				<div class="font-bold text-lg mt-0.5">${headline}</div>
				${phase.kind === "hold" && HOLD_REASONS[phase.reason] ? `<p class="text-sm text-amber-300 mt-1">${HOLD_REASONS[phase.reason]}</p>` : ""}
				${phase.kind === "batch" ? `<p class="text-sm text-zinc-400 mt-1">${live.length} playing · ${waiting.length} waiting · ${matches.filter((m) => m.round === phase.round && m.status === "done").length} done</p>` : ""}
			</div>
			${timed ? `<div class="text-3xl font-mono font-bold tabular-nums" ${paused ? "" : `data-ends="${phase.ends_at}" data-offset="${t.now - Date.now()}"`}>${paused ? "Paused" : ""}</div>` : ""}
		</div>
		<div class="flex gap-2 flex-wrap mt-4">
			${timed ? `<button data-on-click="tournamentControl('skip')" class="m-btn m-btn-filled m-btn-sm">${phase.kind === "break" ? "Start now" : "Move on"}</button>` : ""}
			${timed ? `<button data-on-click="tournamentControl('add_time')" class="m-btn m-btn-tonal m-btn-sm">+1 minute</button>` : ""}
			${timed ? `<button data-on-click="tournamentControl('${paused ? "resume" : "pause"}')" class="m-btn m-btn-tonal m-btn-sm">${paused ? "Resume" : "Pause"}</button>` : ""}
			${phase.kind === "hold" || (phase.kind === "batch" && waiting.length) ? `<button data-on-click="tournamentControl('continue')" class="m-btn m-btn-success m-btn-sm">${phase.kind === "batch" ? "Start all waiting" : "Continue"}</button>` : ""}
			${!played ? `<button data-on-click="redrawTournament()" class="m-btn m-btn-text m-btn-sm">Draw the bracket again</button>` : ""}
		</div>
		<form data-on-submit="sendTournamentMessage(event)" class="flex gap-2 mt-4 pt-4 border-t border-zinc-800">
			<input name="text" maxlength="200" class="m-field flex-1" placeholder="Message everyone watching" value="${escHtml(t.message?.text || "")}" />
			<button class="m-btn m-btn-tonal">Post</button>
			${t.message ? `<button type="button" data-on-click="clearTournamentMessage()" class="m-btn m-btn-text">Clear</button>` : ""}
		</form>
	</section>`;

	return (
		now +
		(waiting.length
			? card(
					phase.kind === "batch" ? "Waiting to start" : "Up next",
					waiting.map((m) => matchRow(t, m, { ready: true, actions: waitingActions(m) })).join(""),
					phase.kind === "batch" ? "Each starts by itself once both players are ready" : ""
				)
			: "") +
		(live.length
			? card(
					"Playing now",
					live.map((m) => matchRow(t, m, { actions: liveActions(m) })).join(""),
					`${live.length}`
				)
			: "")
	);
}

function resultsHtml(t) {
	const until = t.results_until ? t.results_until * 1000 : null;
	const showing = until !== null && until > Date.now();
	const later = new Date(Date.now() + 12 * 3600 * 1000);
	return `<section class="bg-zinc-900 rounded-2xl p-5 mb-6 max-w-3xl">
		<div class="text-xs uppercase tracking-wider text-zinc-500 font-semibold">Results</div>
		<p class="font-semibold mt-1">${showing ? `On the home page and Specials until ${escHtml(new Date(until).toLocaleString())}` : "Not on the home page"}</p>
		<p class="text-xs text-zinc-500 mt-1">The results page stays at its link either way.</p>
		<form data-on-submit="setTournamentResults(event)" class="flex gap-2 flex-wrap items-center mt-4">
			<label class="text-xs text-zinc-400 flex items-center gap-2">Show until
				<input name="until" type="datetime-local" class="m-field !w-auto" value="${toLocalInput(Math.floor((showing ? until : later.getTime()) / 1000))}" required />
			</label>
			<button class="m-btn m-btn-filled m-btn-sm">${showing ? "Change" : "Show"}</button>
			${showing ? '<button type="button" data-on-click="hideTournamentResults()" class="m-btn m-btn-text m-btn-sm">Hide now</button>' : ""}
		</form>
	</section>`;
}

function setTournamentResults(e) {
	e.preventDefault();
	const until = new Date(e.target.until.value).getTime();
	act("/results", { json: { until } }, "Saved");
}

const hideTournamentResults = () => act("/results", { json: { until: null } }, "Hidden");

/** The current round is open; the others fold away. */
function bracketHtml(t) {
	const live = t.status === "live";
	const matches = allTournamentMatches(t);
	const currentRound = live
		? (t.phase.round ??
			matches.find((m) => m.id === t.phase.match_id)?.round ??
			matches.find((m) => m.status !== "done")?.round)
		: null;
	return `<section class="max-w-4xl">
		<h3 class="text-xs uppercase tracking-wider text-zinc-500 font-medium mb-2 mt-6">Bracket</h3>
		${t.rounds
			.map((round, r) => {
				const inRound = matches
					.filter((m) => m.round === r)
					.sort((a, b) => (a.third ? -1 : a.index) - (b.third ? -1 : b.index));
				const done = inRound.filter((m) => m.status === "done").length;
				return `<details class="bg-zinc-900 rounded-2xl mb-2 overflow-hidden" ${!live || r === currentRound ? "open" : ""}>
					<summary class="cursor-pointer select-none px-4 py-3 flex items-center gap-2 text-sm">
						<span class="font-semibold">${escHtml(round.name)}</span>
						<span class="text-xs text-zinc-500">${roundsText(round.match_rounds)} · ${done} of ${inRound.length} done</span>
					</summary>
					<div class="border-t border-zinc-800">${inRound.map((m) => matchRow(t, m, { actions: bracketActions(t, m, live) })).join("")}</div>
				</details>`;
			})
			.join("")}
	</section>`;
}

/** In the bracket: the result of a finished match, or changing who plays in one that hasn't started. */
function bracketActions(t, m, live) {
	if (m.status === "done") return `<span class="m-tag">${DECIDED_LABELS[m.decided] ?? "Played"}</span>`;
	if (m.status === "live") return '<span class="text-xs text-blue-400">Playing now</span>';
	if (!live) return "";
	const known = (side) => m.players[side] !== null || m.closed[side] || m.round === 0;
	return [0, 1]
		.filter(known)
		.map((side) => {
			const id = m.players[side];
			return id === null
				? smallBtn(`setTournamentSlot(${m.id}, ${side})`, "Fill")
				: `${smallBtn(`setTournamentSlot(${m.id}, ${side})`, `Swap ${escHtml(nameOf(t, id))}`)}${smallBtn(`removeTournamentPlayer(${id})`, `Take out ${escHtml(nameOf(t, id))}`)}`;
		})
		.join("");
}

const DECIDED_LABELS = {
	bye: "Walkover",
	staff: "Staff decision",
	forfeit: "Forfeit",
	no_show: "No-show",
	not_ready: "Didn't ready up",
	sudden_death: "Sudden death",
	tiebreak: "Tiebreak",
};

let _lastPoll = 0;

function tickClock() {
	if (currentTab !== "tournaments") return clearInterval(_clock);
	if (
		!live.connected &&
		["announced", "open", "live"].includes(_tournament?.status) &&
		Date.now() - _lastPoll > 5000 &&
		!_busy &&
		!_editing
	) {
		_lastPoll = Date.now();
		api(`/api/admin/tournaments/${_tournamentId}`)
			.then((t) => {
				if (t.id !== _tournamentId || t.version === _tournament?.version || _editing) return;
				_tournament = t;
				renderTournament();
			})
			.catch(() => {});
	}
	for (const node of document.querySelectorAll("#tab-content [data-ends]")) {
		const left = Math.max(
			0,
			Math.ceil((Number(node.dataset.ends) - Date.now() - Number(node.dataset.offset || 0)) / 1000)
		);
		node.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
	}
}

async function act(path, options = {}, done = "") {
	if (_busy) return;
	_busy = true;
	try {
		const t = await api(`/api/admin/tournaments/${_tournamentId}${path}`, { method: "POST", ...options });
		_tournament = t.tournament || t;
		if (done) showToast(done, "success");
		renderTournament();
		return t;
	} catch (err) {
		showToast(err.message, "error");
	} finally {
		_busy = false;
	}
}

const tournamentAction = (name) =>
	act(`/${name}`, {}, name === "open" ? "Check-in is open" : name === "announce" ? "Announced" : "");
const tournamentControl = (action) => act("/control", { json: { action } });

async function startTournament() {
	try {
		_tournament = await api(`/api/admin/tournaments/${_tournamentId}`);
		renderTournament();
	} catch {}
	const checked = _tournament.roster.filter((r) => r.checked_in).length;
	const ok = await showConfirm(
		"Start the tournament?",
		`The bracket is drawn from the ${checked} checked-in player${checked === 1 ? "" : "s"}, and the countdown to the first match begins. Anyone not checked in is left out; you can still add them to an empty place later.`,
		{ confirmLabel: "Start", confirmClass: "m-btn-success" }
	);
	if (ok) act("/start", {}, "Started");
}

async function redrawTournament() {
	if (
		await showConfirm("Draw the bracket again?", "Everyone checked in gets a new place, seeded by duel rating.", {
			confirmLabel: "Draw again",
			confirmClass: "m-btn-filled",
		})
	)
		act("/redraw");
}

async function backToCheckin() {
	if (
		await showConfirm(
			"Go back to check-in?",
			"The bracket and any match being played are dropped, and nobody wins. Everyone on the list stays, and anyone checked in stays checked in. New players can join, then start the tournament again to draw a fresh bracket.",
			{ confirmLabel: "Back to check-in" }
		)
	)
		act("/reset", {}, "Back to check-in");
}

async function cancelTournament() {
	if (
		await showConfirm(
			"Cancel the tournament?",
			"Any match being played is stopped and nobody wins. This can't be undone.",
			{ confirmLabel: "Cancel tournament" }
		)
	)
		act("/cancel", {}, "Tournament cancelled");
}

async function deleteTournament() {
	if (
		!(await showConfirm("Delete this tournament?", "Its bracket and results are removed for good.", {
			confirmLabel: "Delete",
		}))
	)
		return;
	try {
		await api(`/api/admin/tournaments/${_tournamentId}`, { method: "DELETE" });
		backToTournaments();
	} catch (err) {
		showToast(err.message, "error");
	}
}

async function addTournamentPlayers(e) {
	e.preventDefault();
	const input = e.target.usernames;
	const result = await act("/players", { json: { usernames: input.value } });
	if (!result) return;
	if (result.missing.length) showToast(`No player called ${result.missing.join(", ")}`, "error");
	else if (result.limited.length)
		showToast(`Not added, their duels are limited: ${result.limited.join(", ")}`, "error");
	else if (result.added.length) showToast(`Added ${result.added.length}`, "success");
	el("tab-content").querySelector("[name=usernames]")?.focus();
}

const setTournamentCheckIn = (userId, value) => act(`/players/${userId}/checkin`, { json: { checked_in: value } });
const moveTournamentPlayer = (userId, by) => act(`/players/${userId}/move`, { json: { by } });
const shuffleTournament = () => act("/shuffle", {}, "Shuffled");

async function removeTournamentPlayer(userId) {
	const t = _tournament;
	if (t.status === "live") {
		const ok = await showConfirm(
			`Take ${nameOf(t, userId)} out?`,
			"They leave the bracket and their opponent goes through. A match they're playing ends now.",
			{ confirmLabel: "Take out" }
		);
		if (!ok) return;
	}
	act(`/players/${userId}`, { method: "DELETE" });
}

async function setTournamentSlot(matchId, side) {
	const username = await showPrompt("Who plays here?", "Username", {
		note: "They can be anyone not already in the bracket. Their match countdown starts again if it's next.",
		okLabel: "Put them in",
	});
	if (username) act(`/matches/${matchId}/slot`, { json: { side, username } });
}

async function awardTournamentMatch(matchId, userId) {
	const ok = await showConfirm(
		`Give the match to ${nameOf(_tournament, userId)}?`,
		"They go through without the match being played to the end.",
		{
			confirmLabel: "Give the match",
			confirmClass: "m-btn-filled",
		}
	);
	if (ok) act(`/matches/${matchId}/award`, { json: { user_id: userId } });
}

const startTournamentMatch = (matchId) => act(`/matches/${matchId}/start`, {}, "Started");
const featureTournamentMatch = (matchId) => act("/feature", { json: { match_id: matchId } });

async function removeUnreadyPlayer(matchId) {
	const m = allTournamentMatches(_tournament).find((x) => x.id === matchId);
	const readyId = m?.players.find((p) => _tournament.ready.includes(p));
	const out = m?.players.find((p) => p !== readyId);
	if (readyId === undefined || out === undefined) return;
	const ok = await showConfirm(
		`Put ${nameOf(_tournament, out)} out?`,
		`They didn't ready up, so ${nameOf(_tournament, readyId)} goes through.`,
		{ confirmLabel: "Put them out" }
	);
	if (ok) act(`/matches/${matchId}/not-ready`);
}

async function restartTournamentMatch(matchId) {
	if (
		await showConfirm(
			"Restart this match?",
			"It stops now and starts again from the first round after a short break.",
			{ confirmLabel: "Restart", confirmClass: "m-btn-filled" }
		)
	)
		act(`/matches/${matchId}/restart`);
}

function sendTournamentMessage(e) {
	e.preventDefault();
	act("/message", { json: { text: e.target.text.value } }, "Posted");
}

const clearTournamentMessage = () => act("/message", { json: { text: "" } });

onLive("tournament", (summary) => {
	if (currentTab !== "tournaments" || !_tournamentId || _busy) return;
	if (summary && summary.id !== _tournamentId) return;
	if (summary && _tournament && summary.version === _tournament.version) return;
	api(`/api/admin/tournaments/${_tournamentId}`)
		.then((t) => {
			if (_editing || t.id !== _tournamentId) return;
			_tournament = t;
			renderTournament();
		})
		.catch(() => {});
});

Object.assign(window, {
	addTournamentPlayers,
	awardTournamentMatch,
	backToTournaments,
	cancelTournament,
	clearTournamentMessage,
	copyTournamentInvite,
	deleteTournament,
	featureTournamentMatch,
	hideTournamentResults,
	loadTournaments,
	moveTournamentPlayer,
	newTournament,
	openTournament,
	redrawTournament,
	backToCheckin,
	removeTournamentPlayer,
	removeUnreadyPlayer,
	resetTournamentHistory,
	restartTournamentMatch,
	saveTournament,
	sendTournamentMessage,
	setTournamentCheckIn,
	setTournamentInvite,
	setTournamentResults,
	setTournamentSlot,
	shuffleTournament,
	startTournament,
	startTournamentMatch,
	toggleTournamentEdit,
	tournamentAction,
	tournamentControl,
});
