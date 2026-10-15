/** Builds the WebP and AVIF map tiles from public/images (`bun run tiles`). `--force` rebuilds them all. */
import { generateTileVariants } from "../src/tile-images";

const force = process.argv.includes("--force");
console.log(force ? "Rebuilding every map tile..." : "Building missing or changed map tiles...");
const made = await generateTileVariants({ force, log: true });
if (!made) console.log("All map tiles are up to date.");
