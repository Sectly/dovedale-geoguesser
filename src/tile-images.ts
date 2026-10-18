import sharp, { type Sharp } from "sharp";
import { readFileSync } from "fs";
import { mkdir, unlink } from "fs/promises";
import { join } from "path";
import { PUBLIC_DIR } from "./config";

const IMAGES_DIR = join(PUBLIC_DIR, "images");
const GENERATED_DIR = join(IMAGES_DIR, "generated");
const MANIFEST_PATH = `${GENERATED_DIR}/manifest.json`;

type Variant = { name: string; widthPercent: number; webpQuality: number; avifQuality: number };

/** The whole-column map every device loads first. Keep in step with MAP_QUALITY_SCALE in public/js/map-canvas.js. */
const BASE: Variant = { name: "tiny", widthPercent: 25, webpQuality: 70, avifQuality: 35 };

/** The sharper sizes, cut into squares so only what is on screen loads. */
const SQUARE_VARIANTS: Variant[] = [
	{ name: "low", widthPercent: 45, webpQuality: 70, avifQuality: 35 },
	{ name: "medium", widthPercent: 75, webpQuality: 90, avifQuality: 55 },
	{ name: "high", widthPercent: 100, webpQuality: 90, avifQuality: 65 },
];

/** Original rows per square, so placement depends only on the original size, as pins do. Keep in step with map-canvas.js. */
const SQUARE_ROWS = 1024;
const FORMATS = ["webp", "avif", "png"] as const;
const CONFIG_HASH = Bun.hash(JSON.stringify({ BASE, SQUARE_VARIANTS, SQUARE_ROWS })).toString(16);

const MAP_ROWS = 1;
const MAP_COLUMNS = 16;

/** One image at a time, on one thread, with a rest between batches, so building never crowds out the site. */
const ENCODE_THREADS = 1;
const PAUSE_MS = 300;
/** Above 2, AVIF takes about 60% more memory and four times as long for files only about 15% smaller. */
const AVIF_EFFORT = 2;

let version: string | null = null;

/** Changes with any tile; tile addresses carry it, so tiles can be cached for 30 days. */
export function tileVersion(): string {
	if (version !== null) return version;
	try {
		version = Bun.hash(readFileSync(MANIFEST_PATH, "utf8")).toString(36);
	} catch {
		version = "0";
	}
	return version;
}

async function readManifest(): Promise<Record<string, string>> {
	const file = Bun.file(MANIFEST_PATH);
	if (!(await file.exists())) return {};
	try {
		return await file.json();
	} catch {
		return {};
	}
}

const squareCount = (height: number) => Math.ceil(height / SQUARE_ROWS);

function expectedFiles(tileKey: string, height: number): string[] {
	const files = FORMATS.map((f) => `${tileKey}-${BASE.name}.${f}`);
	for (const variant of SQUARE_VARIANTS)
		for (let k = 0; k < squareCount(height); k++)
			for (const f of FORMATS) files.push(`${tileKey}-${variant.name}-${k}.${f}`);
	return files;
}

async function encode(image: Sharp, variant: Variant, format: (typeof FORMATS)[number], out: string) {
	if (format === "webp") await image.webp({ quality: variant.webpQuality }).toFile(`${out}.webp`);
	else if (format === "avif")
		await image.avif({ quality: variant.avifQuality, effort: AVIF_EFFORT }).toFile(`${out}.avif`);
	else await image.png({ compressionLevel: 9 }).toFile(`${out}.png`);
}

/** Writes the base column and every square of one tile. Returns false when it was already up to date. */
async function generateTile(tileKey: string, manifest: Record<string, string>, force: boolean): Promise<boolean> {
	const sourceFile = Bun.file(join(IMAGES_DIR, `${tileKey}.png`));
	if (!(await sourceFile.exists())) return false;
	const sourceBytes = await sourceFile.arrayBuffer();
	const hash = `${Bun.hash(sourceBytes).toString(16)}-${CONFIG_HASH}`;
	const { width = 0, height = 0 } = await sharp(sourceBytes).metadata();
	const files = expectedFiles(tileKey, height);
	const allThere = async () =>
		(await Promise.all(files.map((f) => Bun.file(join(GENERATED_DIR, f)).exists()))).every(Boolean);
	if (!force && manifest[tileKey] === hash && (await allThere())) return false;

	/** Decoded once (about 60 MB); every square is cut from these pixels. */
	const { data, info } = await sharp(sourceBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const pixels = () => sharp(data, { raw: info });

	for (const format of FORMATS)
		await encode(
			pixels().resize({ width: Math.round((width * BASE.widthPercent) / 100) }),
			BASE,
			format,
			join(GENERATED_DIR, `${tileKey}-${BASE.name}`)
		);
	await Bun.sleep(PAUSE_MS);

	for (const variant of SQUARE_VARIANTS) {
		const scale = variant.widthPercent / 100;
		for (let k = 0; k < squareCount(height); k++) {
			const top = k * SQUARE_ROWS;
			const rows = Math.min(SQUARE_ROWS, height - top);
			/** One extra original row, overlapping the next square, so seams are real pixels rather than a gap. */
			const take = rows + (top + rows < height ? 1 : 0);
			for (const format of FORMATS) {
				let square = pixels().extract({ left: 0, top, width, height: take });
				if (scale !== 1)
					square = square.resize({
						width: Math.round(width * scale),
						height: Math.max(1, Math.round(take * scale)),
						fit: "fill",
					});
				await encode(square, variant, format, join(GENERATED_DIR, `${tileKey}-${variant.name}-${k}`));
			}
		}
		await Bun.sleep(PAUSE_MS);
	}
	for (const variant of SQUARE_VARIANTS)
		for (const f of FORMATS) await unlink(join(GENERATED_DIR, `${tileKey}-${variant.name}.${f}`)).catch(() => {});

	manifest[tileKey] = hash;
	return true;
}

/** Makes the map tiles that are missing or out of date. `force` redoes them all. */
export async function generateTileVariants({ force = false, log = false } = {}) {
	const start = Date.now();
	await mkdir(GENERATED_DIR, { recursive: true });
	const manifest = await readManifest();

	const threads = sharp.concurrency();
	sharp.concurrency(ENCODE_THREADS);
	sharp.cache(false);
	let made = 0;
	try {
		for (let row = 1; row <= MAP_ROWS; row++) {
			for (let column = 1; column <= MAP_COLUMNS; column++) {
				const tileKey = `row-${row}-column-${column}`;
				if (!(await generateTile(tileKey, manifest, force))) continue;
				made++;
				await Bun.write(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
				if (log) console.log(`  ${tileKey} done`);
			}
		}
	} finally {
		sharp.concurrency(threads);
		sharp.cache(true);
	}
	if (made) version = null;
	if (made) console.log(`Map tiles: ${made} generated in ${Math.round((Date.now() - start) / 1000)}s`);
	return made;
}
