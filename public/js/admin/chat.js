import { avatarHtml, el, errorStateHtml, escHtml, scrollBehavior, show, skeletonRows } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { showToast } from "../lib/toast.js";
import { live } from "../lib/live.js";
import { announceStaffChat, refreshAttention } from "../lib/attention.js";
import { keepThreadAtBottom, linkedTextHtml, pollWhile, ticketTime } from "../tickets.js";
import { canOpenTab, currentTab, currentUser, showConfirm } from "./core.js";
import { ROLE_BADGE, roleName } from "./users.js";

const CHAT_POLL_MS = 3000;
const CHAT_UNREAD_POLL_MS = 20_000;
/** Messages from the same person this close together are drawn as one block. */
const CHAT_GROUP_SECONDS = 300;
/** The room as last drawn, so a poll that brings nothing new leaves the page alone. */
let _chatShown = "";
let _chatPolling = false;
let _chatRoom = null;
let _chatEmotes = [];
let _chatPinsOpen = false;
let _chatPinSearch = "";

const CHAT_ALERTS = { none: "No alerts", badge: "Badge and sound", notify: "Inbox and push" };

const emoteLabel = (name) => name.replaceAll("_", " ");
const chatName = (m) => m.display_name || m.author_username || "[deleted]";

/** Bold, italic, strikethrough and :reactions: in text that is already escaped. */
function chatInlineHtml(escaped) {
	return escaped
		.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, "<strong>$1</strong>")
		.replace(/(?<![*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, "<em>$1</em>")
		.replace(/(?<![_\w])_(?=\S)([^_\n]+?)(?<=\S)_(?![_\w])/g, "<em>$1</em>")
		.replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, "<del>$1</del>")
		.replace(/:([a-z0-9_]+):/g, (typed, name) =>
			_chatEmotes.includes(name)
				? `<span class="material-symbols-outlined chat-emote" role="img" aria-label="${emoteLabel(name)}" title="${emoteLabel(name)}">${name}</span>`
				: typed
		);
}

/** Code spans stay as typed and addresses become links, so neither is read as formatting. */
function chatBodyHtml(text) {
	const body = String(text ?? "");
	const onlyEmotes = /^(\s*:[a-z0-9_]+:\s*){1,6}$/.test(body);
	const html = body
		.split(/(`[^`\n]+`)/)
		.map((part, i) =>
			i % 2
				? `<code class="bg-zinc-800 rounded px-1 py-0.5 font-mono text-[0.8125rem]">${escHtml(part.slice(1, -1))}</code>`
				: part
						.split(/(https?:\/\/[^\s<>"']+)/)
						.map((piece, j) => (j % 2 ? linkedTextHtml(piece) : chatInlineHtml(escHtml(piece))))
						.join("")
		)
		.join("");
	return onlyEmotes ? `<span class="chat-emote-only">${html}</span>` : html;
}

const chatRoleBadge = (role) =>
	role
		? `<span class="text-[11px] px-1.5 py-0.5 rounded ${ROLE_BADGE[role] || "bg-zinc-700 text-zinc-300"}">${roleName(role)}</span>`
		: "";

function chatPinHtml(m) {
	if (!m.pinned_at && !m.can_pin) return "";
	if (m.pinned_at && !m.can_unpin)
		return `<span class="material-symbols-outlined text-base text-amber-300 flex-shrink-0" style="font-variation-settings:'FILL' 1" role="img" aria-label="Pinned" title="Pinned by ${escHtml(m.pinned_by_username || "staff")}">push_pin</span>`;
	const label = m.pinned_at ? "Unpin this message" : "Pin this message";
	return `<button onclick="pinChatMessage(${m.id}, ${!m.pinned_at})" class="${m.pinned_at ? "text-amber-300 hover:text-amber-200" : "text-zinc-700 hover:text-zinc-300"} transition flex-shrink-0" aria-label="${label}" title="${label}"><span class="material-symbols-outlined text-base" ${m.pinned_at ? `style="font-variation-settings:'FILL' 1"` : ""}>push_pin</span></button>`;
}

function chatMessageHtml(m, previous) {
	const joined =
		previous &&
		m.author_id !== null &&
		previous.author_id === m.author_id &&
		m.created_at - previous.created_at < CHAT_GROUP_SECONDS;
	return `<div id="chat-msg-${m.id}" class="flex items-start gap-3 px-2 py-0.5 rounded-xl transition-colors hover:bg-zinc-900/70 ${joined ? "" : "mt-3"}">
		${joined ? '<span class="w-8 flex-shrink-0"></span>' : avatarHtml(m.avatar_url, "w-8 h-8 flex-shrink-0 mt-0.5")}
		<div class="min-w-0 flex-1">
			${
				joined
					? ""
					: `<div class="flex items-center gap-2 flex-wrap">
						<span class="text-sm font-semibold">${escHtml(chatName(m))}</span>
						${chatRoleBadge(m.role)}
						<span class="text-[11px] text-zinc-600">${ticketTime(m.created_at)}</span>
					</div>`
			}
			<div class="text-sm text-zinc-200 whitespace-pre-wrap break-words">${chatBodyHtml(m.body)}</div>
		</div>
		${chatPinHtml(m)}
		${m.can_delete ? `<button onclick="deleteChatMessage(${m.id})" class="text-zinc-700 hover:text-red-300 transition flex-shrink-0" aria-label="Delete this message" title="Delete"><span class="material-symbols-outlined text-base">delete</span></button>` : ""}
	</div>`;
}

/* ---- Pinned messages ---- */

function chatPinRowHtml(m) {
	const inRoom = _chatRoom.messages.some((shown) => shown.id === m.id);
	return `<div class="bg-zinc-800/60 rounded-xl px-3 py-2" data-search="${escHtml(`${chatName(m)} ${m.body} ${m.pinned_by_username || ""}`)}">
		<div class="flex items-center gap-2 flex-wrap">
			<span class="text-sm font-semibold">${escHtml(chatName(m))}</span>
			${chatRoleBadge(m.role)}
			<span class="text-[11px] text-zinc-500">${ticketTime(m.created_at)} · pinned by @${escHtml(m.pinned_by_username || "staff")}</span>
		</div>
		<div class="text-sm text-zinc-200 whitespace-pre-wrap break-words mt-0.5">${chatBodyHtml(m.body)}</div>
		<div class="flex gap-1 -ml-3 mt-1">
			${inRoom ? `<button onclick="jumpToChatMessage(${m.id})" class="m-btn m-btn-text m-btn-sm">Show in chat</button>` : ""}
			${m.can_unpin ? `<button onclick="pinChatMessage(${m.id}, false)" class="m-btn m-btn-text m-btn-sm">Unpin</button>` : ""}
		</div>
	</div>`;
}

function renderChatPins() {
	const { pins, pin_limit: limit, pins_used: used } = _chatRoom;
	el("chat-pin-count").textContent = pins.length;
	el("chat-pins-toggle").setAttribute("aria-expanded", String(_chatPinsOpen));
	show("chat-pins", _chatPinsOpen);
	el("chat-pins-body").innerHTML = `
		<p class="text-xs text-zinc-500">You have pinned ${used} of the ${limit} your role allows.</p>
		${
			pins.length > 3
				? `<input id="chat-pin-search" type="search" placeholder="Search pinned messages" autocomplete="off" class="m-field" aria-label="Search pinned messages" value="${escHtml(_chatPinSearch)}" oninput="filterChatPins(this.value)" />`
				: ""
		}
		${pins.map(chatPinRowHtml).join("") || '<p class="text-sm text-zinc-500 py-2">Nothing is pinned.</p>'}
		<p id="chat-pin-none" class="hidden text-sm text-zinc-500 py-2">No pinned message matches.</p>`;
	filterChatPins(_chatPinSearch);
}

function filterChatPins(text) {
	_chatPinSearch = text;
	const query = text.trim().toLocaleLowerCase();
	let visible = 0;
	const rows = document.querySelectorAll("#chat-pins-body [data-search]");
	for (const row of rows) {
		const matches = !query || row.dataset.search.toLocaleLowerCase().includes(query);
		row.classList.toggle("hidden", !matches);
		if (matches) visible++;
	}
	show("chat-pin-none", rows.length > 0 && visible === 0);
}

function toggleChatPins() {
	_chatPinsOpen = !_chatPinsOpen;
	if (_chatRoom) renderChatPins();
}

function jumpToChatMessage(id) {
	const row = el(`chat-msg-${id}`);
	if (!row) return;
	row.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
	row.classList.add("bg-amber-500/20");
	setTimeout(() => row.classList.remove("bg-amber-500/20"), 2000);
}

async function pinChatMessage(id, pinned) {
	const confirmed = pinned
		? await showConfirm("Pin this message?", "It is added to the Pinned list and is not deleted for age.", {
				confirmLabel: "Pin",
				confirmClass: "m-btn-filled",
			})
		: await showConfirm(
				"Unpin this message?",
				`It leaves the Pinned list, and is deleted once it is ${currentUser.limits.chat_retention_days} days old.`,
				{ confirmLabel: "Unpin" }
			);
	if (!confirmed) return;
	try {
		await api(`/api/admin/chat/${id}/pin`, { json: { pinned } });
		if (pinned) _chatPinsOpen = true;
	} catch (err) {
		showToast(err.message, "error");
	}
	refreshChat();
}

/* ---- The room ---- */

async function refreshChat(toBottom = false) {
	let room;
	try {
		room = await api("/api/admin/chat");
	} catch (err) {
		if (!_chatShown && el("chat-list")) el("chat-list").innerHTML = errorStateHtml(err.message);
		return;
	}
	const list = el("chat-list");
	if (!list) return;
	_chatRoom = room;
	paintChatUnread(0);
	setChatEmotes(room.emotes);
	const drawn = JSON.stringify([room.messages, room.pins, room.pins_used]);
	if (drawn !== _chatShown) {
		_chatShown = drawn;
		keepThreadAtBottom(list, () => {
			list.innerHTML = room.messages.length
				? room.messages.map((m, i) => chatMessageHtml(m, room.messages[i - 1])).join("")
				: '<p class="text-zinc-500 text-sm text-center py-16">No messages yet.</p>';
		});
		/** Left alone while someone is typing in its search box. */
		if (document.activeElement?.id !== "chat-pin-search") renderChatPins();
	}
	if (toBottom) list.scrollTop = list.scrollHeight;
}

function setChatEmotes(list) {
	const offered = Array.isArray(list) ? list.filter((name) => /^[a-z0-9_]+$/.test(name)) : [];
	if (offered.join() === _chatEmotes.join()) return;
	_chatEmotes = offered;
	/** Messages drawn before the list was known show their reactions as text, so draw them again. */
	_chatShown = "";
	show("chat-emote-toggle", offered.length > 0);
	el("chat-emotes").innerHTML = offered
		.map(
			(name) =>
				`<button data-emote="${name}" class="emote-btn" title="${emoteLabel(name)}" aria-label="${emoteLabel(name)}"><span class="material-symbols-outlined">${name}</span></button>`
		)
		.join("");
}

function toggleChatEmotes(open = el("chat-emotes").classList.contains("hidden")) {
	el("chat-emotes").classList.toggle("hidden", !open);
	el("chat-emote-toggle").setAttribute("aria-expanded", String(open));
}

function insertIntoChat(text) {
	const box = el("chat-input");
	const before = box.value.slice(0, box.selectionStart);
	const after = box.value.slice(box.selectionEnd);
	const added = `${before && !/\s$/.test(before) ? " " : ""}${text}${after && !/^\s/.test(after) ? " " : ""}`;
	box.value = (before + added + after).slice(0, box.maxLength);
	box.selectionStart = box.selectionEnd = Math.min(box.value.length, before.length + added.length);
	box.focus();
}

async function sendChatMessage() {
	const box = el("chat-input");
	const body = box.value.trim();
	if (!body) return box.focus();
	el("chat-send").disabled = true;
	try {
		await api("/api/admin/chat", { json: { body } });
		box.value = "";
		await refreshChat(true);
	} catch (err) {
		showToast(err.message, "error");
	}
	el("chat-send").disabled = false;
	box.focus();
}

async function deleteChatMessage(id) {
	if (!(await showConfirm("Delete this message?", "It is removed for everyone.", { confirmLabel: "Delete" }))) return;
	try {
		await api(`/api/admin/chat/${id}`, { method: "DELETE" });
	} catch (err) {
		showToast(err.message, "error");
	}
	refreshChat();
}

async function setChatAlerts(value) {
	try {
		currentUser.prefs = (await api("/api/settings", { json: { prefs: { staff_chat: value } } })).prefs;
	} catch (err) {
		el("chat-alerts").value = currentUser.prefs?.staff_chat ?? "badge";
		return showToast(err.message, "error");
	}
	if (value === "notify" && !currentUser.prefs.desktop)
		showToast("Push also needs desktop notifications switched on in Settings.", "info", { href: "/settings" });
	refreshAttention();
}

export function loadChat() {
	_chatShown = "";
	_chatRoom = null;
	_chatEmotes = [];
	el("tab-content").innerHTML = `<div class="flex flex-col h-full min-h-0 max-w-3xl mx-auto">
		<div class="flex items-start justify-between gap-3 flex-wrap mb-2">
			<div>
				<h2 class="font-bold text-lg">Staff Chat</h2>
				<p class="text-xs text-zinc-500">For curators and above. Messages are deleted after ${currentUser.limits.chat_retention_days} days unless pinned.</p>
			</div>
			<div class="flex items-center gap-2 flex-wrap justify-end flex-shrink-0">
				<select id="chat-alerts" onchange="setChatAlerts(this.value)" class="m-field !w-auto !py-1.5 text-xs" aria-label="How to be told about new messages" title="How to be told about new messages">
					${Object.entries(CHAT_ALERTS)
						.map(
							([value, label]) =>
								`<option value="${value}" ${value === (currentUser.prefs?.staff_chat ?? "badge") ? "selected" : ""}>${label}</option>`
						)
						.join("")}
				</select>
				<button id="chat-pins-toggle" onclick="toggleChatPins()" class="m-btn m-btn-tonal m-btn-sm" aria-expanded="false" aria-controls="chat-pins">
					<span class="material-symbols-outlined">push_pin</span>Pinned <span id="chat-pin-count">0</span>
				</button>
			</div>
		</div>
		<div id="chat-pins" class="hidden flex-shrink-0 max-h-[45%] overflow-y-auto bg-zinc-900 rounded-2xl p-3 mb-2">
			<div id="chat-pins-body" class="flex flex-col gap-2"></div>
		</div>
		<div id="chat-list" class="flex-1 min-h-0 overflow-y-auto pr-1 pb-2">${skeletonRows(4, "h-12")}</div>
		<div class="flex gap-2 items-end pt-3 border-t border-zinc-800">
			<textarea id="chat-input" rows="2" maxlength="1000" placeholder="Write a message" class="m-field flex-1" aria-label="Message"></textarea>
			<div class="relative">
				<button id="chat-emote-toggle" class="m-icon-btn hidden" aria-label="Add a reaction" title="Add a reaction" aria-expanded="false"><span class="material-symbols-outlined">add_reaction</span></button>
				<div id="chat-emotes" class="hidden absolute bottom-full right-0 mb-2 z-10 w-52 flex flex-wrap gap-0.5 bg-zinc-800 border border-zinc-700 rounded-2xl p-1.5 shadow-xl"></div>
			</div>
			<button id="chat-send" onclick="sendChatMessage()" class="m-icon-btn filled" aria-label="Send" title="Send (Enter)"><span class="material-symbols-outlined">send</span></button>
		</div>
		<p class="text-[11px] text-zinc-600 mt-1.5">**bold** &nbsp; *italic* &nbsp; ~~struck~~ &nbsp; \`code\` &nbsp; :thumb_up:</p>
	</div>`;
	el("chat-emote-toggle").addEventListener("click", () => toggleChatEmotes());
	el("chat-emotes").addEventListener("click", (e) => {
		const name = e.target.closest("[data-emote]")?.dataset.emote;
		if (!name) return;
		insertIntoChat(`:${name}:`);
		toggleChatEmotes(false);
	});
	el("chat-input").addEventListener("keydown", (e) => {
		if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
		e.preventDefault();
		sendChatMessage();
	});
	refreshChat(true);
	if (!_chatPolling)
		pollWhile(() => currentTab === "chat" && !!el("chat-list"), refreshChat, CHAT_POLL_MS, "staff_chat");
	_chatPolling = true;
}

function paintChatUnread(count) {
	const btn = document.querySelector('.tab-btn[data-tab="chat"]');
	if (!btn) return;
	btn.querySelector(".chat-count")?.remove();
	if (count > 0)
		btn.insertAdjacentHTML(
			"beforeend",
			`<span class="chat-count ml-auto min-w-[1.25rem] h-5 px-1.5 rounded-full bg-blue-500 text-white text-[11px] font-bold leading-5 text-center" title="${count} new">${count > 99 ? "99+" : count}</span>`
		);
}

/** Only while another tab is open: the chat tab marks everything read by itself. */
async function checkChatUnread() {
	if (document.hidden || live.connected || currentTab === "chat" || !currentUser?.role || !canOpenTab("chat")) return;
	if (currentUser.prefs?.staff_chat === "none") return paintChatUnread(0);
	try {
		const { unread } = await api("/api/admin/chat/unread");
		paintChatUnread(unread);
		announceStaffChat(unread, currentUser);
	} catch {}
}

setInterval(checkChatUnread, CHAT_UNREAD_POLL_MS);
document.addEventListener("attention", (e) => {
	if (currentTab === "chat" || !canOpenTab("chat") || currentUser?.prefs?.staff_chat === "none") return;
	paintChatUnread(e.detail?.staff_chat ?? 0);
});
setTimeout(checkChatUnread, 2000);

/** Called from inline handlers in the markup. */
Object.assign(window, {
	deleteChatMessage,
	filterChatPins,
	jumpToChatMessage,
	pinChatMessage,
	sendChatMessage,
	setChatAlerts,
	toggleChatPins,
});
