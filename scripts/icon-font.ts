/** `bun run icons`: copies the icon font before a deploy restarts. */
import { copyIconFont } from "../src/icon-font";
import { usedIcons } from "../src/icons";

try {
	console.log(`Icon font ${await copyIconFont(usedIcons())}`);
} catch (err) {
	/** Not fatal: the server copies it on the first page view instead. */
	console.error(`Could not copy the icon font: ${err instanceof Error ? err.message : err}`);
}
