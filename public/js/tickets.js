/** Ticket threads, drawn the same way for players (settings) and staff (staff panel). */

/** How many messages a player may send in a row before staff have to answer. */
const TICKET_MAX_FOLLOW_UPS = 3;

function ticketTime(seconds) {
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

/**
 * The whole conversation. `viewer` ("user" or "staff") decides whose messages sit on the right.
 * `openingHtml` replaces the opening message's layout.
 */
function ticketThreadHtml(ticket, viewer, openingHtml) {
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
			bodyHtml: openingHtml ?? escHtml(ticket.message || ""),
		}),
		...replies.map((reply) =>
			ticketBubbleHtml({
				mine: (reply.type === "staff") === (viewer === "staff"),
				who: name(reply),
				when: reply.created_at,
				bodyHtml: escHtml(reply.body),
			})
		),
	].join("");
}

/** Messages the player has sent since staff last spoke (the opening message counts as one). */
function ticketFollowUps(ticket) {
	const replies = Array.isArray(ticket.replies) ? ticket.replies : [];
	let count = 1;
	for (const reply of replies) count = reply.type === "staff" ? 0 : count + 1;
	return count;
}

/**
 * Calls `load` every few seconds while `isActive()` is true and the tab is visible. Returns a function that stops it.
 */
function pollWhile(isActive, load, everyMs = 5000) {
	const timer = setInterval(() => {
		if (!document.hidden && isActive()) load();
	}, everyMs);
	return () => clearInterval(timer);
}

/** Scrolls a thread to its newest message, but only if the reader was already at the bottom. */
function keepThreadAtBottom(container, render) {
	const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
	render();
	if (atBottom) container.scrollTop = container.scrollHeight;
}
