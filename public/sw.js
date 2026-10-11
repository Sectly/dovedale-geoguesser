/*
 * Service worker. Its job is notifications: it shows the ones the server pushes
 * and opens the right page when one is clicked. It deliberately caches nothing,
 * so it can never serve a stale copy of the game.
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
