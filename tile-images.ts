import sharp from "sharp";

const IMAGES_DIR = "./public/images";
const GENERATED_DIR = "./public/images/generated";
const MANIFEST_PATH = `${GENERATED_DIR}/manifest.json`;

const QUALITY_VARIANTS = [
	{ name: "medium", widthPercent: 75, webpQuality: 90 },
	{ name: "low", widthPercent: 45, webpQuality: 70 },
];
const VARIANTS_CONFIG_HASH = Bun.hash(JSON.stringify(QUALITY_VARIANTS)).toString(16);

const MAP_ROWS = 1;
const MAP_COLUMNS = 16;

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
	for (const variant of QUALITY_VARIANTS) {
		const exists = await Bun.file(`${GENERATED_DIR}/${tileKey}-${variant.name}.webp`).exists();
		if (!exists) return false;
	}
	return true;
}

async function generateTile(tileKey: string, manifest: Record<string, string>) {
	const sourcePath = `${IMAGES_DIR}/${tileKey}.png`;
	const sourceFile = Bun.file(sourcePath);
	if (!(await sourceFile.exists())) return;

	const sourceBytes = await sourceFile.arrayBuffer();
	const contentHash = Bun.hash(sourceBytes).toString(16);
	const hash = `${contentHash}-${VARIANTS_CONFIG_HASH}`;

	if (manifest[tileKey] === hash && (await variantFilesExist(tileKey))) {
		return;
	}

	const sourceWidth = (await sharp(sourceBytes).metadata()).width ?? 0;

	await Promise.all(
		QUALITY_VARIANTS.map((variant) =>
			sharp(sourceBytes)
				.resize({
					width: Math.round((sourceWidth * variant.widthPercent) / 100),
				})
				.webp({ quality: variant.webpQuality })
				.toFile(`${GENERATED_DIR}/${tileKey}-${variant.name}.webp`)
		)
	);

	manifest[tileKey] = hash;
}

export async function generateTileVariants() {
	const start = Date.now();

	await Bun.$`mkdir -p ${GENERATED_DIR}`.quiet();

	const manifest = await readManifest();

	const tileKeys: string[] = [];
	for (let row = 1; row <= MAP_ROWS; row++) {
		for (let column = 1; column <= MAP_COLUMNS; column++) {
			tileKeys.push(`row-${row}-column-${column}`);
		}
	}

	await Promise.all(tileKeys.map((tileKey) => generateTile(tileKey, manifest)));

	await Bun.write(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

	console.log(`Tile variants generated in ${Date.now() - start}ms`);
}
