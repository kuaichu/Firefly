// Replace menu screenshots used as covers with researched promotional artwork.
// Input is a reviewed VNDB/official-store match list; never guesses game identity.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const staging = path.join(root, ".migration/cover-review");
const downloads = path.join(staging, "downloads");
const backup = path.join(staging, "content-before");
await fs.mkdir(downloads, { recursive: true });
await fs.mkdir(backup, { recursive: true });
const matches = (await Promise.all(process.argv.slice(2).map(async (file) =>
	JSON.parse(await fs.readFile(file, "utf8"))))).flat();
const output = path.join(root, "src/data/cover-refresh.json");
let manifest = [];
try { manifest = JSON.parse(await fs.readFile(output, "utf8")); } catch (error) {
	if (error.code !== "ENOENT") throw error;
}

const safeVndb = (image) => (image?.sexual === 0 || image?.reviewed === true) && image?.violence === 0
	&& new URL(image.url).hostname === "t.vndb.org";
async function getImage(url, key) {
	const target = path.join(downloads, key);
	try { await fs.access(target); } catch {
		const response = await fetch(url, {
			headers: { "User-Agent": "GalGames-cover-maintenance/1.0" },
			signal: AbortSignal.timeout(18000),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = Buffer.from(await response.arrayBuffer());
		if (data.length > 16_000_000) throw new Error("Unexpected image size");
		await sharp(data).metadata();
		await fs.writeFile(target, data);
	}
	return target;
}

async function artwork(match) {
	if (match.steamAppId) {
		const appId = String(match.steamAppId);
		if (!/^\d+$/.test(appId)) throw new Error("Invalid Steam app ID");
		try {
			const api = path.join(downloads, `steam-${appId}.json`);
			let store;
			try { store = JSON.parse(await fs.readFile(api, "utf8")); } catch {
				const response = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=english`,
					{ signal: AbortSignal.timeout(15000) });
				if (!response.ok) throw new Error(`Steam metadata HTTP ${response.status}`);
				store = await response.json();
				if (!store[appId]?.success) throw new Error("Unavailable Steam app metadata");
				await fs.writeFile(api, JSON.stringify(store));
			}
			const data = store[appId].data;
			const header = new URL(data.header_image);
			const base = new URL("./", header);
			const options = [
				...(match.steamArtPreference === "header" ? [data.header_image] : []),
				`${header.origin}/store_item_assets/steam/apps/${appId}/capsule_616x353.jpg`,
				new URL("capsule_616x353.jpg", base).href,
				`${header.origin}/store_item_assets/steam/apps/${appId}/library_hero.jpg`,
				new URL("library_hero.jpg", base).href,
				data.capsule_image,
				data.capsule_imagev5,
				data.header_image,
			].filter(Boolean);
			for (let index = 0; index < options.length; index++) {
				try {
					const urlHash = crypto.createHash("sha256").update(options[index]).digest("hex").slice(0, 12);
					const file = await getImage(options[index], `steam-${appId}-${urlHash}.jpg`);
					const info = await sharp(file).metadata();
					if (info.width < (match.steamArtPreference === "header" ? 400 : 600) || info.height < 200) continue;
					return { file, url: options[index], sourcePage: `https://store.steampowered.com/app/${appId}/`,
						imageId: `steam-${appId}-${urlHash}`, sourceType: "official-steam-art", storeTitle: data.name };
				} catch { /* A store can omit the optional library artwork. */ }
			}
		} catch (error) {
			console.log(JSON.stringify({ postId: match.postId, steamFallback: error.message }));
		}
	}
	const image = match.selectedCover || match.vndb?.image;
	if (!safeVndb(image)) throw new Error("No matched, suitable promotional cover");
	const file = await getImage(image.url, `${image.id}.jpg`);
	return { file, url: image.url, sourcePage: `https://vndb.org/${match.vndb.id}`,
		imageId: image.id, sourceType: image.id.startsWith("sf") ? "vndb-in-game-art" : "vndb-cover" };
}

const report = [];
for (const match of matches) {
	if (match.status === "keep") {
		report.push({ postId: match.postId, status: "kept", reason: match.reason });
		continue;
	}
	if (match.status !== "confirmed" || !match.vndb?.id) {
		report.push({ postId: match.postId, status: "unresolved", reason: match.reason });
		continue;
	}
	const existing = manifest.find((row) => row.postId === match.postId);
	if (existing) { report.push({ postId: match.postId, status: "already_updated" }); continue; }
	try {
		const selected = await artwork(match);
		const secondImage = match.relatedVndb?.[0]?.image;
		let secondFile;
		if (safeVndb(secondImage)) {
			secondFile = await getImage(secondImage.url, `${secondImage.id}.jpg`);
			selected.imageId += `-${secondImage.id}`;
			selected.additionalSources = [{ source: secondImage.url, sourcePage: `https://vndb.org/${match.relatedVndb[0].id}` }];
		}
		if (match.crop) {
			const raw = await sharp(selected.file).metadata();
			const cropped = path.join(downloads, `${selected.imageId}-artwork.png`);
			await sharp(selected.file).extract({
				left: Math.round(raw.width * (match.crop.left || 0)),
				top: Math.round(raw.height * (match.crop.top || 0)),
				width: Math.round(raw.width * (match.crop.width || 1)),
				height: Math.round(raw.height * (match.crop.height || 1)),
			}).png().toFile(cropped);
			selected.file = cropped;
		}
		const filepath = path.join(root, `src/content/posts/wp-${match.postId}.md`);
		const before = await fs.readFile(filepath, "utf8");
		const previous = JSON.parse(before.match(/^image: (.*)$/m)[1]);
		const target = `/covers/art-${match.postId}-${selected.imageId}.webp`;
		const targetPath = path.join(root, "public", target);
		const metadata = await sharp(selected.file).metadata();
		let info;
		if (secondFile) {
			const bg = await sharp(selected.file).resize(1280, 720, { fit: "cover" })
				.blur(32).modulate({ brightness: 0.6 }).toBuffer();
			const layers = [];
			for (const [index, file] of [selected.file, secondFile].entries()) {
				const fg = await sharp(file).resize(600, 680, { fit: "inside" }).toBuffer();
				const size = await sharp(fg).metadata();
				layers.push({ input: fg, left: Math.floor(index * 640 + (640 - size.width) / 2), top: Math.floor((720 - size.height) / 2) });
			}
			info = await sharp(bg).composite(layers).webp({ quality: 86 }).toFile(targetPath);
		} else if (metadata.height > metadata.width * 1.1) {
			const bg = await sharp(selected.file).resize(1280, 720, { fit: "cover" })
				.blur(32).modulate({ brightness: 0.65 }).toBuffer();
			const fg = await sharp(selected.file).resize(1248, 688, { fit: "inside" }).toBuffer();
			const size = await sharp(fg).metadata();
			info = await sharp(bg).composite([{ input: fg,
				left: Math.floor((1280 - size.width) / 2), top: Math.floor((720 - size.height) / 2) }])
				.webp({ quality: 86 }).toFile(targetPath);
		} else {
			info = await sharp(selected.file).rotate().resize({ width: 1600, withoutEnlargement: true })
				.webp({ quality: 86 }).toFile(targetPath);
		}
		let after = before.replace(/^image: .*$/m, `image: ${JSON.stringify(target)}`);
		const credit = `封面资料：[${selected.sourceType === "official-steam-art" ? "发行商 Steam 商店" : "VNDB"}](${selected.sourcePage})。\n\n`;
		if (!after.includes(credit)) after = after.replace("## 下载资源", credit + "## 下载资源");
		try { await fs.writeFile(path.join(backup, path.basename(filepath)), before, { flag: "wx" }); } catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		await fs.writeFile(filepath, after);
		manifest.push({ postId: match.postId, title: JSON.parse(before.match(/^title: (.*)$/m)[1]),
			vndbId: match.vndb.id, matchedTitle: match.vndb.title, reason: match.reason,
			previousCover: previous, path: target, source: selected.url, sourcePage: selected.sourcePage,
			imageId: selected.imageId, sourceType: selected.sourceType, storeTitle: selected.storeTitle,
			additionalSources: selected.additionalSources,
			crop: match.crop, width: info.width, height: info.height, bytes: info.size,
			sha256: crypto.createHash("sha256").update(await fs.readFile(targetPath)).digest("hex") });
		await fs.writeFile(output, JSON.stringify(manifest.sort((a, b) => a.postId - b.postId), null, 2) + "\n");
		report.push({ postId: match.postId, status: "updated", source: selected.sourceType });
		console.log(JSON.stringify(report.at(-1)));
	} catch (error) {
		report.push({ postId: match.postId, status: "failed", error: error.message });
		console.log(JSON.stringify(report.at(-1)));
	}
}
await fs.writeFile(path.join(staging, "refresh-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ updated: manifest.length, unresolved: report.filter((r) => ["failed", "unresolved"].includes(r.status)) }));
