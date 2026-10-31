import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// Keep the original media URLs; use small local covers for list and article UI.
const root = process.cwd();
const content = path.join(root, "src/content/posts");
const output = path.join(root, "public/covers");
await fs.mkdir(output, { recursive: true });
let count = 0;
let originalBytes = 0;
let coverBytes = 0;
const unavailable = [];
for (const filename of await fs.readdir(content)) {
	if (!/^wp-\d+\.md$/.test(filename)) continue;
	const file = path.join(content, filename);
	let source = await fs.readFile(file, "utf8");
	const match = source.match(/^image: (".*")$/m);
	if (!match) continue;
	const image = JSON.parse(match[1]);
	if (!image.startsWith("/wp-content/uploads/")) continue;
	const input = path.resolve(root, "public", `.${decodeURIComponent(image)}`);
	if (!input.startsWith(path.join(root, "public/wp-content/uploads") + path.sep)) {
		throw new Error(`Unexpected cover path: ${filename}`);
	}
	const target = path.join(output, filename.replace(/\.md$/, ".webp"));
	let candidate = input;
	try {
		await sharp(candidate).metadata();
	} catch {
		const parsed = path.parse(input);
		const variants = (await fs.readdir(parsed.dir))
			.filter((name) => name.startsWith(`${parsed.name}-`) && path.extname(name) === parsed.ext);
		candidate = "";
		for (const variant of variants.reverse()) {
			try {
				const next = path.join(parsed.dir, variant);
				await sharp(next).metadata();
				candidate = next;
				break;
			} catch { /* Try another existing thumbnail. */ }
		}
	}
	if (!candidate) {
		unavailable.push(filename);
		source = source.replace(/^image: .*$/m, 'image: "/covers/unavailable.svg"');
		await fs.writeFile(file, source);
		continue;
	}
	await sharp(candidate).rotate().resize({ width: 640, withoutEnlargement: true })
		.webp({ quality: 78 }).toFile(target);
	originalBytes += (await fs.stat(input)).size;
	coverBytes += (await fs.stat(target)).size;
	count++;
	source = source.replace(/^image: .*$/m, `image: ${JSON.stringify(`/covers/${path.basename(target)}`)}`);
	await fs.writeFile(file, source);
}
await fs.writeFile(path.join(output, "unavailable.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" rx="20" fill="#edf5f2"/><path d="M265 125h110v80H265z M275 191l28-28 24 24 14-14 24 24" fill="none" stroke="#6d9788" stroke-width="5"/><circle cx="345" cy="148" r="7" fill="#6d9788"/><text x="320" y="250" text-anchor="middle" fill="#507566" font-family="system-ui,sans-serif" font-size="23">封面暂缺</text></svg>');
await fs.writeFile(path.join(root, ".migration/cover-audit.json"), JSON.stringify({ optimizedCovers: count, unavailable, originalBytes, coverBytes }, null, 2));
console.log(JSON.stringify({ optimizedCovers: count, unavailable: unavailable.length, originalBytes, coverBytes }));
