import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { DEV_MODE, PUBLIC_DIR, ROOT_DIR } from "./config";

/** Every Material Symbols name (Google's codepoints list), to tell icon names from other words. */
const NAMES_FILE = join(ROOT_DIR, "src", "icon-names.txt");
const SKIP_DIRS = new Set(["uploads", "images", "icons"]);

let cached: string | null = null;

/** Icons the site uses, so Google Fonts sends only those. */
export function usedIcons(): string {
	if (cached !== null && !DEV_MODE) return cached;
	try {
		const names = new Set(readFileSync(NAMES_FILE, "utf8").split(/\r?\n/).filter(Boolean));
		const found = new Set<string>();
		const scan = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				const path = join(dir, entry);
				if (statSync(path).isDirectory()) {
					if (!SKIP_DIRS.has(entry)) scan(path);
					continue;
				}
				if (!/\.(js|ts|html)$/.test(entry)) continue;
				const source = readFileSync(path, "utf8");
				for (const m of source.matchAll(/material-symbols-outlined[^>]*>\s*([a-z0-9_]+)\s*</g)) found.add(m[1]);
				for (const m of source.matchAll(/["'`]([a-z0-9_]+)["'`]/g)) found.add(m[1]);
			}
		};
		scan(PUBLIC_DIR);
		scan(join(ROOT_DIR, "src"));
		cached = [...found]
			.filter((name) => names.has(name))
			.sort()
			.join(",");
	} catch {
		cached = "";
	}
	return cached;
}
