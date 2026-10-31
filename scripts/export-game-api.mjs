import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { fromHtml } from "hast-util-from-html";
import { visit } from "unist-util-visit";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
const apiBase = (process.env.PUBLIC_GAME_API_BASE_URL || "").replace(/\/+$/, "");
if (apiBase && !/^https?:\/\//.test(apiBase)) {
	throw new Error("PUBLIC_GAME_API_BASE_URL must be an absolute HTTP(S) URL");
}
async function files(directory) {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	return (await Promise.all(entries.map((entry) => {
		const target = path.join(directory, entry.name);
		return entry.isDirectory() ? files(target) : [target];
	}))).flat();
}
const plain = (html) => sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
const textOf = (node) => node.type === "text" ? node.value : (node.children || []).map(textOf).join("");
const posts = [];
const rewritten = new Map();
const articles = new Map();
for (const filename of await files(path.join(root, "src/content/posts"))) {
	if (!/\.mdx?$/.test(filename)) continue;
	const { data, content } = matter(await fs.readFile(filename, "utf8"));
	if (data.draft || data.password) continue;
	const id = path.relative(path.join(root, "src/content/posts"), filename).replaceAll("\\", "/").replace(/\.mdx?$/, "");
	const slug = data.legacySlug ? encodeURIComponent(data.legacySlug) : `posts/${id.split("/").map(encodeURIComponent).join("/")}`;
	const html = marked.parse(content, { async: false });
	const downloads = (data.downloads || []).map(({ label, url }) => ({ label, url }));
	if (data.downloads === undefined) visit(fromHtml(html, { fragment: true }), "element", (node) => {
		if (node.tagName !== "a" || !node.properties.className?.includes("resource-download")) return;
		const href = String(node.properties.href || "");
		if (!/^https?:\/\//.test(href)) throw new Error(`Invalid download in ${id}`);
		downloads.push({ label: plain(textOf(node)).replace(/\s*↗\s*$/, "").trim(), url: href });
	});
	for (const [index, download] of downloads.entries()) {
		if (typeof download.label !== "string" || !download.label.trim() || typeof download.url !== "string" || !/^https?:\/\//.test(download.url)) throw new Error(`Invalid download in ${id}`);
		if (apiBase) rewritten.set(download.url, `${apiBase}/games/${encodeURIComponent(id)}/downloads/${index}`);
	}
	posts.push({ id, url: `/${slug}/`, title: data.title, description: data.description || "", category: data.category || "", tags: data.tags || [], gameYear: data.gameYear || null, published: new Date(data.published).toISOString(), text: `${plain(html)} ${(data.screenshots || []).map((image) => image.group || "").join(" ")}`.replace(/\s+/g, " ").trim(), downloads });
	articles.set(path.join(dist, decodeURIComponent(slug), "index.html"), { id, downloads });
}
posts.sort((a, b) => b.published.localeCompare(a.published) || a.id.localeCompare(b.id));
const byId = new Map(posts.map((post) => [post.id, post]));
const resolveOriginalUrl = (href) => {
	if (!href.startsWith(`${apiBase}/games/`)) return href;
	const match = href.slice(apiBase.length).match(/^\/games\/([^/]+)\/downloads\/(\d+)$/);
	return match ? byId.get(decodeURIComponent(match[1]))?.downloads[Number(match[2])]?.url : href;
};
const catalog = { version: 1, generatedAt: new Date().toISOString(), posts };
await fs.mkdir(path.join(root, ".migration/api"), { recursive: true });
await fs.writeFile(path.join(root, ".migration/api/catalog.json"), JSON.stringify(catalog));
// Transform only download buttons, leaving article sources and other links intact.
let buttons = 0;
if (apiBase) {
	for (const filename of await files(dist)) {
		if (!filename.endsWith(".html")) continue;
		const before = await fs.readFile(filename, "utf8");
		const article = articles.get(filename);
		let index = 0;
		const after = before.replace(/<a\b[^>]*>/g, (tag) => {
			if (!/\bclass="[^"]*\bresource-download\b[^"]*"/.test(tag) || /\bclass="[^"]*\bresource-download-actions\b/.test(tag)) return tag;
			return tag.replace(/\bhref="([^"]*)"/, (match, href) => {
				const original = href.replaceAll("&amp;", "&");
				const target = article ? `${apiBase}/games/${encodeURIComponent(article.id)}/downloads/${index}` : rewritten.get(original);
				if (article && resolveOriginalUrl(original) !== article.downloads[index]?.url) {
					throw new Error(`Download ordering mismatch in ${filename}`);
				}
				index += 1;
				if (!target) throw new Error(`Unmapped download in ${filename}: ${original}`);
				buttons += 1;
				return `href="${target}"`;
			});
		});
		if (after !== before) await fs.writeFile(filename, after);
	}
}
console.log(`API catalog: ${posts.length} games, ${posts.reduce((n, post) => n + post.downloads.length, 0)} downloads; ${buttons} buttons connected to API.`);
