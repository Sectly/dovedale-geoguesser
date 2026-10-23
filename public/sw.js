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
			const open = windows.find((w) => "focus" in w);
			if (open) {
				open.navigate(link);
				return open.focus();
			}
			return self.clients.openWindow(link);
		})
	);
});

/** Shown instead of the browser's error page while the server is down. Reloads itself when it answers. */
const WAITING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Back in a moment | Dovedale GeoGuesser</title>
<style>
	html, body { height: 100%; margin: 0; }
	body { background: #09090b; color: #e4e4e7; font-family: Inter, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; text-align: center; padding: 0 1.5rem; }
	body { transition: opacity 0.3s ease-in; }
	body.leaving { opacity: 0; }
	svg { display: block; width: 6rem; height: 6rem; margin: 0 auto 1.25rem; }
	rect { fill: #27272a; stroke: #3f3f46; stroke-width: 2; }
	path { fill: none; stroke: #52525b; stroke-width: 3; stroke-linecap: round; }
	circle { fill: #3f3f46; animation: led 1.2s linear infinite; }
	circle:nth-of-type(2) { animation-delay: 0.2s; }
	circle:nth-of-type(3) { animation-delay: 0.4s; }
	.back circle { fill: #4caf50; animation: none; }
	h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
	p { color: #a1a1aa; font-size: 0.875rem; margin: 0 auto; max-width: 24rem; line-height: 1.5; }
	button { margin-top: 1.5rem; background: #27272a; color: #e4e4e7; border: 0; border-radius: 9999px; padding: 0.6rem 1.4rem; font: inherit; font-size: 0.875rem; font-weight: 600; cursor: pointer; }
	button:hover { background: #3f3f46; }
	@keyframes led { 0%, 45%, 100% { fill: #3f3f46; } 15%, 30% { fill: #fcd34d; } }
	@media (prefers-reduced-motion: reduce) { circle { animation: none; } body { transition: none; } }
</style>
</head>
<body>
<main role="status">
	<svg viewBox="0 0 96 96" aria-hidden="true">
		<rect x="16" y="14" width="64" height="20" rx="5" /><circle cx="27" cy="24" r="3" /><path d="M44 24h26" />
		<rect x="16" y="38" width="64" height="20" rx="5" /><circle cx="27" cy="48" r="3" /><path d="M44 48h26" />
		<rect x="16" y="62" width="64" height="20" rx="5" /><circle cx="27" cy="72" r="3" /><path d="M44 72h26" />
	</svg>
	<h1>Back in a moment</h1>
	<p>The server can't be reached right now. This page reloads by itself when it's back.</p>
	<button onclick="location.reload()">Try now</button>
</main>
<script>
	/** The game marks its own answers; a proxy's error page does not, so that is not "back". */
	setInterval(async () => {
		try {
			const res = await fetch("/api/status", { cache: "no-store" });
			if (!res.ok || !res.headers.get("X-App")) return;
			/** Turns green, fades out, and has the next page fade in from the same screen (js/lib/restart.js). */
			document.querySelector("main").className = "back";
			document.body.className = "leaving";
			try { sessionStorage.setItem("restart_reloaded", "1"); } catch {}
			setTimeout(() => location.reload(), 350);
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
	if (event.request.mode !== "navigate") return;
	event.respondWith(
		fetch(event.request).then(
			(res) => ([502, 503, 504].includes(res.status) && !res.headers.get("X-App") ? waitingPage() : res),
			() => waitingPage()
		)
	);
});
