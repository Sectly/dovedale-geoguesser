/**
 * Tooltips for the whole site. A control gets its text from, in order:
 *   1. its `title` attribute (taken over, so the browser's tooltip never doubles up)
 *   2. `data-tip`, with an optional `data-tip-key` shortcut
 *   3. the TOOLTIPS list below, matched by CSS selector
 *   4. its `aria-label`, when it shows only an icon
 * Handled by document listeners, so controls drawn later need no setup.
 */

/** What each control says: a string, or [text, shortcut]. Say what it does, not what it is called. */
const TOOLTIPS = {
	/* ---- Site header ---- */
	"#site-nav-toggle": "Menu",

	/* ---- A round, in any mode ---- */
	"#zoom-in": ["Zoom in", "+"],
	"#zoom-out": ["Zoom out", "-"],
	"#guess-btn": ["Lock in your pin", "Space"],
	"#resize-handle": "Drag to resize the screenshot",
	"#timer-display": "Time left this round",
	"#location-id-badge": "This location's ID, handy when reporting a problem",
	"#photo-panel a[href='/']": "Home (leaves this game)",
	"#photo-panel a[href='/specials']": "Back to Specials (leaves this game)",
	"#next-btn": ["Carry on", "Enter"],
	"#result-report-link, #result-rows a[href*='report_location']": "Tell staff something is wrong with this location",

	/* ---- Solo ---- */
	"#start-btn": ["Start the game", "Enter"],
	".time-pill[data-val='0']": "No time limit",
	".difficulty-pill[data-val='0']": "Any location, and the game counts for the leaderboard",
	"#replay-btn": ["See every round on the map", "R"],
	"#replay-back-btn": "Back to your results",

	/* ---- Daily ---- */
	"#result-share-btn, #played-share-btn": "Copy a spoiler-free summary to paste anywhere",

	/* ---- Duels ---- */
	"#quickplay-btn": ["Ranked: play someone near your rating", "Q"],
	"#lobby-rating": "Only Quick Play duels change your rating",
	"#live-duels-btn": ["Watch duels being played right now", "W"],
	"#live-duels-refresh": "Refresh the list",
	"#live-duels-close": "Close",
	"[data-watch]": "Watch this duel live",
	"#create-btn": "Make a private room to share with a friend. Not ranked",
	"#join-btn": "Join the room with this code",
	"label:has(#listed-check)": "Listed rooms appear under Live duels for anyone to watch",
	"#copy-invite-btn": "Copy a link that lets a friend join",
	"#copy-spectate-btn": "Copy a link that lets people watch",
	"#ready-btn": ["Tell the host you're ready", "R"],
	"#start-duel-btn": ["Start the duel", "R"],
	"#spectate-instead-btn": "Give up your seat and watch instead",
	"#leave-btn": "Leave this room",
	"#gate-spectate-btn": "Watch without logging in",
	"#spectator-count": "People watching this duel",
	"#opponent-guessed-badge": "The round ends once you have both guessed",
	"#end-actions #play-again-btn": ["Ask for a rematch", "P"],
	"#end-leave-btn": "Back to the duels lobby",
	"#end-replay-again": "Play the rounds back on the map",
	"#spectate-new-game-btn": "The players started a rematch",

	/* ---- Team duels and other specials ---- */
	"#team-create": "Make a room and share its code",
	"#team-join": "Join the room with this code",
	"#team-start": "Start once both teams have a player",
	"#team-again": "Play again with the same teams",
	"#team-leave": "Leave this room",
	"#copy-invite": "Copy the invite link",
	"#memory-new": "Deal a fresh board",

	/* ---- Leaderboard ---- */
	"#sort-total": "Each player's best single game",
	"#sort-avg, #dsort-avg": "Average points per round",
	"#rounds-0": "Games of any length",
	"#tl--1": "Any time limit",
	"#tl-0": "Games with no time limit",
	"#dsort-rating": "Rating from ranked Quick Play duels",
	"#dsort-wins": "Duels won",
	"#dsort-score": "Points scored across every duel",
	"#dmode-all": "Quick Play and private rooms",
	"#dmode-quickplay": "Quick Play duels only",
	"#dmode-room": "Private rooms only",
	"#daysort-score": "Highest score first",
	"#daysort-distance": "Closest guess first",
	"#daysort-time": "Fastest guess first",
	"#daysort-hints": "Fewest hints first",

	/* ---- Profile ---- */
	"#share-btn": "Copy a link to this profile",

	/* ---- Submitting a location ---- */
	"#clear-file": "Remove this screenshot",
	"#add-hint-btn, #fe-add-hint-btn": "Add a hint players can reveal for a few points",
	"#pin-toggle-btn": "Switch between dragging the map and placing the pin",
	"#fine-increment": "How far each nudge moves the pin",
	"#suggest-back": "Pick a different location",
	"#suggest-cur-img-zoom": "See the current screenshot full size",
};

const Tooltips = (() => {
	/** How long the pointer rests on something before its tooltip shows. Keyboard focus shows it at once. */
	const HOVER_DELAY_MS = 450;
	const GAP = 8;
	const EDGE = 8;

	const rules = [];
	/** What the list says for an element, remembered so the selectors are only tried once each. */
	const listed = new WeakMap();
	let bubble = null;
	let current = null;
	let timer = null;

	function add(selector, tip) {
		const [text, key] = Array.isArray(tip) ? tip : [tip, ""];
		rules.push({ selector, text, key: key || "" });
	}

	function fromList(element) {
		if (listed.has(element)) return listed.get(element);
		let found = null;
		for (const rule of rules) {
			try {
				if (element.matches(rule.selector)) {
					found = rule;
					break;
				}
			} catch {
				/** A selector this browser does not understand (:has on an old one) just never matches. */
			}
		}
		listed.set(element, found);
		return found;
	}

	function iconOnly(element) {
		if (!element.matches("button, a, [role='button']")) return false;
		for (const node of element.childNodes) {
			if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) return false;
			if (node.nodeType !== Node.ELEMENT_NODE) continue;
			const icon = node.matches(".material-symbols-outlined, img, svg, .attention-badge");
			if (!icon && node.textContent.trim()) return false;
		}
		return true;
	}

	function tipFor(element) {
		/** A title is taken over rather than read, or the browser would show its own tooltip as well. */
		const title = element.getAttribute("title");
		if (title) {
			element.dataset.tip = title;
			element.removeAttribute("title");
			if (!element.hasAttribute("aria-label") && iconOnly(element)) element.setAttribute("aria-label", title);
		}
		if (element.dataset.tip) return { text: element.dataset.tip, key: element.dataset.tipKey || "" };
		const rule = fromList(element);
		if (rule) return rule;
		const label = element.getAttribute("aria-label");
		return label && iconOnly(element) ? { text: label, key: "" } : null;
	}

	function findTarget(start) {
		for (let node = start; node && node.nodeType === Node.ELEMENT_NODE && node !== document.body;) {
			const tip = tipFor(node);
			if (tip) return { element: node, tip };
			node = node.parentElement;
		}
		return null;
	}

	function place(target) {
		const box = target.getBoundingClientRect();
		const width = bubble.offsetWidth;
		const height = bubble.offsetHeight;
		const above = box.top - height - GAP;
		const top = above >= EDGE ? above : Math.min(innerHeight - height - EDGE, box.bottom + GAP);
		const left = Math.max(EDGE, Math.min(innerWidth - width - EDGE, box.left + box.width / 2 - width / 2));
		bubble.style.top = `${Math.round(top)}px`;
		bubble.style.left = `${Math.round(left)}px`;
	}

	function show(element, tip) {
		if (!document.contains(element)) return;
		if (!bubble) {
			bubble = document.createElement("div");
			bubble.className = "m-tooltip";
			bubble.id = "m-tooltip";
			bubble.setAttribute("role", "tooltip");
			document.body.appendChild(bubble);
		}
		bubble.textContent = tip.text;
		if (tip.key) {
			const key = document.createElement("kbd");
			key.textContent = tip.key;
			bubble.appendChild(key);
		}
		bubble.classList.remove("shown");
		place(element);
		/** Reading the size makes the browser settle the new position first, so the fade starts from there. */
		void bubble.offsetWidth;
		bubble.classList.add("shown");
	}

	function hide() {
		clearTimeout(timer);
		timer = null;
		current = null;
		bubble?.classList.remove("shown");
	}

	function approach(start, delay) {
		const found = findTarget(start);
		if (!found) return hide();
		if (found.element === current) return;
		hide();
		current = found.element;
		timer = setTimeout(() => show(found.element, found.tip), delay);
	}

	document.addEventListener("pointerover", (e) => {
		/** Touch has no hover; a tooltip there would only appear after the tap that already did the thing. */
		if (e.pointerType === "touch") return;
		approach(e.target, HOVER_DELAY_MS);
	});
	document.addEventListener("pointerout", (e) => {
		if (current && !current.contains(e.relatedTarget)) hide();
	});
	document.addEventListener("focusin", (e) => {
		let keyboard = false;
		try {
			keyboard = e.target.matches(":focus-visible");
		} catch {}
		if (keyboard) approach(e.target, 0);
	});
	document.addEventListener("focusout", hide);
	document.addEventListener("pointerdown", hide);
	document.addEventListener("keydown", (e) => e.key === "Escape" && hide());
	addEventListener("scroll", hide, { capture: true, passive: true });
	addEventListener("resize", hide);

	for (const [selector, tip] of Object.entries(TOOLTIPS)) add(selector, tip);

	return { add, hide };
})();
