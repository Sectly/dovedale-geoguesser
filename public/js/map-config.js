export const MAP_CONFIG = { rows: 1, columns: 16, totalWidth: 19366, totalHeight: 12061 };
export const WORLD_BOUNDS = { TOP_LEFT: { x: -23818, y: -10426 }, BOTTOM_RIGHT: { x: 14911, y: 13693 } };
export const WORLD_WIDTH = WORLD_BOUNDS.BOTTOM_RIGHT.x - WORLD_BOUNDS.TOP_LEFT.x;
export const WORLD_HEIGHT = WORLD_BOUNDS.BOTTOM_RIGHT.y - WORLD_BOUNDS.TOP_LEFT.y;

/** Set by the server; changes when the tiles do. */
const TILE_VERSION = document.querySelector('meta[name="tile-version"]')?.content || "0";

/** `square` picks one square of a sharper size; without it, the whole column. Full-size PNG is the original. */
export function tileUrl(row, col, quality, format = "webp", square) {
	const name = `row-${row + 1}-column-${col + 1}`;
	if (square !== undefined) return `/images/generated/${name}-${quality}-${square}.${format}?v=${TILE_VERSION}`;
	if (quality === "high" && format === "png") return `/images/${name}.png?v=1`;
	return `/images/generated/${name}-${quality}.${format}?v=${TILE_VERSION}`;
}
