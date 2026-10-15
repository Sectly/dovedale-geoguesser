import { api } from "./api.js";

export const PUSH_ON_KEY = "push_on";

export function registerServiceWorker() {
	if (!("serviceWorker" in navigator)) return Promise.resolve(null);
	return navigator.serviceWorker.register("/sw.js").catch(() => null);
}

function pushKeyBytes(base64) {
	const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
}

/** Subscribes this browser to push. Returns false when the server or browser does not support it. */
export async function enablePush() {
	try {
		const registration = await registerServiceWorker();
		const { push_key } = await api("/api/meta");
		if (!registration?.pushManager || !push_key) return false;
		const subscription =
			(await registration.pushManager.getSubscription()) ||
			(await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: pushKeyBytes(push_key),
			}));
		await api("/api/push/subscribe", { json: subscription.toJSON() });
		localStorage.setItem(PUSH_ON_KEY, "1");
		return true;
	} catch {
		return false;
	}
}

export async function disablePush() {
	try {
		localStorage.removeItem(PUSH_ON_KEY);
		const registration = await navigator.serviceWorker?.getRegistration();
		const subscription = await registration?.pushManager?.getSubscription();
		if (!subscription) return;
		await api("/api/push/subscribe", { method: "DELETE", json: { endpoint: subscription.endpoint } });
		await subscription.unsubscribe();
	} catch {}
}
