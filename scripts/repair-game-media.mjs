// Replace only known missing covers/screenshots with verified game media.
// Usage: node scripts/repair-game-media.mjs <matches-a.json> <matches-b.json>
// VNDB metadata is researched separately; this script never guesses a title.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const repairDir = path.join(root, ".migration/media-repair");
const inventory = JSON.parse(await fs.readFile(path.join(repairDir, "inventory.json"), "utf8"));
const matches = (await Promise.all(process.argv.slice(2).map(async (file) =>
	JSON.parse(await fs.readFile(file, "utf8"))))).flat();
if (!matches.length) throw new Error("Provide independently verified VNDB match files.");
const byId = new Map(matches.map((match) => [match.postId, match]));
await fs.mkdir(path.join(repairDir, "downloads"), { recursive: true });
await fs.mkdir(path.join(repairDir, "content-before"), { recursive: true });

const safe = (image) => {
	if (!image) return false;
	const host = new URL(image.url).hostname;
	return (host === "t.vndb.org" && image.sexual === 0 && image.violence === 0)
		|| (host === "shared.akamai.steamstatic.com" && image.reviewed === true
			&& image.sourcePage?.startsWith("https://store.steampowered.com/app/"));
};
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
	.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const manifestPath = path.join(root, "src/data/media-repairs.json");
let manifest = [];
try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); } catch (error) {
	if (error.code !== "ENOENT") throw error;
}
const report = [];

async function download(image) {
	if (!safe(image)) throw new Error(`Unreviewed image: ${image?.id}`);
	const cache = path.join(repairDir, "downloads", `${image.id}.jpg`);
	try { await fs.access(cache); } catch {
		const response = await fetch(image.url, {
			headers: { "User-Agent": "GalGames-media-restoration/1.0" },
			signal: AbortSignal.timeout(20000),
		});
		if (!response.ok) throw new Error(`Image HTTP ${response.status}: ${image.id}`);
		if (Number(response.headers.get("content-length") || 0) > 12_000_000) {
			throw new Error(`Unexpectedly large image: ${image.id}`);
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length > 12_000_000) throw new Error(`Image exceeds size limit: ${image.id}`);
		await sharp(bytes).metadata();
		await fs.writeFile(cache, bytes);
	}
	return cache;
}

async function prepare(postId, vn, image, kind) {
	const raw = await download(image);
	const relative = kind === "cover"
		? `/covers/wp-${postId}-${image.id}.webp`
		: `/game-media/wp-${postId}/${image.id}.webp`;
	const output = path.join(root, "public", relative);
	await fs.mkdir(path.dirname(output), { recursive: true });
	let result;
	const metadata = await sharp(raw).metadata();
	if (kind === "cover" && metadata.height > metadata.width * 1.15) {
		// Keep portrait box art fully visible instead of cropping away the title.
		const background = await sharp(raw).resize(960, 540, { fit: "cover" }).blur(24)
			.modulate({ brightness: 0.75 }).toBuffer();
		const foreground = await sharp(raw).resize(940, 520, { fit: "inside" }).toBuffer();
		const front = await sharp(foreground).metadata();
		result = await sharp(background).composite([{ input: foreground,
			left: Math.floor((960 - front.width) / 2), top: Math.floor((540 - front.height) / 2) }])
			.webp({ quality: 82 }).toFile(output);
	} else {
		result = await sharp(raw).rotate()
			.resize({ width: kind === "cover" ? 960 : 1280, withoutEnlargement: true })
			.webp({ quality: kind === "cover" ? 82 : 84 }).toFile(output);
	}
	return { kind, path: relative, source: image.url, sourcePage: image.sourcePage || `https://vndb.org/${vn.id}`,
		vndbId: vn.id, imageId: image.id, sexual: image.sexual, violence: image.violence,
		reviewed: image.reviewed === true, width: result.width, height: result.height, bytes: result.size,
		sha256: crypto.createHash("sha256").update(await fs.readFile(output)).digest("hex") };
}

for (const item of inventory) {
	const match = byId.get(item.postId);
	if (!match || match.confidence !== "confirmed" || !match.vndb?.id) {
		report.push({ postId: item.postId, status: "unmatched", title: item.title });
		continue;
	}
	const vn = match.vndb;
	const file = path.join(root, `src/content/posts/wp-${item.postId}.md`);
	let content = await fs.readFile(file, "utf8");
	const before = content;
	const existing = manifest.find((entry) => entry.postId === item.postId);
	if (existing && !content.includes('class="missing-media"') && !content.includes('image: "/covers/unavailable.svg"')) {
		report.push({ postId: item.postId, status: "already_repaired" });
		continue;
	}
	const slots = content.match(/<div class="missing-media"[^>]*>图片暂缺<\/div>/g) || [];
	const candidates = (match.selectedScreenshots || vn.screenshots || []).filter(safe);
	if (slots.length > candidates.length) {
		report.push({ postId: item.postId, status: "insufficient_safe_screenshots", needed: slots.length, available: candidates.length });
		continue;
	}
	if (item.coverMissing && !safe(match.selectedCover || vn.image)) {
		report.push({ postId: item.postId, status: "no_safe_cover" });
		continue;
	}
	const assets = [];
	if (item.coverMissing) {
		const cover = await prepare(item.postId, vn, match.selectedCover || vn.image, "cover");
		assets.push(cover);
		content = content.replace(/^image: ".*"$/m, `image: ${JSON.stringify(cover.path)}`);
	}
	for (let index = 0; index < slots.length; index++) {
		const asset = await prepare(item.postId, vn, candidates[index], "screenshot");
		assets.push(asset);
		const figure = `<figure class="game-screenshot"><img src="${asset.path}" alt="${escape(item.title)} 游戏预览图 ${index + 1}" loading="lazy" decoding="async" width="${asset.width}" height="${asset.height}" /></figure>`;
		content = content.replace(slots[index], figure);
	}
	const steamPages = [...new Set(assets.filter((asset) => asset.sourcePage.includes("store.steampowered.com"))
		.map((asset) => asset.sourcePage))];
	const steamCredits = steamPages.map((page) => `[发行商 Steam 商店](${page})`);
	const credit = `补充配图资料：[VNDB · ${vn.id}](https://vndb.org/${vn.id})${steamCredits.length ? `、${steamCredits.join("、")}` : ""}。\n\n`;
	if (!content.includes(`补充配图资料：[VNDB · ${vn.id}]`)) {
		content = content.replace("## 下载资源", credit + "## 下载资源");
	}
	// Do not alter text, dates, categories, routing, or download targets.
	const downloadLinks = (text) => [...text.matchAll(/<a class="resource-download"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
	if (JSON.stringify(downloadLinks(content)) !== JSON.stringify(downloadLinks(before))) {
		throw new Error(`Download links changed unexpectedly: ${item.postId}`);
	}
	const backup = path.join(repairDir, "content-before", path.basename(file));
	try { await fs.writeFile(backup, before, { flag: "wx" }); } catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	await fs.writeFile(file, content);
	manifest = manifest.filter((entry) => entry.postId !== item.postId);
	manifest.push({ postId: item.postId, title: item.title, vndbId: vn.id,
		matchedTitle: vn.title, matchReason: match.reason, assets });
	await fs.writeFile(manifestPath, JSON.stringify(manifest.sort((a, b) => a.postId - b.postId), null, 2) + "\n");
	report.push({ postId: item.postId, status: "repaired", covers: Number(item.coverMissing), screenshots: slots.length });
	console.log(JSON.stringify(report.at(-1)));
}
await fs.writeFile(path.join(repairDir, "repair-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ repairedGames: report.filter((x) => x.status === "repaired").length,
	remaining: report.filter((x) => !["repaired", "already_repaired"].includes(x.status)) }));
