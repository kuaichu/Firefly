"""Verify Pages routes and built download targets via HTTP without a browser."""
import argparse
import hashlib
import json
import pathlib
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parents[1]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.downloads = []
        self.images = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a" and "resource-download" in attrs.get("class", "").split():
            self.downloads.append(attrs["href"])
        if tag == "img" and attrs.get("src", "").startswith("/"):
            self.images.append(attrs["src"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8788")
    parser.add_argument("--api", default="https://gal-api.yeque.top/api/v1")
    options = parser.parse_args()
    client = urllib.request.build_opener(NoRedirect)
    count = 0

    def request(path, expected=200, target=None):
        nonlocal count
        try:
            response = client.open(urllib.request.Request(options.base.rstrip("/") + path, headers={"User-Agent": "GalGameDeploymentCheck/1.0"}), timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            assert response.status == expected, (path, response.status, expected)
            if target:
                assert urllib.parse.urljoin(options.base, response.headers["Location"]) == urllib.parse.urljoin(options.base, target), path
            count += 1
            return response.read()

    legacy = json.loads((ROOT / "src/data/wordpress-legacy.json").read_text(encoding="utf-8"))
    catalog = json.loads((ROOT / ".migration/api/catalog.json").read_text(encoding="utf-8"))
    posts = {post["id"]: post for post in catalog["posts"]}
    images = set()
    downloads = 0
    for post_id, slug in legacy["posts"].items():
        page = Page()
        page.feed(request("/" + urllib.parse.quote(slug, safe="!~*'()") + "/").decode("utf-8"))
        expected = [f'{options.api}/games/{urllib.parse.quote(post_id, safe="")}/downloads/{index}' for index in range(len(posts[post_id]["downloads"]))]
        assert page.downloads == expected, post_id
        downloads += len(page.downloads)
        images.update(page.images)
    for source in images:
        content = request(source)
        local = ROOT / "dist" / urllib.parse.unquote(source).lstrip("/")
        assert hashlib.sha256(content).digest() == hashlib.sha256(local.read_bytes()).digest(), source
    for line in (ROOT / "dist/_redirects").read_text().splitlines():
        if line.startswith("#") or not line.strip():
            continue
        source, target, status = line.split()
        request(source, int(status), target)
    request("/?p=549", 301, legacy["ids"]["549"])
    request("/?s=ATRI", 302, "/search/?q=ATRI")
    request("/?game_year=2021", 302, "/years/2021/")
    request("/?game_year=1900", 200)
    for route in ["/", "/2/", "/10/", "/years/", "/archive/", "/search/", "/api/allPostMeta.json"]:
        request(route)
    request("/nonexistent-page-for-verification/", 404)
    print(json.dumps({"base": options.base, "posts": len(posts), "download_buttons": downloads, "images_verified": len(images), "http_checks": count, "issues": []}))


if __name__ == "__main__":
    main()
