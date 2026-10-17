import { EXTERNAL_ICON, escHtml, isExternalLink, linkHref } from "./lib/dom.js";
import { live, onLive } from "./lib/live.js";

/** How many messages a player may send in a row before staff have to answer. */

export function ticketTime(seconds) {
	const date = new Date(seconds * 1000);
	const today = new Date().toDateString() === date.toDateString();
	return today
		? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
		: date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** One message in a thread. `mine` puts it on the right in the viewer's colour. */
function ticketBubbleHtml({ mine, who, when, bodyHtml }) {
	return `<div class="flex ${mine ? "justify-end" : "justify-start"}">
		<div class="max-w-[85%] rounded-2xl px-3.5 py-2.5 ${mine ? "bg-blue-600/25 rounded-br-md" : "bg-zinc-800 rounded-bl-md"}">
			<div class="text-[11px] text-zinc-400 mb-1 flex gap-2"><span class="font-semibold">${escHtml(who)}</span><span class="text-zinc-500">${ticketTime(when)}</span></div>
			<div class="text-sm text-zinc-200 whitespace-pre-wrap break-words">${bodyHtml}</div>
		</div>
	</div>`;
}

export function linkedTextHtml(text) {
	return String(text ?? "")
		.split(/(https?:\/\/[^\s<>"']+)/)
		.map((part, i) => {
			if (i % 2 === 0) return escHtml(part);
			/** Punctuation that ends the sentence, not the address. A bracket stays when the address opened it. */
			let url = part;
			while (/[.,;:!?\]]$/.test(url) || (url.endsWith(")") && url.split(")").length > url.split("(").length))
				url = url.slice(0, -1);
			const after = part.slice(url.length);
			const here = `${url}/`.startsWith(`${location.origin}/`);
			if (!here && !isExternalLink(url)) return escHtml(part);
			return `<a href="${escHtml(here ? url : linkHref(url))}" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:text-blue-300 underline">${escHtml(url)}${here ? "" : EXTERNAL_ICON}</a>${escHtml(after)}`;
		})
		.join("");
}

/** The whole conversation. `viewer` ("user" or "staff") decides whose messages sit on the right. */
export function ticketThreadHtml(ticket, viewer, openingHtml) {
	const replies = Array.isArray(ticket.replies) ? ticket.replies : [];
	const name = (reply) => {
		if (reply.type === "staff") return viewer === "staff" ? `Staff · @${reply.author_username || "?"}` : "Staff";
		return viewer === "user" ? "You" : `@${reply.author_username || ticket.username || "user"}`;
	};
	return [
		ticketBubbleHtml({
			mine: viewer === "user",
			who: viewer === "user" ? "You" : `@${ticket.username || "user"}`,
			when: ticket.created_at,
			bodyHtml: openingHtml ?? linkedTextHtml(ticket.message),
		}),
		...replies.map((reply) =>
			ticketBubbleHtml({
				mine: (reply.type === "staff") === (viewer === "staff"),
				who: name(reply),
				when: reply.created_at,
				bodyHtml: linkedTextHtml(reply.body),
			})
		),
	].join("");
}

/** Messages the player has sent since staff last spoke (the opening message counts as one). */
export function ticketFollowUps(ticket) {
	const replies = Array.isArray(ticket.replies) ? ticket.replies : [];
	let count = 1;
	for (const reply of replies) count = reply.type === "staff" ? 0 : count + 1;
	return count;
}

/** Runs `load` every few seconds while active and visible, or on `liveEvent` while live. Returns a stop function. */
export function pollWhile(isActive, load, everyMs = 5000, liveEvent = null) {
	const timer = setInterval(() => {
		if (document.hidden || !isActive() || (liveEvent && live.connected)) return;
		load();
	}, everyMs);
	/** A random delay spreads refetches across pages, and events in that window share one fetch. */
	let pending = null;
	const soon = () => {
		if (pending || document.hidden || !isActive()) return;
		pending = setTimeout(
			() => {
				pending = null;
				if (!document.hidden && isActive()) load();
			},
			300 + Math.random() * 1700
		);
	};
	const stopLive = liveEvent ? onLive(liveEvent, soon) : null;
	return () => {
		clearInterval(timer);
		clearTimeout(pending);
		stopLive?.();
	};
}

/** Scrolls a thread to its newest message, but only if the reader was already at the bottom. */
export function keepThreadAtBottom(container, render) {
	const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
	render();
	if (atBottom) container.scrollTop = container.scrollHeight;
}
