/*
 * Service worker. It shows the notifications the server pushes and opens the right
 * page when one is clicked, and it stands in with a waiting page when the server
 * cannot be reached (a restart, usually). It deliberately caches nothing, so it can
 * never serve a stale copy of the game.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	let message = {};
	try {
		message = event.data ? event.data.json() : {};
	} catch {}
	event.waitUntil(
		self.registration.showNotification(message.title || "Dovedale GeoGuesser", {
			body: message.body || "",
			icon: "/icons/icon-192.png",
			badge: "/icons/icon-192.png",
			data: { link: message.link || "/settings#notifications" },
		})
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const link = event.notification.data?.link || "/";
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
			// Reuse a tab that is already open rather than piling up new ones.
			const open = windows.find((w) => "focus" in w);
			if (open) {
				open.navigate(link);
				return open.focus();
			}
			return self.clients.openWindow(link);
		})
	);
});

/*
 * Opening or reloading a page while the server is down would otherwise show the browser's
 * own error page, or a bare one from the proxy in front of the server. This page waits
 * instead and reloads by itself the moment the server answers.
 */
const WAITING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Back in a moment | Dovedale GeoGuesser</title>
<style>
	html, body { height: 100%; margin: 0; }
	body { background: #09090b; color: #e4e4e7; font-family: Inter, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; text-align: center; padding: 0 1.5rem; }
	.spinner { width: 2.75rem; height: 2.75rem; margin: 0 auto 1.25rem; border-radius: 50%; border: 3px solid #27272a; border-top-color: #60a5fa; animation: spin 0.9s linear infinite; }
	h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
	p { color: #a1a1aa; font-size: 0.875rem; margin: 0 auto; max-width: 24rem; line-height: 1.5; }
	button { margin-top: 1.5rem; background: #27272a; color: #e4e4e7; border: 0; border-radius: 9999px; padding: 0.6rem 1.4rem; font: inherit; font-size: 0.875rem; font-weight: 600; cursor: pointer; }
	button:hover { background: #3f3f46; }
	@keyframes spin { to { transform: rotate(360deg); } }
	@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }
</style>
</head>
<body>
<main role="status">
	<div class="spinner" aria-hidden="true"></div>
	<h1>Back in a moment</h1>
	<p>The server can't be reached right now. It is most likely restarting for an update, which takes a few seconds. This page will reload by itself as soon as it is back.</p>
	<button onclick="location.reload()">Try now</button>
</main>
<script>
	// The game marks its own answers; a proxy's error page does not, so that is not "back".
	setInterval(async () => {
		try {
			const res = await fetch("/api/status", { cache: "no-store" });
			if (res.ok && res.headers.get("X-App")) location.reload();
		} catch {}
	}, 2000);
</script>
</body>
</html>`;

const waitingPage = () =>
	new Response(WAITING_PAGE, {
		status: 503,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "5" },
	});

self.addEventListener("fetch", (event) => {
	// Pages only. Scripts, images and API calls go straight to the network as before.
	if (event.request.mode !== "navigate") return;
	event.respondWith(
		fetch(event.request).then(
			// A gateway error with no sign of the game behind it is the proxy saying the server is down.
			(res) => ([502, 503, 504].includes(res.status) && !res.headers.get("X-App") ? waitingPage() : res),
			() => waitingPage()
		)
	);
});
