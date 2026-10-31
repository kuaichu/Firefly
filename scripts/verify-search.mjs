// Exercise the deployed Pagefind WebAssembly engine without a browser.
import fs from "node:fs/promises";
import * as pagefind from "../dist/pagefind/pagefind.js";

const base = (process.argv[2] || "http://10.0.0.211:4322").replace(/\/$/, "");
const timer = setTimeout(() => {
	console.error("Search verification timed out");
	process.exit(2);
}, 20000);
const report = [];
try {
	await pagefind.options({ basePath: `${base}/pagefind/`, baseUrl: `${base}/`, noWorker: true });
	for (const term of ["ATRI", "恋爱", "夏之雨"]) {
		const result = await pagefind.search(term);
		const matches = await Promise.all(result.results.slice(0, 3).map(async (entry) => {
			const data = await entry.data();
			return { title: data.meta.title, url: data.url };
		}));
		report.push({ term, results: result.results.length, matches });
		if (!result.results.length) throw new Error(`No results for ${term}`);
	}
	await fs.writeFile(".migration/search-verification.json", JSON.stringify({ base, queries: report }, null, 2));
	console.log(JSON.stringify(report, null, 2));
} finally {
	await pagefind.destroy();
	clearTimeout(timer);
}
