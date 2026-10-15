/** Calls the API and returns the parsed body. Throws an Error with a showable message and a `status` (0 when unreachable). */
export async function api(path, { method, json, body } = {}) {
	let res;
	try {
		res = await fetch(path, {
			method: method || (json !== undefined || body ? "POST" : "GET"),
			headers: json !== undefined ? { "Content-Type": "application/json" } : undefined,
			body: json !== undefined ? JSON.stringify(json) : body,
		});
	} catch {
		throw Object.assign(new Error("Can't reach the server. Check your connection and try again."), { status: 0 });
	}
	const raw = await res.text();
	if (!res.ok) {
		const message = raw && raw.length < 300 && !raw.startsWith("<") && !raw.startsWith("{") ? raw : "";
		throw Object.assign(new Error(message || `Something went wrong (${res.status}).`), { status: res.status });
	}
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

let _userPromise = null;

/** The logged-in user, or null. Fetched once per page and shared by everything that asks. */
export function fetchUser() {
	_userPromise ??= loadUser();
	return _userPromise;
}
/** For the title screen (intro.js), a classic script that waits for the user before it lifts. */
window.userLoaded = fetchUser();

async function loadUser() {
	for (let attempt = 0; ; attempt++) {
		try {
			return await api("/api/auth/me");
		} catch (err) {
			const worthRetrying = !err.status || err.status >= 500 || err.status === 429;
			if (!worthRetrying || attempt >= 3) return null;
			await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
		}
	}
}

export function loginUrl(redirect = location.pathname + location.search) {
	return `/api/auth/login?redirect=${encodeURIComponent(redirect)}`;
}
