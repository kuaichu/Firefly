import type { SearchResult } from "@/global";

export const GAME_API_BASE_URL: string = (
	import.meta.env.PUBLIC_GAME_API_BASE_URL || ""
)
	.trim()
	.replace(/\/+$/, "");

export const hasGameApi: boolean = GAME_API_BASE_URL.length > 0;

export const SEARCH_ERROR_MESSAGE = "搜索暂时不可用，请稍后重试。";

export async function searchGames(
	keyword: string,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const timeout = AbortSignal.timeout(8000);
	const response = await fetch(
		`${GAME_API_BASE_URL}/search?q=${encodeURIComponent(keyword)}`,
		{ signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
	);
	if (!response.ok) {
		throw new Error(`Game search returned HTTP ${response.status}`);
	}
	const body: { results?: SearchResult[] } = await response.json();
	if (
		!Array.isArray(body.results) ||
		!body.results.every(
			(item) =>
				typeof item?.url === "string" &&
				typeof item?.meta?.title === "string" &&
				typeof item?.excerpt === "string",
		)
	) {
		throw new Error("Game search returned an invalid response");
	}
	return body.results;
}
