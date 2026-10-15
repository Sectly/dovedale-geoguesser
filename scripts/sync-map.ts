export {};

const UPSTREAM = "https://raw.githubusercontent.com/dovedalerailway/dovedale-map/main/public/index.js";
const OUT = "./public/js/map-config.js";

const src = await fetch(UPSTREAM).then((r) => {
	if (!r.ok) throw new Error(`Fetch failed: ${r.status} ${r.statusText}`);
	return r.text();
});

function need(label: string, pattern: RegExp): string {
	const m = src.match(pattern);
	if (!m) throw new Error(`Could not extract ${label} from upstream source`);
	return m[1];
}

const rows = need("MAP_CONFIG.rows", /\brows:\s*(\d+)/);
const columns = need("MAP_CONFIG.columns", /\bcolumns:\s*(\d+)/);
const totalWidth = need("MAP_CONFIG.totalWidth", /\btotalWidth:\s*(\d+)/);
const totalHeight = need("MAP_CONFIG.totalHeight", /\btotalHeight:\s*(\d+)/);

const tlX = need("WORLD_BOUNDS.TOP_LEFT.x", /TOP_LEFT:\s*\{\s*x:\s*(-?\d+)/);
const tlY = need("WORLD_BOUNDS.TOP_LEFT.y", /TOP_LEFT:\s*\{[^}]*?y:\s*(-?\d+)/);
const brX = need("WORLD_BOUNDS.BOTTOM_RIGHT.x", /BOTTOM_RIGHT:\s*\{\s*x:\s*(-?\d+)/);
const brY = need("WORLD_BOUNDS.BOTTOM_RIGHT.y", /BOTTOM_RIGHT:\s*\{[^}]*?y:\s*(-?\d+)/);

const tileVersion = src.match(/\.png\?v=(\w+)/)?.[1] ?? "1";

const output = `export const MAP_CONFIG = { rows: ${rows}, columns: ${columns}, totalWidth: ${totalWidth}, totalHeight: ${totalHeight} };
export const WORLD_BOUNDS = { TOP_LEFT: { x: ${tlX}, y: ${tlY} }, BOTTOM_RIGHT: { x: ${brX}, y: ${brY} } };
export const WORLD_WIDTH = WORLD_BOUNDS.BOTTOM_RIGHT.x - WORLD_BOUNDS.TOP_LEFT.x;
export const WORLD_HEIGHT = WORLD_BOUNDS.BOTTOM_RIGHT.y - WORLD_BOUNDS.TOP_LEFT.y;

/** Set by the server; changes when the tiles do. */
const TILE_VERSION = document.querySelector('meta[name="tile-version"]')?.content || "0";

/** \`square\` picks one square of a sharper size; without it, the whole column. Full-size PNG is the original. */
export function tileUrl(row, col, quality, format = "webp", square) {
	const name = \`row-\${row + 1}-column-\${col + 1}\`;
	if (square !== undefined) return \`/images/generated/\${name}-\${quality}-\${square}.\${format}?v=\${TILE_VERSION}\`;
	if (quality === "high" && format === "png") return \`/images/\${name}.png?v=${tileVersion}\`;
	return \`/images/generated/\${name}-\${quality}.\${format}?v=\${TILE_VERSION}\`;
}
`;

await Bun.write(OUT, output);

console.log("Updated " + OUT);
console.log("  MAP_CONFIG : " + rows + "x" + columns + " tiles, " + totalWidth + "x" + totalHeight + "px");
console.log("  WORLD_BOUNDS: (" + tlX + "," + tlY + ") to (" + brX + "," + brY + ")");
console.log("  tile version: v=" + tileVersion);
