import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./config";

/** The Material Symbols subset, copied from Google once so visitors never contact Google Fonts. */

export const ICON_FONT_DIR = join(DATA_DIR, "icon-font");

/** The address every page links to; the server swaps it for the local copy. */
export const GOOGLE_ICON_CSS =
	"https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0..1,0&display=block";

/** Google only sends WOFF2 to browsers it recognises. */
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const RETRY_MS = 10 * 60 * 1000;

let pending: Promise<void> | null = null;
let failedAt = 0;

function iconFontKey(icons: string): string {
	return Bun.hash(icons).toString(36);
}

async function download(icons: string, key: string, onReady: () => void) {
	const res = await fetch(icons ? `${GOOGLE_ICON_CSS}&icon_names=${icons}` : GOOGLE_ICON_CSS, {
		headers: { "User-Agent": BROWSER_UA },
	});
	if (!res.ok) throw new Error(`stylesheet ${res.status}`);
	const css = await res.text();
	const fontUrl = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/)?.[1];
	if (!fontUrl) throw new Error("no font in the stylesheet");
	const font = await fetch(fontUrl, { headers: { "User-Agent": BROWSER_UA } });
	if (!font.ok) throw new Error(`font ${font.status}`);

	mkdirSync(ICON_FONT_DIR, { recursive: true });
	writeFileSync(join(ICON_FONT_DIR, `icons-${key}.woff2`), new Uint8Array(await font.arrayBuffer()));
	/** The stylesheet is written last, since its presence is what marks the copy as complete. */
	writeFileSync(join(ICON_FONT_DIR, `icons-${key}.css`), css.replace(fontUrl, `/fonts/icons-${key}.woff2`));
	for (const name of readdirSync(ICON_FONT_DIR))
		if (!name.startsWith(`icons-${key}.`)) unlinkSync(join(ICON_FONT_DIR, name));
	onReady();
}

/** The copy of the previous icon set, used while a copy of the new one is fetched. */
function latestCopy(): string | null {
	if (!existsSync(ICON_FONT_DIR)) return null;
	const name = readdirSync(ICON_FONT_DIR).find((n) => n.endsWith(".css"));
	return name ? `/fonts/${name}` : null;
}

/** The local stylesheet for this icon set, fetched when missing; until then the previous copy, or null. */
export function iconStylesheet(icons: string, onReady: () => void): string | null {
	const key = iconFontKey(icons);
	if (existsSync(join(ICON_FONT_DIR, `icons-${key}.css`))) return `/fonts/icons-${key}.css`;
	/** Tests never reach the network. */
	if (process.env.NODE_ENV !== "test" && !pending && Date.now() - failedAt >= RETRY_MS)
		pending = download(icons, key, onReady)
			.catch((err) => {
				failedAt = Date.now();
				console.error("[server] Could not copy the icon font:", err.message);
			})
			.finally(() => (pending = null));
	return latestCopy();
}
