import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const legacyPath = path.join(root, "src", "data", "wordpress-legacy.json");
const maxAssets = 20_000;
const maxFileBytes = 25 * 1024 * 1024;

function encodedPathSegment(value) {
	return encodeURIComponent(value);
}

function decodePathname(pathname) {
	try {
		return pathname
			.split("/")
			.map((segment) => decodeURIComponent(segment))
			.join("/");
	} catch {
		return null;
	}
}

async function isStaticRoute(pathname) {
	const decodedPath = decodePathname(pathname);
	if (!decodedPath || decodedPath.split("/").includes("..")) return false;
	const relativePath = decodedPath.replace(/^\/+/, "");
	const candidates = relativePath.endsWith(".xml") || relativePath.includes(".")
		? [path.join(dist, relativePath)]
		: [path.join(dist, relativePath, "index.html"), path.join(dist, `${relativePath}.html`)];
	for (const candidate of candidates) {
		try {
			if ((await stat(candidate)).isFile()) return true;
		} catch {
			// Try the next static route representation.
		}
	}
	return false;
}

async function walkFiles(directory, files = []) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) await walkFiles(entryPath, files);
		else if (entry.isFile()) files.push(entryPath);
	}
	return files;
}

try {
	if (!(await stat(dist)).isDirectory()) throw new Error("dist exists but is not a directory");
} catch {
	throw new Error("dist/ is missing; run the site build before preparing Cloudflare Pages.");
}

const legacy = JSON.parse(await readFile(legacyPath, "utf8"));
const redirects = new Map();
const addRedirect = (source, target, status = 301) => {
	if (redirects.has(source)) throw new Error(`Duplicate legacy redirect source: ${source}`);
	redirects.set(source, `${target} ${status}`);
};

for (const [postId, slug] of Object.entries(legacy.posts)) {
	const target = `/${encodedPathSegment(slug)}/`;
	if (await isStaticRoute(target)) addRedirect(`/posts/${encodedPathSegment(postId)}/`, target);
}

for (const [oldSlug, slug] of Object.entries(legacy.oldSlugs)) {
	if (!Object.values(legacy.posts).includes(oldSlug) && await isStaticRoute(`/${encodedPathSegment(slug)}/`)) {
		addRedirect(`/${encodedPathSegment(oldSlug)}/`, `/${encodedPathSegment(slug)}/`);
	}
}

for (const term of legacy.terms) {
	const slug = decodeURIComponent(term.slug);
	const routeType = term.taxonomy === "category" ? "category" : "tag";
	const target = `/archive/?${routeType}=${encodedPathSegment(term.name)}`;
	addRedirect(`/${routeType}/${encodedPathSegment(slug)}/`, target);
	if (routeType === "category" && !Object.values(legacy.posts).includes(slug)) {
		addRedirect(`/${encodedPathSegment(slug)}/`, target);
	}
}

for (const page of await readdir(dist, { withFileTypes: true })) {
	if (!page.isDirectory() || !/^\d+$/.test(page.name)) continue;
	if (Object.values(legacy.ids).includes(`/${page.name}/`)) continue;
	if (await isStaticRoute(`/${page.name}/`)) addRedirect(`/page/${page.name}/`, `/${page.name}/`);
}

addRedirect("/wp-sitemap.xml", "/sitemap-index.xml");
addRedirect("/feed/", "/rss.xml");

for (const [source, targetAndStatus] of redirects) {
	const target = targetAndStatus.replace(/\s+\d+$/, "");
	const targetPath = new URL(target, "https://pages.invalid").pathname;
	if (!(await isStaticRoute(targetPath))) {
		throw new Error(`Legacy redirect target has no built static page: ${source} -> ${target}`);
	}
}

const redirectsFile = path.join(dist, "_redirects");
await writeFile(
	redirectsFile,
	`# Generated from src/data/wordpress-legacy.json and built static routes.\n${[...redirects]
		.map(([source, target]) => `${source} ${target}`)
		.join("\n")}\n`,
	"utf8",
);

// Only query compatibility at the root needs a Function. Let Pages serve all
// other paths so its static _redirects and asset caching keep working.
await writeFile(path.join(dist, "_routes.json"), JSON.stringify({ version: 1, include: ["/"], exclude: [] }));
await writeFile(path.join(dist, "_headers"), `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin
/admin/*
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-store
/_astro/*
  Cache-Control: public, max-age=31536000, immutable
/covers/*
  Cache-Control: public, max-age=604800
/game-media/*
  Cache-Control: public, max-age=604800
`);

const files = await walkFiles(dist);
const largest = await Promise.all(
	files.map(async (file) => ({
		file: path.relative(dist, file).replaceAll(path.sep, "/"),
		bytes: (await stat(file)).size,
	})),
);
largest.sort((a, b) => b.bytes - a.bytes);
const oversized = largest.filter((file) => file.bytes > maxFileBytes);
if (files.length > maxAssets) {
	throw new Error(`Cloudflare Pages asset limit exceeded: ${files.length.toLocaleString()} files (maximum ${maxAssets.toLocaleString()}).`);
}
if (oversized.length) {
	throw new Error(
		`Cloudflare Pages file-size limit exceeded (maximum 25 MiB): ${oversized
			.map(({ file, bytes }) => `${file} (${(bytes / 1024 / 1024).toFixed(2)} MiB)`)
			.join(", ")}`,
	);
}

console.log(
	`Prepared Cloudflare Pages: ${redirects.size} redirects, ${files.length.toLocaleString()} assets; largest: ${largest
		.slice(0, 5)
		.map(({ file, bytes }) => `${file} (${(bytes / 1024 / 1024).toFixed(2)} MiB)`)
		.join(", ")}.`,
);
