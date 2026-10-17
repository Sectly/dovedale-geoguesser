import { el, escHtml } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { pollWhile } from "../tickets.js";
import { showToast } from "../lib/toast.js";
import { atLeast, currentTab, showConfirm } from "./core.js";
import { formatWhen } from "./users.js";

/** The staff chat card on a tournament, and the word filter on the tournament list. */

const DELAYS = [0, 500, 1000, 1500, 2000, 3000, 5000, 10000];
const SLOW = [0, 5, 10, 30, 60, 120];
const FILTERS = [
	["all", "All"],
	["reported", "Reported"],
	["held", "Waiting"],
	["blocked", "Blocked"],
	["deleted", "Deleted"],
];
const STATUS_TAGS = {
	held: ["Waiting for approval", "warn"],
	blocked: ["Blocked", "danger"],
	deleted: ["Deleted", ""],
};
const ACTION_TEXT = { refuse: "Refuse the message", mask: "Hide the word as ****", hold: "Hold for staff" };
const POLL_MS = 3000;

let _id = null;
let _chat = null;
let _filter = "all";
let _stopPoll = null;
let _busy = false;

const seconds = (ms) => (ms === 0 ? "None" : `${ms / 1000} s`);
const timeoutText = (m) => (m < 60 ? `${m} min` : m < 1440 ? `${m / 60} hour` : `${m / 1440} day`);

/* ---- Chat card ---- */

/** Drawn from the last load, then kept up to date by live updates, or polled without them. */
export function staffChatSlot(t) {
	if (!["open", "live", "finished"].includes(t.status)) {
		stopStaffChat();
		return "";
	}
	if (_id !== t.id) {
		_id = t.id;
		_chat = null;
		_filter = "all";
	}
	_stopPoll?.();
	_stopPoll = pollWhile(watchingChat, loadChat, POLL_MS, "tournament_chat");
	if (!_chat) loadChat();
	return `<section id="staff-chat" class="bg-zinc-900 rounded-2xl mb-4 max-w-4xl overflow-hidden">${chatCardHtml()}</section>`;
}

export function stopStaffChat() {
	_stopPoll?.();
	_stopPoll = null;
	_id = null;
	_chat = null;
}

async function loadChat() {
	const id = _id;
	try {
		const chat = await api(`/api/admin/tournaments/${id}/chat`);
		if (id !== _id) return;
		_chat = chat;
	} catch {
		return;
	}
	paint();
}

function watchingChat() {
	if (currentTab !== "tournaments" || !el("staff-chat")) {
		queueMicrotask(stopStaffChat);
		return false;
	}
	return !_busy;
}

function paint() {
	const box = el("staff-chat");
	if (!box) return;
	/** Only when changed, so an open select isn't reset. */
	const html = chatCardHtml();
	if (box.dataset.html !== html) {
		box.innerHTML = html;
		box.dataset.html = html;
	}
}

function chatCardHtml() {
	const c = _chat;
	const head = `<div class="px-4 pt-3 pb-2 flex items-center gap-2 flex-wrap">
		<h3 class="font-semibold text-sm">Chat</h3>
		${c ? (c.on ? `<span class="text-xs text-green-400">On</span>` : `<span class="text-xs text-zinc-500">Off</span>`) : ""}
		${c && !c.feature ? `<span class="text-xs text-orange-400">Tournament chat is switched off for the whole site on the Features page.</span>` : ""}
	</div>`;
	if (!c) return `${head}<p class="px-4 pb-4 text-sm text-zinc-500">Loading...</p>`;
	const select = (name, values, current, label) =>
		`<label class="flex items-center gap-2 text-xs text-zinc-400">${label}
			<select data-on-change="setStaffChat({ ${name}: Number(this.value) })" class="m-field !py-1 !w-auto">${values
				.map(
					(v) =>
						`<option value="${v}" ${v === current ? "selected" : ""}>${name === "delay_ms" ? seconds(v) : v ? `${v} s` : "Off"}</option>`
				)
				.join("")}</select>
		</label>`;
	const controls = `<div class="px-4 pb-3 flex items-center gap-3 flex-wrap">
		${
			c.on
				? `<button data-on-click="setStaffChat({ on: false })" class="m-btn m-btn-tonal m-btn-sm"><span class="material-symbols-outlined">comments_disabled</span>Turn chat off</button>`
				: `<button data-on-click="setStaffChat({ on: true })" class="m-btn m-btn-filled m-btn-sm" ${c.open ? "" : "disabled"}><span class="material-symbols-outlined">chat</span>Turn chat on</button>`
		}
		${select("delay_ms", DELAYS, c.delay_ms, "Delay")}
		${select("slow_seconds", SLOW, c.slow_seconds, "Slow mode")}
		<label class="md-check">
			<input type="checkbox" ${c.staff_only ? "checked" : ""} data-on-change="setStaffChat({ staff_only: this.checked })" />
			<span class="md-check-box" aria-hidden="true"></span>
			<span class="text-sm text-zinc-200">Only staff can write</span>
		</label>
		<button data-on-click="clearStaffChat()" class="m-btn m-btn-text m-btn-sm danger ml-auto">Clear chat</button>
	</div>`;
	const counts = {
		all: c.messages.length,
		reported: c.messages.filter((m) => m.reports > 0 && m.status === "shown").length,
		held: c.messages.filter((m) => m.status === "held").length,
		blocked: c.messages.filter((m) => m.status === "blocked").length,
		deleted: c.messages.filter((m) => m.status === "deleted").length,
	};
	const tabs = `<div class="px-4 pb-2 flex gap-1 flex-wrap border-b border-zinc-800">${FILTERS.map(
		([key, label]) =>
			`<button data-on-click="filterStaffChat('${key}')" class="m-btn m-btn-sm ${_filter === key ? "m-btn-tonal" : "m-btn-text"}">${label}${
				key !== "all" && counts[key] ? ` ${counts[key]}` : ""
			}</button>`
	).join("")}</div>`;
	const shown = c.messages.filter((m) =>
		_filter === "all" ? true : _filter === "reported" ? m.reports > 0 && m.status === "shown" : m.status === _filter
	);
	const list = shown.length
		? shown.map((m) => messageRow(m, c.timeouts)).join("")
		: `<p class="px-4 py-6 text-sm text-zinc-500 text-center">Nothing here.</p>`;
	return `${head}${controls}${tabs}<div class="max-h-[28rem] overflow-y-auto">${list}</div>`;
}

function messageRow(m, timeouts) {
	const [tag, tone] = STATUS_TAGS[m.status] || [];
	const btn = (onclick, label, extra = "") =>
		`<button data-on-click="${onclick}" class="m-btn m-btn-text m-btn-sm ${extra}">${label}</button>`;
	const actions = [
		m.status === "held" ? btn(`approveStaffChat(${m.id})`, "Approve") : "",
		m.status === "shown" || m.status === "held" ? btn(`deleteStaffChat(${m.id})`, "Delete", "danger") : "",
		m.status !== "deleted" && m.user_id
			? timeouts.map((min) => btn(`timeOutStaffChat(${m.id}, ${min})`, `Time out ${timeoutText(min)}`)).join("")
			: "",
		m.reports > 0 && m.status === "shown" ? btn(`dismissStaffChat(${m.id})`, "Dismiss reports") : "",
	].join("");
	return `<div class="px-4 py-2.5 border-b border-zinc-800 last:border-0 flex flex-col gap-1">
		<div class="flex items-baseline gap-2 flex-wrap text-sm">
			<span class="text-xs text-zinc-500 tabular-nums">${new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
			${m.username ? `<a href="/u/${encodeURIComponent(m.username)}" target="_blank" rel="noopener" class="font-medium text-zinc-300 hover:underline">${escHtml(m.name)}</a>` : `<span class="font-medium text-zinc-500">${escHtml(m.name)}</span>`}
			<span class="text-zinc-100 break-words min-w-0">${escHtml(m.body)}</span>
			${tag ? `<span class="m-tag ${tone}">${tag}</span>` : ""}
			${m.reports > 0 && m.status === "shown" ? `<span class="m-tag danger">Reported ${m.reports}×</span>` : ""}
		</div>
		${m.reason ? `<p class="text-xs text-zinc-500">Caught by: ${escHtml(m.reason)}</p>` : ""}
		${m.handled_by ? `<p class="text-xs text-zinc-600">By ${escHtml(m.handled_by)}</p>` : ""}
		${actions ? `<div class="flex flex-wrap gap-1 -ml-2">${actions}</div>` : ""}
	</div>`;
}

async function chatAct(path, options = {}, done = "") {
	if (_busy || !_id) return;
	_busy = true;
	try {
		_chat = await api(`/api/admin/tournaments/${_id}/chat${path}`, { method: "POST", ...options });
		if (done) showToast(done, "success");
		paint();
	} catch (err) {
		showToast(err.message, "error");
	} finally {
		_busy = false;
	}
}

const setStaffChat = (changes) =>
	chatAct(
		"/settings",
		{ json: changes },
		changes.on === true ? "Chat is on" : changes.on === false ? "Chat is off" : ""
	);
const approveStaffChat = (messageId) => chatAct(`/${messageId}/approve`);
const deleteStaffChat = (messageId) => chatAct(`/${messageId}`, { method: "DELETE" });
const dismissStaffChat = (messageId) => chatAct(`/${messageId}/dismiss`);
const timeOutStaffChat = (messageId, minutes) =>
	chatAct(`/${messageId}/timeout`, { json: { minutes } }, `Timed out for ${timeoutText(minutes)}`);

function filterStaffChat(key) {
	_filter = key;
	paint();
}

async function clearStaffChat() {
	const ok = await showConfirm("Clear chat?", "Every message in this tournament's chat is removed for everyone.", {
		confirmLabel: "Clear chat",
	});
	if (ok) chatAct("/clear", {}, "Chat cleared");
}

/* ---- Word filter ---- */

let _filterData = null;

export function wordFilterHtml() {
	return `<details id="word-filter" class="bg-zinc-900 rounded-2xl mt-8 max-w-4xl" data-on-toggle="loadWordFilterWhenOpen(this)">
		<summary class="px-4 py-3 cursor-pointer font-semibold text-sm flex items-center gap-2"><span class="material-symbols-outlined text-zinc-400">filter_alt</span>Chat filter</summary>
		<div id="word-filter-body" class="px-4 pb-4 text-sm text-zinc-500">Loading...</div>
	</details>`;
}

async function loadWordFilter() {
	try {
		_filterData = await api("/api/admin/word-filter");
	} catch (err) {
		el("word-filter-body").textContent = err.message;
		return;
	}
	paintFilter();
}

const actionSelect = (name, current, onchange = "") =>
	`<select ${name ? `name="${name}"` : ""} ${onchange ? `onchange="${onchange}"` : ""} class="m-field !py-1 !w-auto">${Object.entries(
		ACTION_TEXT
	)
		.map(([v, label]) => `<option value="${v}" ${v === current ? "selected" : ""}>${label}</option>`)
		.join("")}</select>`;

function paintFilter() {
	const body = el("word-filter-body");
	if (!body || !_filterData) return;
	const { words, lists, limits } = _filterData;
	const blocked = words.filter((w) => w.kind === "block");
	const allowed = words.filter((w) => w.kind === "allow");
	const chip = (w) =>
		`<span class="inline-flex items-center gap-1 bg-zinc-800 rounded-lg pl-2.5 pr-1 py-0.5 text-sm text-zinc-200">${escHtml(w.word)}${
			w.kind === "block"
				? `<span class="text-xs text-zinc-500">${w.match === "contains" ? "anywhere" : "word"} · ${w.action === "refuse" ? "refuse" : w.action === "mask" ? "hide" : "hold"}</span>`
				: ""
		}<button data-on-click="removeFilterWord(${w.id})" class="w-6 h-6 rounded-full flex items-center justify-center text-zinc-500 hover:text-white hover:bg-zinc-700" aria-label="Remove ${escHtml(w.word)}"><span class="material-symbols-outlined text-base">close</span></button></span>`;
	const senior = atLeast("supervisor");
	const listRow = (l) => {
		const change =
			l.previous_count !== null && l.previous_count !== l.count
				? ` (${l.count > l.previous_count ? "+" : ""}${l.count - l.previous_count})`
				: "";
		return `<div class="py-2.5 border-b border-zinc-800 last:border-0 flex flex-col gap-1">
			<div class="flex items-center gap-2 flex-wrap">
				<a href="${escHtml(l.url)}" target="_blank" rel="noopener" class="text-zinc-200 hover:underline break-all min-w-0">${escHtml(l.url)}</a>
				${l.enabled ? "" : `<span class="m-tag">Off</span>`}
			</div>
			<p class="text-xs text-zinc-500">${l.count.toLocaleString()} words${change}${l.fetched_at ? ` · downloaded ${formatWhen(l.fetched_at)}` : ""}${l.created_by_username ? ` · added by ${escHtml(l.created_by_username)}` : ""}</p>
			${l.error ? `<p class="text-xs text-orange-400">${escHtml(l.error)}${l.count ? " The last good copy is still used." : ""}</p>` : ""}
			${
				senior
					? `<div class="flex items-center gap-1 flex-wrap -ml-2">
						${actionSelect("", l.action, `updateFilterList(${l.id}, { action: this.value })`)}
						<button data-on-click="updateFilterList(${l.id}, { enabled: ${!l.enabled} })" class="m-btn m-btn-text m-btn-sm">${l.enabled ? "Turn off" : "Turn on"}</button>
						<button data-on-click="refreshFilterList(${l.id})" class="m-btn m-btn-text m-btn-sm">Download again</button>
						<button data-on-click="removeFilterList(${l.id})" class="m-btn m-btn-text m-btn-sm danger">Remove</button>
					</div>`
					: ""
			}
		</div>`;
	};
	body.className = "px-4 pb-4 flex flex-col gap-6";
	body.innerHTML = `
		<p class="text-sm text-zinc-400 max-w-2xl">Messages with links, emoji or other alphabets are always refused. Words below are matched with number swaps, repeated letters and spaced-out letters undone.</p>

		<div class="flex flex-col gap-2">
			<h4 class="font-semibold text-sm text-zinc-200">Try a message</h4>
			<form data-on-submit="testFilter(event)" class="flex gap-2 max-w-xl">
				<input name="text" class="m-field flex-1 min-w-0" maxlength="200" placeholder="Type a message" />
				<button class="m-btn m-btn-tonal">Check</button>
			</form>
			<p id="word-filter-test" class="text-sm"></p>
		</div>

		<div class="flex flex-col gap-2">
			<h4 class="font-semibold text-sm text-zinc-200">Blocked words <span class="text-zinc-500 font-normal">${blocked.length}</span></h4>
			<form data-on-submit="addFilterWords(event, 'block')" class="flex gap-2 flex-wrap items-center">
				<input name="words" class="m-field flex-1 min-w-[12rem]" maxlength="2000" placeholder="Words or phrases, separated by commas" />
				<select name="match" class="m-field !py-1 !w-auto"><option value="word">Whole word</option><option value="contains">Anywhere in a word</option></select>
				${actionSelect("action", "refuse")}
				<button class="m-btn m-btn-filled">Add</button>
			</form>
			<div class="flex flex-wrap gap-1.5">${blocked.map(chip).join("") || `<span class="text-zinc-500">None yet.</span>`}</div>
		</div>

		<div class="flex flex-col gap-2">
			<h4 class="font-semibold text-sm text-zinc-200">Always allowed <span class="text-zinc-500 font-normal">${allowed.length}</span></h4>
			<p class="text-xs text-zinc-500">Real words that contain a blocked word, such as place names.</p>
			<form data-on-submit="addFilterWords(event, 'allow')" class="flex gap-2 max-w-xl">
				<input name="words" class="m-field flex-1 min-w-0" maxlength="2000" placeholder="Words, separated by commas" />
				<button class="m-btn m-btn-tonal">Add</button>
			</form>
			<div class="flex flex-wrap gap-1.5">${allowed.map(chip).join("") || `<span class="text-zinc-500">None yet.</span>`}</div>
		</div>

		<div class="flex flex-col gap-2">
			<h4 class="font-semibold text-sm text-zinc-200">Lists from the web <span class="text-zinc-500 font-normal">${lists.length} of ${limits.lists}</span></h4>
			<p class="text-xs text-zinc-500">A word list at an http or https address, such as a file in a GitHub repository. One word per line, separated by commas, or a JSON list. Downloaded again every day. Up to ${Math.round(limits.listBytes / 1024 / 1024)} MB and ${limits.listEntries.toLocaleString()} words each.</p>
			${
				senior
					? `<form data-on-submit="addFilterList(event)" class="flex gap-2 flex-wrap items-center">
						<input name="url" type="url" required class="m-field flex-1 min-w-[16rem]" placeholder="https://github.com/owner/repo/blob/main/words.txt" />
						${actionSelect("action", "refuse")}
						<button class="m-btn m-btn-filled">Add list</button>
					</form>`
					: `<p class="text-xs text-zinc-500">Supervisors add and remove lists.</p>`
			}
			<div>${lists.map(listRow).join("") || `<p class="text-zinc-500">None yet.</p>`}</div>
		</div>`;
}

async function filterAct(path, options, done = "") {
	try {
		_filterData = await api(`/api/admin/word-filter${path}`, options);
		if (done) showToast(done, "success");
		paintFilter();
		return true;
	} catch (err) {
		showToast(err.message, "error");
		return false;
	}
}

async function addFilterWords(e, kind) {
	e.preventDefault();
	const form = new FormData(e.target);
	const json = { words: form.get("words"), kind, match: form.get("match"), action: form.get("action") };
	await filterAct("/words", { method: "POST", json }, "Added");
}

const removeFilterWord = (wordId) => filterAct(`/words/${wordId}`, { method: "DELETE" });

async function addFilterList(e) {
	e.preventDefault();
	const form = new FormData(e.target);
	const button = e.target.querySelector("button");
	button.disabled = true;
	button.textContent = "Downloading...";
	await filterAct("/lists", { method: "POST", json: { url: form.get("url"), action: form.get("action") } });
	if (button.isConnected) {
		button.disabled = false;
		button.textContent = "Add list";
	}
}

const updateFilterList = (listId, changes) => filterAct(`/lists/${listId}`, { method: "PATCH", json: changes });
const refreshFilterList = (listId) => filterAct(`/lists/${listId}/refresh`, { method: "POST" }, "Downloaded");

async function removeFilterList(listId) {
	const list = _filterData?.lists.find((l) => l.id === listId);
	const ok = await showConfirm("Remove this list?", list?.url || "", { confirmLabel: "Remove" });
	if (ok) filterAct(`/lists/${listId}`, { method: "DELETE" }, "Removed");
}

async function testFilter(e) {
	e.preventDefault();
	const text = new FormData(e.target).get("text");
	const out = el("word-filter-test");
	try {
		const r = await api("/api/admin/word-filter/test", { json: { text } });
		const caught = r.hits.map((h) => `${escHtml(h.word)} (${escHtml(h.source)})`).join(", ");
		out.innerHTML = r.ok
			? `<span class="text-green-400">Gets through${r.held ? ", but waits for staff" : ""}.</span> <span class="text-zinc-400">Shown as: ${escHtml(r.body)}</span>${caught ? ` <span class="text-zinc-500">Caught: ${caught}</span>` : ""}`
			: `<span class="text-red-400">${escHtml(r.reason)}</span>${caught ? ` <span class="text-zinc-500">Caught: ${caught}</span>` : ""}`;
	} catch (err) {
		out.textContent = err.message;
	}
}

Object.assign(window, {
	addFilterList,
	addFilterWords,
	approveStaffChat,
	clearStaffChat,
	deleteStaffChat,
	dismissStaffChat,
	filterStaffChat,
	loadWordFilter,
	loadWordFilterWhenOpen: (details) => details.open && loadWordFilter(),
	refreshFilterList,
	removeFilterList,
	removeFilterWord,
	setStaffChat,
	testFilter,
	timeOutStaffChat,
	updateFilterList,
});
