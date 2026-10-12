/**
 * Title screen for a session's first visit to the home page. Loaded in the <head> so nothing paints first. "/?intro"
 * replays it.
 */
(function intro() {
	const SEEN_KEY = "intro_seen";
	const SEEN_AT_KEY = "intro_seen_at";
	/** Once played, it rests this long, however many new tabs or sessions come in between. */
	const REST_MS = 24 * 60 * 60 * 1000;
	/** Shown at least this long, and no longer than this however slow the page is. */
	const MIN_MS = 1600;
	const MAX_MS = 4000;
	/** Both match the transitions in shared.css. */
	const MORPH_MS = 600;
	const FADE_MS = 150;

	const root = document.documentElement;
	const forced = new URLSearchParams(location.search).has("intro");
	try {
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const rested = Date.now() - Number(localStorage.getItem(SEEN_AT_KEY)) >= REST_MS;
		if (!forced && (sessionStorage.getItem(SEEN_KEY) || !rested)) return;
		sessionStorage.setItem(SEEN_KEY, "1");
		localStorage.setItem(SEEN_AT_KEY, String(Date.now()));
	} catch {
		/** Without storage it would play on every visit. */
		return;
	}
	/** "intro-play" is never removed: that would replay the home page's card animation. */
	root.classList.add("intro-play", "intro-hold");

	/** Resolves once the title screen is gone, for anything that should wait for it. */
	let finished;
	window.introDone = new Promise((resolve) => (finished = resolve));

	const started = performance.now();
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
	let left = false;

	/** Sets how far a piece must move and scale to land on its counterpart on the page. */
	function aim(piece, target) {
		const from = piece?.getBoundingClientRect();
		const to = target?.getBoundingClientRect();
		if (!from?.width || !to?.width) return;
		piece.style.setProperty("--dx", `${to.left + to.width / 2 - (from.left + from.width / 2)}px`);
		piece.style.setProperty("--dy", `${to.top + to.height / 2 - (from.top + from.height / 2)}px`);
		piece.style.setProperty("--s", String(to.width / from.width));
	}

	async function leave() {
		if (left) return;
		left = true;
		removeEventListener("pointerdown", leave, true);
		removeEventListener("keydown", skipWithKey, true);

		const splash = document.getElementById("intro-splash");
		/** Whatever goes wrong here, the page must not stay hidden behind the title screen. */
		try {
			aim(
				splash?.querySelector(".intro-mark"),
				document.querySelector('#site-nav > a[href="/"] > .material-symbols-outlined')
			);
			aim(splash?.querySelector(".intro-title"), document.getElementById("home-title"));
		} catch {}
		root.classList.replace("intro-hold", "intro-morph");
		await wait(MORPH_MS);
		root.classList.remove("intro-morph");
		await wait(FADE_MS);
		splash?.remove();
		finished();
	}

	/** Any key skips it, without also triggering a page shortcut. */
	function skipWithKey(e) {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		e.stopPropagation();
		leave();
	}
	addEventListener("pointerdown", leave, true);
	addEventListener("keydown", skipWithKey, true);

	document.addEventListener("DOMContentLoaded", () => {
		const splash = document.getElementById("intro-splash");
		if (!splash) return leave();
		/** Two frames, so the bar paints empty before it starts to fill. */
		requestAnimationFrame(() => requestAnimationFrame(() => (splash.dataset.state ||= "loading")));

		const loaded = Promise.all([document.fonts?.ready, typeof fetchUser === "function" ? fetchUser() : null]).catch(
			() => {}
		);
		const elapsed = performance.now() - started;
		Promise.race([Promise.all([loaded, wait(MIN_MS - elapsed)]), wait(MAX_MS - elapsed)]).then(async () => {
			splash.dataset.state = "ready";
			await wait(300);
			leave();
		});
	});
})();
