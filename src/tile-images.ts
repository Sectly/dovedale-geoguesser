import sharp from "sharp";
import { readFileSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { PUBLIC_DIR } from "./config";

const IMAGES_DIR = join(PUBLIC_DIR, "images");
const GENERATED_DIR = join(IMAGES_DIR, "generated");
const MANIFEST_PATH = `${GENERATED_DIR}/manifest.json`;

/** Keep in step with MAP_QUALITY_SCALE in public/js/map-canvas.js. Full-size PNG is the original image. */
const QUALITY_VARIANTS: {
	name: string;
	widthPercent: number;
	webpQuality: number;
	avifQuality: number;
	png: boolean;
}[] = [
	{ name: "high", widthPercent: 100, webpQuality: 90, avifQuality: 65, png: false },
	{ name: "medium", widthPercent: 75, webpQuality: 90, avifQuality: 55, png: true },
	{ name: "low", widthPercent: 45, webpQuality: 70, avifQuality: 35, png: true },
	{ name: "tiny", widthPercent: 25, webpQuality: 70, avifQuality: 35, png: true },
];
const formatsOf = (variant: (typeof QUALITY_VARIANTS)[number]) => ["webp", "avif", ...(variant.png ? ["png"] : [])];
const VARIANTS_CONFIG_HASH = Bun.hash(JSON.stringify(QUALITY_VARIANTS)).toString(16);

const MAP_ROWS = 1;
const MAP_COLUMNS = 16;

/** One image at a time, on one thread, with a rest between: a full-size AVIF encode alone needs about 500 MB. */
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

async function variantFilesExist(tileKey: string): Promise<boolean> {
	for (const variant of QUALITY_VARIANTS)
		for (const format of formatsOf(variant))
			if (!(await Bun.file(`${GENERATED_DIR}/${tileKey}-${variant.name}.${format}`).exists())) return false;
	return true;
}

/** Writes every size and format of one tile, one file at a time. Returns false when it was already up to date. */
async function generateTile(tileKey: string, manifest: Record<string, string>, force: boolean): Promise<boolean> {
	const source = join(IMAGES_DIR, `${tileKey}.png`);
	const sourceFile = Bun.file(source);
	if (!(await sourceFile.exists())) return false;

	const hash = `${Bun.hash(await sourceFile.arrayBuffer()).toString(16)}-${VARIANTS_CONFIG_HASH}`;
	if (!force && manifest[tileKey] === hash && (await variantFilesExist(tileKey))) return false;

	const sourceWidth = (await sharp(source).metadata()).width ?? 0;
	for (const variant of QUALITY_VARIANTS) {
		const width = Math.round((sourceWidth * variant.widthPercent) / 100);
		const out = `${GENERATED_DIR}/${tileKey}-${variant.name}`;
		for (const format of formatsOf(variant)) {
			const image = sharp(source, { sequentialRead: true }).resize({ width });
			if (format === "webp") await image.webp({ quality: variant.webpQuality }).toFile(`${out}.webp`);
			else if (format === "avif")
				await image.avif({ quality: variant.avifQuality, effort: AVIF_EFFORT }).toFile(`${out}.avif`);
			else await image.png({ compressionLevel: 9 }).toFile(`${out}.png`);
			await Bun.sleep(PAUSE_MS);
		}
	}
	manifest[tileKey] = hash;
	return true;
}

/** Makes the smaller and AVIF map tiles that are missing or out of date. `force` redoes them all. */
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
				/** Saved after every tile, so an interrupted run carries on where it stopped. */
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
