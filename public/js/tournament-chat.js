import { avatarHtml, el, escHtml } from "./lib/dom.js";
import { api, loginUrl } from "./lib/api.js";
import { live, onLive } from "./lib/live.js";

const KEEP = 200;
const POLL_MS = 5000;
const OPEN_KEY = "tournament-chat-open";
const HIDDEN_KEY = "tournament-chat-hidden";
const ROLE_NAMES = {
	curator: "Curator",
	moderator: "Moderator",
	supervisor: "Supervisor",
	admin: "Admin",
	operator: "Operator",
};
/** `OFF` hides chat entirely; `IN_ROUND` hides it from a player while their round is in play. */
const OFF = "Chat is off.";
const IN_ROUND = "Chat opens between rounds.";

let id = 0;
let user = null;
let access = null;
let emotes = {};
let messages = [];
let open = false;
let unread = 0;
let pickerOpen = false;
let sending = false;
let hidden = new Set();
/** Redrawing the message box loses the draft, so it only happens when this changes. */
let footFor = "";

const store = {
	get(key, fallback) {
		try {
			return JSON.parse(localStorage.getItem(key)) ?? fallback;
		} catch {
			return fallback;
		}
	},
	set(key, value) {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {}
	},
};

const iconBtn = (attrs, icon, label, extra = "") =>
	`<button ${attrs} class="w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 flex-shrink-0 ${extra}" aria-label="${label}" title="${label}"><span class="material-symbols-outlined text-xl">${icon}</span></button>`;

export function startChat(tournamentId, viewer) {
	id = tournamentId;
	user = viewer;
	open = store.get(OPEN_KEY, false) === true;
	hidden = new Set(store.get(HIDDEN_KEY, []));

	const toggle = document.createElement("button");
	toggle.id = "chat-toggle";
	toggle.className =
		"hidden fixed right-4 bottom-4 z-[47] h-11 pl-3 pr-4 rounded-full bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-sm font-medium items-center gap-2 shadow-lg transition";
	toggle.setAttribute("aria-controls", "chat-panel");
	toggle.addEventListener("click", () => setOpen(true));
	document.body.appendChild(toggle);

	const panel = document.createElement("aside");
	panel.id = "chat-panel";
	panel.setAttribute("aria-label", "Chat");
	panel.className =
		"hidden fixed z-[47] inset-x-0 bottom-0 h-[60vh] rounded-t-2xl lg:left-auto lg:right-0 lg:top-0 lg:h-auto lg:w-[340px] lg:rounded-none bg-zinc-900 border-t lg:border-t-0 lg:border-l border-zinc-800 flex-col shadow-2xl";
	panel.innerHTML = `
		<div class="flex items-center justify-between px-4 py-2 border-b border-zinc-800 flex-shrink-0">
			<span class="font-semibold">Chat</span>
			${iconBtn('data-chat="close"', "close", "Close chat")}
		</div>
		<div id="chat-list" class="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-0.5 text-sm"></div>
		<div id="chat-foot" class="border-t border-zinc-800 p-3 flex-shrink-0"></div>`;
	panel.addEventListener("click", onClick);
	panel.addEventListener("submit", onSubmit);
	document.body.appendChild(panel);
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && open) setOpen(false);
	});

	onLive("chat", (data) => (data ? add(data.messages || []) : load()));
	onLive("chat_remove", (data) => {
		if (!data) return;
		messages = data.all ? [] : messages.filter((m) => !data.ids.includes(m.id));
		renderList();
	});
	onLive("chat_access", (data) => {
		if (!data) return;
		const couldRead = access?.read;
		access = data;
		if (data.read && !couldRead) load();
		else {
			if (!data.read) messages = [];
			render();
		}
	});
	setInterval(() => !live.connected && !document.hidden && access?.read && load(), POLL_MS);
	load();
}

/** Clears the duel screen's corner controls. */
export function setChatInMatch(value) {
	const toggle = el("chat-toggle");
	toggle?.classList.toggle("bottom-4", !value);
	toggle?.classList.toggle("bottom-40", value);
}

async function load() {
	try {
		const data = await api(`/api/tournaments/${id}/chat`);
		access = data.access;
		emotes = data.emotes || {};
		messages = data.messages || [];
	} catch {
		return;
	}
	render();
	scrollDown();
}

function setOpen(value) {
	open = value;
	store.set(OPEN_KEY, open);
	if (open) unread = 0;
	render();
	if (open) {
		scrollDown();
		el("chat-input")?.focus({ preventScroll: true });
	}
}

const absent = () => !access || access.why === OFF || access.why === IN_ROUND;

function render() {
	const panel = el("chat-panel");
	if (!panel) return;
	const gone = absent();
	renderToggle();
	panel.classList.toggle("hidden", gone || !open);
	panel.classList.toggle("flex", !gone && open);
	if (gone) return;
	renderList();
	renderFoot();
}

function renderToggle() {
	const toggle = el("chat-toggle");
	if (!toggle) return;
	const gone = absent();
	toggle.classList.toggle("hidden", gone || open);
	toggle.classList.toggle("flex", !gone && !open);
	toggle.innerHTML = `<span class="material-symbols-outlined text-xl">chat</span>Chat${
		unread
			? `<span class="min-w-5 h-5 px-1.5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center">${unread > 99 ? "99+" : unread}</span>`
			: ""
	}`;
	toggle.setAttribute("aria-expanded", String(open));
}

/** `:fire:` becomes the fire emote; everything else stays text. */
function bodyHtml(body) {
	return body
		.split(/(:[a-z]+:)/)
		.map((part) => {
			const icon = part.length > 2 && part.startsWith(":") ? emotes[part.slice(1, -1)] : null;
			return icon
				? `<span class="material-symbols-outlined align-middle text-[1.35em] leading-none" style="font-variation-settings: 'FILL' 1" title="${escHtml(part)}">${escHtml(icon)}</span>`
				: escHtml(part);
		})
		.join("");
}

function messageHtml(m) {
	const mine = user && m.user_id === user.id;
	const actions = mine
		? ""
		: `<span class="hidden group-hover:flex group-focus-within:flex absolute right-1 top-0.5 bg-zinc-900 rounded-full">
			${iconBtn(`data-chat="report" data-id="${m.id}"`, "flag", "Report", "!w-7 !h-7 [&>span]:!text-base")}
			${iconBtn(`data-chat="hide" data-user="${m.user_id}"`, "visibility_off", `Hide messages from ${escHtml(m.name)}`, "!w-7 !h-7 [&>span]:!text-base")}
		</span>`;
	return `<div class="group relative flex gap-2 px-1.5 py-1 rounded-lg hover:bg-zinc-800/50" tabindex="-1">
		<span class="flex-shrink-0 mt-0.5">${avatarHtml(m.avatar_url, "w-6 h-6")}</span>
		<div class="min-w-0 break-words leading-snug">
			<span class="font-medium ${m.role ? "text-blue-300" : "text-zinc-400"}">${escHtml(m.name)}</span>${
				m.role ? ` <span class="text-[11px] text-zinc-500">${ROLE_NAMES[m.role] || ""}</span>` : ""
			}
			<span class="text-zinc-100">${bodyHtml(m.body)}</span>${
				m.held ? `<span class="block text-xs text-zinc-500">Waiting for staff to approve</span>` : ""
			}
		</div>
		${actions}
	</div>`;
}

function renderList() {
	const list = el("chat-list");
	if (!list || !open || absent()) return;
	const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
	const shown = access.read ? messages.filter((m) => !hidden.has(m.user_id)) : [];
	const unhide =
		hidden.size && access.read
			? `<button data-chat="unhide" class="text-xs text-zinc-500 hover:text-zinc-300 self-center my-1">Show hidden people (${hidden.size})</button>`
			: "";
	list.innerHTML = shown.length
		? unhide + shown.map(messageHtml).join("")
		: `<p class="text-zinc-500 text-center my-auto px-4">${access.read ? "No messages yet." : escHtml(access.why || "")}</p>${unhide}`;
	if (atBottom) scrollDown();
}

function scrollDown() {
	const list = el("chat-list");
	if (list) list.scrollTop = list.scrollHeight;
}

function renderFoot() {
	const foot = el("chat-foot");
	if (!foot) return;
	const key = JSON.stringify([access.write, access.why, access.slow_seconds, user?.id]);
	if (key === footFor && foot.childElementCount) return;
	footFor = key;
	if (!access.write) {
		const signIn = !user && access.why === "Sign in to see chat.";
		foot.innerHTML = `<p class="text-zinc-500 text-sm text-center">${escHtml(access.why || "")}${
			signIn ? ` <a href="${loginUrl()}" class="text-blue-400 hover:underline">Sign in</a>` : ""
		}</p>`;
		return;
	}
	const picker = Object.entries(emotes)
		.map(
			([code, icon]) =>
				`<button type="button" data-chat="emote" data-code="${code}" class="emote-btn" title=":${code}:" aria-label="${code}"><span class="material-symbols-outlined">${escHtml(icon)}</span></button>`
		)
		.join("");
	foot.innerHTML = `
		<form id="chat-form" class="relative flex items-center gap-1.5">
			<div class="emote-picker" hidden>${picker}</div>
			${iconBtn('type="button" data-chat="picker" aria-expanded="false"', "mood", "Emotes")}
			<input id="chat-input" class="m-field flex-1 min-w-0" maxlength="200" autocomplete="off" placeholder="Say something" aria-label="Message" />
			${iconBtn("data-chat-send", "send", "Send", "!text-blue-400 disabled:opacity-40")}
		</form>
		<p id="chat-error" class="hidden text-xs text-red-400 mt-2" role="alert"></p>
		${access.slow_seconds ? `<p class="text-xs text-zinc-500 mt-2">Slow mode: one message every ${access.slow_seconds} seconds</p>` : ""}`;
	pickerOpen = false;
}

function add(incoming) {
	if (!access?.read) return;
	const known = new Set(messages.map((m) => m.id));
	const fresh = incoming.filter((m) => !known.has(m.id));
	if (!fresh.length) return;
	messages = [...messages, ...fresh].slice(-KEEP);
	if (!open) unread += fresh.filter((m) => !hidden.has(m.user_id) && m.user_id !== user?.id).length;
	renderToggle();
	renderList();
}

function setPicker(value) {
	pickerOpen = value;
	const picker = el("chat-foot")?.querySelector(".emote-picker");
	if (picker) picker.hidden = !value;
	el("chat-foot")?.querySelector('[data-chat="picker"]')?.setAttribute("aria-expanded", String(value));
}

function showError(text) {
	const box = el("chat-error");
	if (!box) return;
	box.textContent = text;
	box.classList.toggle("hidden", !text);
}

async function onSubmit(e) {
	e.preventDefault();
	const input = el("chat-input");
	const text = input?.value.trim();
	if (!text || sending) return;
	sending = true;
	showError("");
	setPicker(false);
	const button = el("chat-form")?.querySelector("[data-chat-send]");
	if (button) button.disabled = true;
	try {
		const { message, held } = await api(`/api/tournaments/${id}/chat`, { json: { text } });
		input.value = "";
		messages = [...messages.filter((m) => m.id !== message.id), { ...message, held }].slice(-KEEP);
		renderList();
		scrollDown();
	} catch (err) {
		showError(err.message);
	} finally {
		sending = false;
		if (button) button.disabled = false;
		el("chat-input")?.focus({ preventScroll: true });
	}
}

async function onClick(e) {
	const button = e.target.closest("[data-chat]");
	if (!button) return;
	const action = button.dataset.chat;
	if (action === "close") setOpen(false);
	else if (action === "picker") setPicker(!pickerOpen);
	else if (action === "emote") {
		const input = el("chat-input");
		input.value = `${input.value}${input.value && !input.value.endsWith(" ") ? " " : ""}:${button.dataset.code}: `;
		setPicker(false);
		input.focus();
	} else if (action === "hide") {
		hidden.add(Number(button.dataset.user));
		store.set(HIDDEN_KEY, [...hidden].slice(-500));
		renderList();
	} else if (action === "unhide") {
		hidden.clear();
		store.set(HIDDEN_KEY, []);
		renderList();
	} else if (action === "report") {
		button.disabled = true;
		try {
			await api(`/api/tournaments/${id}/chat/${button.dataset.id}/report`, { method: "POST" });
			button.querySelector("span").classList.add("text-orange-400");
			button.title = "Reported";
		} catch (err) {
			showError(err.message);
			button.disabled = false;
		}
	}
}
