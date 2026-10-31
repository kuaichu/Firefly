"""Game search/download API with authenticated catalog publishing; stdlib only."""
import html
import hashlib
import hmac
import json
import os
import pathlib
import re
import threading
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

CATALOG = pathlib.Path(os.environ.get("GAME_API_CATALOG", "/var/lib/galgame-api/catalog.json"))
ORIGINS = set(os.environ.get("GAME_API_ORIGINS", "https://gal.yeque.top").split(","))
PUBLISH_TOKEN = os.environ.get("GAME_API_PUBLISH_TOKEN", "")
_lock = threading.Lock()
_signature = None
_posts = []


def normalize(value):
    return unicodedata.normalize("NFKC", str(value)).casefold()


def validate_catalog(data):
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("posts"), list) or not data["posts"]:
        raise ValueError("Unsupported or empty catalog")
    ids = set()
    for post in data["posts"]:
        if not isinstance(post, dict) or not isinstance(post.get("downloads"), list):
            raise ValueError("Invalid post")
        if not isinstance(post["id"], str) or post["id"] in ids or not all(re.fullmatch(r"[a-zA-Z0-9_-]+", part) for part in post["id"].split("/")):
            raise ValueError("Invalid or duplicate ID")
        ids.add(post["id"])
        if not isinstance(post["url"], str) or not post["url"].startswith("/") or post["url"].startswith("//") or "\\" in post["url"]:
            raise ValueError("Invalid article URL")
        for field in ("title", "description", "category", "text"):
            if not isinstance(post[field], str):
                raise ValueError("Invalid text")
        if not isinstance(post["tags"], list) or not all(isinstance(tag, str) for tag in post["tags"]):
            raise ValueError("Invalid tags")
        for download in post["downloads"]:
            url = download["url"]
            if not isinstance(download["label"], str) or urlsplit(url).scheme not in ("https", "http") or not urlsplit(url).netloc or any(c in url for c in "\r\n"):
                raise ValueError("Invalid download URL")
    return data


def load_posts():
    global _signature, _posts
    stat = CATALOG.stat()
    signature = (stat.st_mtime_ns, stat.st_size)
    with _lock:
        if signature != _signature:
            data = validate_catalog(json.loads(CATALOG.read_text(encoding="utf-8")))
            posts = data["posts"]
            for post in posts:
                post["_search"] = normalize(" ".join([post["title"], post["description"], post["category"], *post["tags"], post["text"]]))
            _posts, _signature = posts, signature
        return _posts


def search(posts, query, limit):
    tokens = normalize(query).split()
    matches = [post for post in posts if all(token in post["_search"] for token in tokens)]
    matches.sort(key=lambda post: -sum(3 if token in normalize(post["title"]) else 1 for token in tokens))
    results = []
    for post in matches[:limit]:
        description = post["description"] or post["text"]
        excerpt = html.escape(description[:220])
        results.append({"url": post["url"], "meta": {"title": html.escape(post["title"])}, "excerpt": excerpt})
    return {"results": results, "total": len(matches)}


class Handler(BaseHTTPRequestHandler):
    server_version = "GalGameAPI/1"

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def send_api_headers(self, status, content_type="application/json; charset=utf-8", cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Vary", "Origin")
        origin = self.headers.get("Origin", "")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")

    def json(self, status, data, cache="no-store"):
        content = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_api_headers(status, cache=cache)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def do_OPTIONS(self):
        self.send_api_headers(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        if self.path != "/api/v1/catalog":
            self.json(404, {"error": "Not found"})
            return
        expected = f"Bearer {PUBLISH_TOKEN}"
        if not PUBLISH_TOKEN or not hmac.compare_digest(self.headers.get("Authorization", "").encode(), expected.encode()):
            self.json(401, {"error": "Unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 5 * 1024 * 1024:
                self.json(413, {"error": "Catalog must be between 1 byte and 5 MiB"})
                return
            raw = self.rfile.read(length)
            data = validate_catalog(json.loads(raw))
        except (ValueError, TypeError, KeyError):
            self.json(400, {"error": "Invalid catalog"})
            return
        try:
            with _lock:
                temporary = CATALOG.with_suffix(".pending")
                temporary.write_bytes(raw)
                temporary.replace(CATALOG)
            self.json(200, {"games": len(data["posts"]), "sha256": hashlib.sha256(raw).hexdigest()})
        except OSError:
            self.json(503, {"error": "Catalog cannot be saved"})

    def do_GET(self):
        try:
            parts = urlsplit(self.path)
            if parts.path == "/api/v1/healthz":
                self.json(200, {"status": "ok", "games": len(load_posts())})
                return
            if parts.path == "/api/v1/search":
                args = parse_qs(parts.query)
                query = args.get("q", [""])[0].strip()
                if len(query) > 160:
                    self.json(400, {"error": "Query is too long"})
                    return
                try:
                    limit = max(1, min(200, int(args.get("limit", ["200"])[0])))
                except ValueError:
                    self.json(400, {"error": "Invalid limit"})
                    return
                self.json(200, search(load_posts(), query, limit) if query else {"results": [], "total": 0})
                return
            match = re.fullmatch(r"/api/v1/games/([^/]+)/downloads(?:/(\d+))?", parts.path)
            if match:
                post = next((post for post in load_posts() if post["id"] == unquote(match[1])), None)
                if post is None:
                    self.json(404, {"error": "Game not found"})
                    return
                if match[2] is None:
                    self.json(200, {"id": post["id"], "downloads": [{"label": item["label"], "url": f'/api/v1/games/{match[1]}/downloads/{index}'} for index, item in enumerate(post["downloads"])]})
                    return
                index = int(match[2])
                if index >= len(post["downloads"]):
                    self.json(404, {"error": "Download not found"})
                    return
                self.send_api_headers(302, "text/plain; charset=utf-8")
                self.send_header("Location", post["downloads"][index]["url"])
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.json(404, {"error": "Not found"})
        except (OSError, ValueError, TypeError, KeyError):
            self.log_error("Catalog unavailable")
            self.json(503, {"error": "Service temporarily unavailable"})


if __name__ == "__main__":
    load_posts()
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("GAME_API_PORT", "4323"))), Handler)
    server.timeout = 15
    server.serve_forever()
