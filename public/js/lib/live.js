import { whenIdle } from "./dom.js";

/** Wait after load before opening the stream, plus up to LIVE_JITTER_MS. */
const LIVE_DELAY_MS = 1500;
const LIVE_JITTER_MS = 2500;
/** A hidden tab closes its stream after this long and reopens it when shown again. */
const LIVE_HIDDEN_MS = 60_000;
/** Handlers rerun after a reconnect, in case an event was missed. */
const LIVE_CATCH_UP = ["ticket", "staff_chat", "tournament", "chat"];

export const live = {
	connected: false,
	source: null,
	opened: false,
	/** Set on load, even if the page was hidden then. */
	wanted: false,
	retries: 0,
	retryTimer: null,
	hiddenTimer: null,
	handlers: new Map(),
};

/** Returns a function that removes the handler. */
export function onLive(event, fn) {
	if (!live.handlers.has(event)) {
		live.handlers.set(event, new Set());
		live.source?.addEventListener(event, (e) => deliverLive(event, e.data));
	}
	live.handlers.get(event).add(fn);
	return () => live.handlers.get(event)?.delete(fn);
}

function deliverLive(event, raw) {
	let data = null;
	try {
		data = JSON.parse(raw);
	} catch {
		return;
	}
	for (const fn of live.handlers.get(event) || []) {
		try {
			fn(data);
		} catch (err) {
			console.error(`[live] ${event} handler failed:`, err);
		}
	}
}

function openLive() {
	if (live.source || !("EventSource" in window) || document.hidden) return;
	clearTimeout(live.retryTimer);
	/** A tournament page is counted as watching, and allowed more pages per address. */
	const watch = location.pathname.match(/^\/tournament\/(\d+)/)?.[1];
	const source = new EventSource(watch ? `/api/events?watch=${watch}` : "/api/events");
	live.source = source;
	for (const event of live.handlers.keys()) source.addEventListener(event, (e) => deliverLive(event, e.data));
	source.addEventListener("open", () => {
		const reconnected = live.opened;
		live.connected = live.opened = true;
		live.retries = 0;
		if (reconnected) for (const event of LIVE_CATCH_UP) for (const fn of live.handlers.get(event) || []) fn(null);
	});
	source.addEventListener("error", () => {
		live.connected = false;
		/** Closed by an error status, such as maintenance: retry with a growing wait. */
		if (source.readyState !== EventSource.CLOSED) return;
		closeLive();
		const wait = Math.min(120_000, 5000 * 2 ** live.retries++);
		live.retryTimer = setTimeout(openLive, wait + Math.random() * 2000);
	});
}

function closeLive() {
	live.source?.close();
	live.source = null;
	live.connected = false;
}

export function whenNotLive(fn) {
	setTimeout(() => live.connected || fn(), LIVE_DELAY_MS + LIVE_JITTER_MS + 2500);
}

/** Opened after load and idle plus a random delay, to spread out page loads. */
window.addEventListener("load", () =>
	whenIdle(() =>
		setTimeout(
			() => {
				live.wanted = true;
				openLive();
			},
			LIVE_DELAY_MS + Math.random() * LIVE_JITTER_MS
		)
	)
);
document.addEventListener("visibilitychange", () => {
	clearTimeout(live.hiddenTimer);
	if (document.hidden) live.hiddenTimer = setTimeout(closeLive, LIVE_HIDDEN_MS);
	/** Also a page that loaded while hidden. */
	else if (!live.source && live.wanted) setTimeout(openLive, 300 + Math.random() * 1200);
});
