"""Exercise real API requests locally or against a deployed API, without a browser."""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[1]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def run(base, catalog, token=None):
    client = urllib.request.build_opener(NoRedirect)
    count = 0

    def request(path, status=200, data=None, headers=None, method=None):
        nonlocal count
        req = urllib.request.Request(base + path, data=data, headers={"User-Agent": "GalGameDeploymentCheck/1.0", **(headers or {})}, method=method)
        try:
            response = client.open(req, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            assert response.status == status, (path, response.status, status)
            count += 1
            return body, response.headers

    raw = catalog.read_bytes()
    posts = json.loads(raw)["posts"]
    health, _ = request("/healthz")
    assert json.loads(health)["games"] == len(posts)
    for query, expected in [("ATRI", "ATRI"), ("恋爱", "恋爱"), ("夏之雨", "夏之雨"), ("ＡＴＲＩ", "ATRI")]:
        body, _ = request("/search?q=" + urllib.parse.quote(query))
        results = json.loads(body)["results"]
        assert any(expected.casefold() in item["meta"]["title"].casefold() for item in results), query
        assert all(item["url"].startswith("/") and not item["url"].startswith("//") for item in results)
    for post in posts:
        body, _ = request(f'/games/{urllib.parse.quote(post["id"], safe="")}/downloads')
        assert len(json.loads(body)["downloads"]) == len(post["downloads"])
        for index, download in enumerate(post["downloads"]):
            _, headers = request(f'/games/{urllib.parse.quote(post["id"], safe="")}/downloads/{index}', 302, method="HEAD")
            assert headers["Location"] == download["url"], (post["id"], index)
    request("/games/unknown/downloads/0", 404)
    request("/games/wp-209/downloads/0", 404)
    request("/search?q=" + "a" * 161, 400)
    request("/search?q=test&limit=invalid", 400)
    request("/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E")
    _, headers = request("/healthz", headers={"Origin": "https://gal.yeque.top"})
    assert headers.get("Access-Control-Allow-Origin") == "https://gal.yeque.top"
    _, headers = request("/healthz", headers={"Origin": "https://untrusted.invalid"})
    assert headers.get("Access-Control-Allow-Origin") is None
    request("/catalog", 401, data=raw)
    if token:
        headers = {"Authorization": f"Bearer {token}"}
        for bad in [b"[]", b"{}", b'{"version":1,"posts":[{}]}']:
            request("/catalog", 400, data=bad, headers=headers)
        response, _ = request("/catalog", data=raw, headers=headers)
        assert json.loads(response)["sha256"] == hashlib.sha256(raw).hexdigest()
        updated = json.loads(raw)
        updated["posts"][0]["title"] = "catalog-live-reload-probe"
        request("/catalog", data=json.dumps(updated).encode(), headers=headers)
        body, _ = request("/search?q=catalog-live-reload-probe")
        assert json.loads(body)["total"] == 1
    print(json.dumps({"base": base, "games": len(posts), "download_redirects": sum(len(post["downloads"]) for post in posts), "http_checks": count, "issues": []}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", help="Existing API base, including /api/v1; otherwise run an isolated local service")
    args = parser.parse_args()
    catalog = ROOT / ".migration/api/catalog.json"
    if args.base:
        run(args.base.rstrip("/"), catalog)
        return
    spec = importlib.util.spec_from_file_location("game_api", ROOT / "deployment/game-api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory() as directory:
        local_catalog = pathlib.Path(directory) / "catalog.json"
        local_catalog.write_bytes(catalog.read_bytes())
        module.CATALOG = local_catalog
        module.PUBLISH_TOKEN = "isolated-test-token"
        module.Handler.log_message = lambda *args: None
        service = ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
        thread = threading.Thread(target=service.serve_forever, daemon=True)
        thread.start()
        try:
            run(f"http://127.0.0.1:{service.server_port}/api/v1", local_catalog, module.PUBLISH_TOKEN)
        finally:
            service.shutdown()
            service.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    main()
