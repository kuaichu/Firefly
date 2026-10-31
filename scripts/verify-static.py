"""Check migrated output and deployed HTTP paths without operating a browser."""
import argparse
import concurrent.futures
import json
import pathlib
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.canonical = []
        self.links = []
        self.images = []
        self.downloads = []

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "link" and attrs.get("rel") == "canonical":
            self.canonical.append(attrs.get("href", ""))
        if tag == "a" and attrs.get("href"):
            self.links.append(attrs["href"])
            if "resource-download" in attrs.get("class", "").split():
                self.downloads.append(attrs)
        if tag == "img" and attrs.get("src"):
            self.images.append(attrs["src"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://10.0.0.211:4322")
    options = parser.parse_args()
    base = options.base.rstrip("/")
    manifest = json.loads((ROOT / "src/data/wordpress-legacy.json").read_text(encoding="utf-8"))
    exported = json.loads((ROOT / ".migration/wordpress-public.json").read_text(encoding="utf-8"))
    issues, assets, links, cases = [], set(), set(), []
    total_downloads = 0
    for post_id, slug in manifest["posts"].items():
        target = DIST / slug / "index.html"
        if not target.is_file():
            issues.append(f"Missing migrated post: {post_id}")
            continue
        content = target.read_text(encoding="utf-8")
        page = Page()
        page.feed(content)
        expected = f"https://gal.yeque.top/{slug}/"
        if len(page.canonical) != 1 or urllib.parse.unquote(page.canonical[0]) != expected:
            issues.append(f"Wrong canonical: {post_id}")
        if "[downloadbtn" in content:
            issues.append(f"Unconverted shortcode: {post_id}")
        original = next(post for post in exported["posts"] if f"wp-{post['id']}" == post_id)
        expected_count = original["content"].lower().count("[downloadbtn ")
        if len(page.downloads) != expected_count:
            issues.append(f"Download count mismatch: {post_id}")
        total_downloads += len(page.downloads)
        for download in page.downloads:
            if download.get("target") != "_blank" or "noopener" not in download.get("rel", ""):
                issues.append(f"Unsafe external download attributes: {post_id}")
        for image in page.images:
            if image.startswith("/"):
                assets.add(urllib.parse.unquote(urllib.parse.urlsplit(image).path))
        for link in page.links:
            parts = urllib.parse.urlsplit(link)
            if parts.netloc in ("", "gal.yeque.top") and parts.path.startswith("/"):
                links.add(urllib.parse.unquote(parts.path))
        cases.append(("/" + urllib.parse.quote(slug, safe="!~*'()") + "/", 200))
    for asset in assets:
        if not (DIST / asset.lstrip("/")).is_file():
            issues.append(f"Missing image: {asset}")
    for link in links:
        target = DIST / link.lstrip("/")
        if not target.is_file() and not (target / "index.html").is_file():
            issues.append(f"Missing internal link: {link}")
    for path in ["/", "/2/", "/10/", "/years/", "/years/1999/", "/years/2021/", "/archive/",
                 "/categories/", "/tags/", "/search/?q=ATRI", "/sitemap-index.xml",
                 "/pagefind/pagefind.js", "/api/allPostMeta.json", "/covers/wp-604.webp"]:
        cases.append((path, 200))
    for path in ["/this-page-does-not-exist/", "/wp-admin/", "/wp-login.php", "/years/1900/"]:
        cases.append((path, 404))
    cases.append(("/.git/config", 403))

    def request(case):
        path, expected = case
        try:
            with urllib.request.urlopen(urllib.request.Request(base + path, headers={"Host": "gal.yeque.top"}), timeout=12) as response:
                response.read()
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code
        except Exception as error:
            return f"HTTP request failed: {path}: {type(error).__name__}"
        return f"HTTP {status}, expected {expected}: {path}" if status != expected else None

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        issues.extend(result for result in pool.map(request, cases) if result)
    report = {"base": base, "posts": len(manifest["posts"]), "download_buttons": total_downloads,
              "unique_images": len(assets), "internal_paths": len(links), "http_requests": len(cases), "issues": issues}
    (ROOT / ".migration/site-verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if issues:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
