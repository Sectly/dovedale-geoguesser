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

	test("every module a page imports is in its import map and served hashed", async () => {
		for (const path of ["/", "/play", "/daily", "/duels", "/settings", "/submit", "/admin", "/tos", "/news"]) {
			const html = String((await call(path)).data);
			const map = html.match(/<script type="importmap">(.*?)<\/script>/)?.[1];
			expect(map).toBeTruthy();
			const imports: Record<string, string> = JSON.parse(map!).imports;
			const entry = html.match(/<script type="module" src="([^"?]+)\?v=\w+"/)![1];
			expect(html).toContain(`src="${imports[entry]}"`);

			const seen = new Set<string>();
			const visit = async (module: string) => {
				if (seen.has(module)) return;
				seen.add(module);
				expect(imports[module]).toMatch(/\?v=\w+$/);
				const res = await call(imports[module]);
				expect(res.status).toBe(200);
				expect(res.headers.get("cache-control")).toContain("immutable");
				for (const [, spec] of String(res.data).matchAll(/^import (?:[^"]+ from )?"(\.[^"]+)";$/gm))
					await visit(new URL(spec, `http://x${module}`).pathname);
			};
			await visit(entry);
			expect(seen.has("/js/lib/site.js")).toBe(true);
			for (const module of seen)
				if (module !== entry) expect(html).toContain(`rel="modulepreload" href="${imports[module]}"`);
		}
	});

	test("the icon font is asked for only the icons the pages use", async () => {
		const html = String((await call("/play")).data);
		const icons = html.match(/icon_names=([a-z0-9_,]+)/)?.[1].split(",") ?? [];
		for (const used of ["explore", "swords", "progress_activity", "waving_hand"]) expect(icons).toContain(used);
		expect(icons).toEqual([...icons].sort());
		expect(icons.length).toBeLessThan(400);
	});

	test("map tiles are addressed by version and kept for 30 days", async () => {
		const html = String((await call("/play")).data);
		expect(html).toMatch(/<meta name="tile-version" content="\w+" \/>/);
		const tile = await call("/images/row-1-column-1.png?v=1");
		expect(tile.headers.get("cache-control")).toBe("public, max-age=2592000, immutable");
		expect((await call("/images/row-1-column-1.png")).headers.get("cache-control")).toContain("max-age=3600");
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
		expect(down("cors")).toBeNull();

		const proxyError = await fetchHandler(async () => new Response("Bad gateway", { status: 502 }));
		expect(await (await proxyError("navigate")!).text()).toContain("Back in a moment");

		const own = (status: number) =>
			fetchHandler(async () => new Response("from the game", { status, headers: { "X-App": "dovedale" } }));
		expect(await (await (await own(503))("navigate")!).text()).toBe("from the game");
		expect(await (await (await own(200))("navigate")!).text()).toBe("from the game");
	});
});
