import { beforeAll, describe, expect, test } from "bun:test";
import { call, createUser, resetReviewQueues } from "./helpers";

beforeAll(resetReviewQueues);

describe("pages and static files", () => {
	test("every page is served with hashed asset URLs", async () => {
		for (const path of [
			"/",
			"/play",
			"/daily",
			"/duels",
			"/leaderboard",
			"/settings",
			"/submit",
			"/admin",
			"/tos",
			"/privacy",
			"/guidelines",
			"/fairplay",
		]) {
			const res = await call(path);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/html");
			const local = [...String(res.data).matchAll(/(?:src|href)="(\/(?:js|css)\/[^"]+)"/g)].map((m) => m[1]);
			for (const url of local) {
				expect(url).toMatch(/\?v=\w+$/);
				const asset = await call(url);
				expect(asset.status).toBe(200);
				expect(asset.headers.get("cache-control")).toContain("immutable");
			}
		}
	});

	test("unchanged pages answer conditional requests with 304", async () => {
		const first = await call("/play");
		const again = await call("/play", { headers: { "If-None-Match": first.headers.get("etag")! } });
		expect(again.status).toBe(304);
	});

	test("room and profile links get their own share tags", async () => {
		const duel = await call("/duel/abc123?spectate");
		expect(duel.data).toContain("og.png?type=spectate&amp;code=ABC123");
		const user = createUser();
		const profile = await call(`/u/${user.username}`);
		expect(profile.data).toContain(`<title>User`);
		expect(String(profile.data).match(/og:title/g)).toHaveLength(1);
	});

	test("missing pages, missing API routes and path tricks", async () => {
		const page = await call("/definitely-not-here");
		expect(page.status).toBe(404);
		expect(page.data).toContain("Page not found");
		expect((await call("/api/nope")).data).toEqual({ error: "Not found" });
		expect((await call("/..%2f..%2fpackage.json")).status).toBe(404);
		expect((await call("/%2e%2e/package.json")).status).toBe(404);
		expect((await call("/uploads/..%2f..%2fpackage.json")).status).toBe(404);
	});

	test("the sitemap and share images render", async () => {
		expect((await call("/sitemap.xml")).data).toContain("<urlset");
		const og = await call("/og.png?type=daily");
		expect(og.status).toBe(200);
		expect(og.headers.get("content-type")).toBe("image/png");
	});
});

describe("service worker", () => {
	/** Runs public/sw.js with a stand-in for the worker's globals and returns its fetch handler. */
	async function fetchHandler(network: () => Promise<Response>) {
		const code = await Bun.file(new URL("../public/sw.js", import.meta.url)).text();
		const listeners: Record<string, (event: any) => void> = {};
		const self = { addEventListener: (name: string, fn: (event: any) => void) => (listeners[name] = fn) };
		new Function("self", "fetch", code)(self, network);
		return (mode: string): Promise<Response> | null => {
			let answer: Promise<Response> | null = null;
			listeners.fetch({ request: { mode }, respondWith: (res: Promise<Response>) => (answer = res) });
			return answer;
		};
	}

	test("stands in with a waiting page only when the server itself cannot be reached", async () => {
		const down = await fetchHandler(() => Promise.reject(new Error("offline")));
		const waiting = await down("navigate")!;
		expect(waiting.status).toBe(503);
		expect(await waiting.text()).toContain("Back in a moment");
		/** Scripts, images and API calls are never touched. */
		expect(down("cors")).toBeNull();

		const proxyError = await fetchHandler(async () => new Response("Bad gateway", { status: 502 }));
		expect(await (await proxyError("navigate")!).text()).toContain("Back in a moment");

		/** The game's own pages pass straight through, including its maintenance screen. */
		const own = (status: number) =>
			fetchHandler(async () => new Response("from the game", { status, headers: { "X-App": "dovedale" } }));
		expect(await (await (await own(503))("navigate")!).text()).toBe("from the game");
		expect(await (await (await own(200))("navigate")!).text()).toBe("from the game");
	});
});
