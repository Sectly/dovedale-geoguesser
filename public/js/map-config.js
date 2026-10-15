export const MAP_CONFIG = { rows: 1, columns: 16, totalWidth: 19366, totalHeight: 12061 };
export const WORLD_BOUNDS = { TOP_LEFT: { x: -23818, y: -10426 }, BOTTOM_RIGHT: { x: 14911, y: 13693 } };
export const WORLD_WIDTH = WORLD_BOUNDS.BOTTOM_RIGHT.x - WORLD_BOUNDS.TOP_LEFT.x;
export const WORLD_HEIGHT = WORLD_BOUNDS.BOTTOM_RIGHT.y - WORLD_BOUNDS.TOP_LEFT.y;

/** Full size is the original PNG unless AVIF is asked for; the smaller sizes come as WebP or AVIF. */
export function tileUrl(row, col, quality, format = "webp") {
	const name = `row-${row + 1}-column-${col + 1}`;
	if (quality === "high" && format !== "avif") return `/images/${name}.png?v=1`;
	return `/images/generated/${name}-${quality}.${format}`;
}
