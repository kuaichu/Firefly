import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { fromHtml } from "hast-util-from-html";
import { visit } from "unist-util-visit";

// Dry-run by default. Originals and the full identity audit stay in ignored .migration/.
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "src/content/posts");
const auditDirectory = path.join(root, ".migration/cms");
const backupDirectory = path.join(auditDirectory, "content-before");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--write")) {
	throw new Error("Usage: node scripts/migrate-cms-fields.mjs [--write]");
}
const write = args.includes("--write");
const hasClass = (node, name) => node.properties?.className?.includes(name);
const textOf = (node) => {
	if (node.type === "text") return node.value;
	if (node.properties?.ariaHidden === "true") return "";
	return (node.children || []).map(textOf).join("");
};
const offsets = (node) => {
	assert.ok(node.position?.start.offset !== undefined && node.position?.end.offset !== undefined);
	return [node.position.start.offset, node.position.end.offset];
};
const removeRanges = (value, ranges) => ranges
	.toSorted((a, b) => b[0] - a[0])
	.reduce((result, [start, end]) => result.slice(0, start) + result.slice(end), value);

function readPost(raw) {
	const header = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	assert.ok(header, "Expected YAML frontmatter");
	return { data: matter(raw).data, header: header[0], body: raw.slice(header[0].length) };
}

function legacyFields(body) {
	const screenshots = [];
	const downloads = [];
	const figureRanges = [];
	const downloadRanges = [];
	const galleryHeadings = [...body.matchAll(/^## 游戏截图(?:\[([^\r\n]*)\])?[ \t]*\r?$/gm)];
	let imageCount = 0;
	visit(fromHtml(body, { fragment: true }), "element", (node) => {
		if (node.tagName === "img") imageCount += 1;
		if (node.tagName === "figure" && hasClass(node, "game-screenshot")) {
			const children = node.children.filter((child) => child.type !== "text" || child.value.trim());
			assert.equal(children.length, 1, "Screenshot figure contains other content");
			const image = children[0];
			assert.equal(image.tagName, "img");
			assert.equal(typeof image.properties.src, "string");
			assert.equal(typeof image.properties.alt, "string");
			const screenshot = { image: image.properties.src, alt: image.properties.alt };
			const heading = galleryHeadings.findLast((entry) => entry.index < node.position.start.offset);
			if (heading?.[1]) screenshot.group = heading[1];
			for (const dimension of ["width", "height"]) {
				if (image.properties[dimension] === undefined) continue;
				const value = Number(image.properties[dimension]);
				assert.ok(Number.isInteger(value) && value > 0, `Invalid ${dimension}`);
				screenshot[dimension] = value;
			}
			screenshots.push(screenshot);
			figureRanges.push(offsets(node));
		}
		if (node.tagName === "a" && hasClass(node, "resource-download")) {
			assert.match(node.properties.href, /^https?:\/\//);
			const label = textOf(node).trim();
			assert.ok(label, "Empty download label");
			downloads.push({ label, url: node.properties.href });
			downloadRanges.push(offsets(node));
		}
	});
	return { screenshots, downloads, figureRanges, downloadRanges, imageCount };
}

function migrateBody(body, legacy) {
	const headings = [...body.matchAll(/^## 下载资源[ \t]*\r?$/gm)];
	assert.equal(headings.length, 1, "Expected one final download section");
	const heading = headings[0];
	assert.ok(legacy.figureRanges.every(([, end]) => end <= heading.index));
	assert.ok(legacy.downloadRanges.every(([start]) => start > heading.index));
	// Refuse to discard an unexpected credit, paragraph, or other section in the tail.
	const tail = removeRanges(body, legacy.downloadRanges).slice(heading.index + heading[0].length)
		.replace(/<div class="resource-downloads" data-pagefind-ignore>|<div class="resource-download-actions">|<\/div>|<p>选择对应版本下载。<\/p>/g, "").trim();
	assert.ok(tail === "" || (legacy.downloads.length === 0 && tail === "暂无下载链接。"), "Unexpected content in download section");
	let remaining = removeRanges(body.slice(0, heading.index), legacy.figureRanges);
	// Credit lines and placeholder messages are body content, not gallery headings.
	// Keep their bytes intact while dropping headings for the migrated gallery.
	const galleryHeadingRanges = [];
	for (const entry of remaining.matchAll(/^## 游戏截图(?:\[[^\r\n]*\])?[ \t]*\r?\n/gm)) {
		const sectionStart = entry.index + entry[0].length;
		const nextHeading = remaining.slice(sectionStart).search(/^## /m);
		const section = remaining.slice(sectionStart, nextHeading < 0 ? undefined : sectionStart + nextHeading);
		const meaningful = section
			.replace(/^[^\r\n]*资料：[^\r\n]*(?:\r?\n|$)/gm, "")
			.replace(/&nbsp;|<div(?: class="poem")?>|<\/div>/g, "").trim();
		// Retain the heading when a missing-media explanation or prose still uses it.
		if (!meaningful) galleryHeadingRanges.push([entry.index, sectionStart]);
	}
	remaining = removeRanges(remaining, galleryHeadingRanges);
	// These obsolete headings only contain whitespace / an empty poem wrapper;
	// source credits that follow them are retained verbatim.
	remaining = remaining.replace(/^## 下载链接[ \t]*\r?\n(?=(?:\s|&nbsp;|<div class="poem">|<\/div>)*(?:[^\r\n]*资料：|$))/gm, "");
	return remaining.replace(/^[ \t]+(?=\r?$)/gm, "").trimEnd() + (body.includes("\r\n") ? "\r\n" : "\n");
}

function appendFields(post, fields) {
	const newline = post.header.includes("\r\n") ? "\r\n" : "\n";
	const closing = post.header.lastIndexOf(`${newline}---`);
	const lines = [];
	for (const [name, entries] of Object.entries(fields)) {
		lines.push(entries.length ? `${name}:` : `${name}: []`);
		for (const entry of entries) {
			for (const [index, [key, value]] of Object.entries(entry).entries()) {
				lines.push(`  ${index === 0 ? "- " : "  "}${key}: ${JSON.stringify(value)}`);
			}
		}
	}
	return post.header.slice(0, closing) + newline + lines.join(newline) + post.header.slice(closing);
}

function fieldsOf(post) {
	assert.ok(Array.isArray(post.data.screenshots), "Missing screenshots array");
	assert.ok(Array.isArray(post.data.downloads), "Missing downloads array");
	return { screenshots: post.data.screenshots, downloads: post.data.downloads };
}

function verify(original, migrated, originalLegacy) {
	const before = readPost(original);
	const after = readPost(migrated);
	const fields = fieldsOf(after);
	assert.deepEqual(fields, { screenshots: originalLegacy.screenshots, downloads: originalLegacy.downloads }, "Image/download identity or ordering changed");
	const { screenshots: _screenshots, downloads: _downloads, ...oldData } = after.data;
	assert.deepEqual(oldData, before.data, "Existing frontmatter changed");
	assert.equal(after.header, appendFields(before, fields), "Existing frontmatter text changed");
	assert.equal(after.body, migrateBody(before.body, originalLegacy), "Non-gallery body bytes changed");
	const leftovers = legacyFields(after.body);
	assert.equal(leftovers.figureRanges.length, 0, "Legacy screenshot figure remains");
	assert.equal(leftovers.downloadRanges.length, 0, "Legacy download link remains");
	return fields;
}

const filenames = (await fs.readdir(directory)).filter((name) => /^wp-\d+\.md$/.test(name))
	.sort((a, b) => Number(a.slice(3, -3)) - Number(b.slice(3, -3)));
// Read and plan the complete corpus before any content or backup is written.
const records = await Promise.all(filenames.map(async (filename) => {
	const current = await fs.readFile(path.join(directory, filename), "utf8");
	const post = readPost(current);
	const hasScreenshots = Object.hasOwn(post.data, "screenshots");
	const hasDownloads = Object.hasOwn(post.data, "downloads");
	assert.equal(hasScreenshots, hasDownloads, `${filename}: partial migration`);
	if (hasScreenshots) return { filename, current, after: current, skipped: true };
	const legacy = legacyFields(post.body);
	assert.equal(legacy.imageCount, legacy.screenshots.length, `${filename}: unclassified image`);
	const fields = { screenshots: legacy.screenshots, downloads: legacy.downloads };
	const after = appendFields(post, fields) + migrateBody(post.body, legacy);
	verify(current, after, legacy);
	return { filename, current, after, skipped: false };
}));

// Backups are immutable: never replace an original with a partially migrated file.
for (const record of records) {
	let baseline;
	try {
		baseline = await fs.readFile(path.join(backupDirectory, record.filename), "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (baseline !== undefined) {
		if (!record.skipped) assert.equal(baseline, record.current, `${record.filename}: existing backup differs`);
		verify(baseline, record.after, legacyFields(readPost(baseline).body));
	} else if (record.skipped) {
		// Already structured content remains untouched, even without a local backup.
		const remaining = legacyFields(readPost(record.after).body);
		assert.equal(remaining.figureRanges.length + remaining.downloadRanges.length, 0, `${record.filename}: mixed legacy/structured content`);
	}
	record.baseline = baseline ?? (record.skipped ? undefined : record.current);
}

await fs.mkdir(auditDirectory, { recursive: true });
if (write) {
	await fs.mkdir(backupDirectory, { recursive: true });
	for (const record of records.filter((record) => !record.skipped)) {
		try {
			await fs.writeFile(path.join(backupDirectory, record.filename), record.current, { flag: "wx" });
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
	}
	for (const record of records.filter((record) => !record.skipped)) {
		// Avoid overwriting an edit made after this run read its input.
		assert.equal(await fs.readFile(path.join(directory, record.filename), "utf8"), record.current, `${record.filename}: changed during migration`);
		await fs.writeFile(path.join(directory, record.filename), record.after);
	}
}

const posts = [];
for (const record of records) {
	const after = write ? await fs.readFile(path.join(directory, record.filename), "utf8") : record.after;
	const baseline = record.baseline;
	const before = baseline ? legacyFields(readPost(baseline).body) : fieldsOf(readPost(after));
	const fields = baseline ? verify(baseline, after, before) : fieldsOf(readPost(after));
	posts.push({
		file: record.filename,
		status: record.skipped ? "already-structured" : write ? "migrated" : "planned",
		baselineAvailable: baseline !== undefined,
		before: { screenshots: before.screenshots, downloads: before.downloads },
		after: fields,
		identityMatches: true,
	});
}
const totals = (key) => ({
	posts: posts.length,
	screenshots: posts.reduce((sum, post) => sum + post[key].screenshots.length, 0),
	downloads: posts.reduce((sum, post) => sum + post[key].downloads.length, 0),
});
const report = {
	mode: write ? "write" : "dry-run",
	generatedAt: new Date().toISOString(),
	changedPosts: records.filter((record) => !record.skipped).length,
	before: totals("before"),
	after: totals("after"),
	posts,
};
const reportPath = path.join(auditDirectory, write ? "migration-report.json" : "migration-dry-run-report.json");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.mode}: ${report.changedPosts} changed; ${report.after.posts} posts, ${report.after.screenshots} screenshots, ${report.after.downloads} downloads. All identities and retained content verified.`);
console.log(`Audit: ${path.relative(root, reportPath)}`);
