/**
 * Fills an empty local database with placeholder locations so the game can be
 * played in development: `bun run seed`. Refuses to touch a database that
 * already has locations.
 */
import sharp from "sharp";
import { join } from "path";
import { db } from "../src/db";
import { UPLOADS_DIR } from "../src/config";

const PLACES = [
	["Dovedale Central", -4200, 1800],
	["Marigot Crossing", 6100, -3400],
	["Masonfield Depot", -15800, 5200],
	["Gloucester Road", 9800, 7400],
	["Benyhone Loop", -9100, -6200],
	["Wington Mount", 2300, 10100],
	["Satus Services", 12400, -800],
	["Fanory Mill", -19600, -2100],
	["Ashburn Junction", -1200, -8300],
	["Codsall Castle", 7300, 2600],
	["Perthtyne Viaduct", -12300, 9800],
	["Glassbury Yard", 3900, -5600],
] as const;

const existing = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM locations").get()!.n;
if (existing > 0) {
	console.log(`Database already has ${existing} locations; nothing to do.`);
	process.exit(0);
}

for (const [i, [label, x, y]] of PLACES.entries()) {
	const hue = Math.round((i / PLACES.length) * 360);
	const svg = `<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg">
		<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="hsl(${hue},45%,28%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},45%,12%)"/>
		</linearGradient></defs>
		<rect width="1280" height="720" fill="url(#g)"/>
		<text x="640" y="350" font-family="Arial,sans-serif" font-size="64" font-weight="700" fill="white" text-anchor="middle">Placeholder ${i + 1}</text>
		<text x="640" y="420" font-family="Arial,sans-serif" font-size="28" fill="rgba(255,255,255,0.6)" text-anchor="middle">development screenshot</text>
	</svg>`;
	const filename = `seed-${i + 1}.webp`;
	await sharp(Buffer.from(svg)).webp({ quality: 80 }).toFile(join(UPLOADS_DIR, filename));
	db.run("INSERT INTO locations (image_path, world_x, world_y, label, hints) VALUES (?, ?, ?, ?, ?)", [
		filename,
		x,
		y,
		label,
		JSON.stringify(
			i % 2 === 0 ? [`It starts with "${label[0]}"`, `It is ${x < 0 ? "west" : "east"} of the centre`] : []
		),
	]);
}
console.log(`Seeded ${PLACES.length} placeholder locations.`);
