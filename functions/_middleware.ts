import legacy from "../src/data/wordpress-legacy.json";

const postTargets = legacy.ids as Record<string, string>;

export const onRequest = async ({
	request,
	next,
}: {
	request: Request;
	next: (input?: Request | string, init?: RequestInit) => Promise<Response>;
}) => {
	const url = new URL(request.url);
	if (url.pathname === "/") {
		const postTarget = postTargets[url.searchParams.get("p") ?? ""];
		if (postTarget) return Response.redirect(new URL(postTarget, url.origin), 301);

		const search = url.searchParams.get("s");
		if (search) {
			const target = new URL("/search/", url.origin);
			target.searchParams.set("q", search);
			return Response.redirect(target, 302);
		}

		const year = url.searchParams.get("game_year");
		if (year && /^\d{4}$/.test(year)) {
			const target = new URL(`/years/${year}/`, url.origin);
			const page = await next(new Request(target, { method: request.method, headers: request.headers }));
			if (page.status < 400) return Response.redirect(target, 302);
			return next(new Request(url, { method: request.method, headers: request.headers }));
		}
	}

	return next();
};
