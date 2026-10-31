import fs from "node:fs/promises";
import { createHash } from "node:crypto";

const base = (process.env.PUBLIC_GAME_API_BASE_URL || "").replace(/\/+$/, "");
const token = process.env.GAME_API_PUBLISH_TOKEN;
if (!base.startsWith("https://") || !token) {
	throw new Error("Set PUBLIC_GAME_API_BASE_URL (HTTPS) and secret GAME_API_PUBLISH_TOKEN before publishing.");
}
const body = await fs.readFile(new URL("../.migration/api/catalog.json", import.meta.url));
const response = await fetch(`${base}/catalog`, {
	method: "POST",
	headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
	body,
	signal: AbortSignal.timeout(20000),
});
if (!response.ok) throw new Error(`Catalog publish failed (HTTP ${response.status})`);
const result = await response.json();
if (result.sha256 !== createHash("sha256").update(body).digest("hex")) {
	throw new Error("Published catalog checksum does not match");
}
console.log(`API catalog published: ${result.games} games; checksum verified.`);
