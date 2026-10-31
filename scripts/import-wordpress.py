"""Convert the public WordPress export to editable Firefly Markdown content.

Usage: python scripts/import-wordpress.py .migration/wordpress-public.json
Original demo content is archived outside the content loader before import.
"""
import argparse
import collections
import html
import json
import pathlib
import re
import shutil
import tarfile
import urllib.parse
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parents[1]
BUTTON = re.compile(r"\[downloadbtn\s+link\s*=\s*(['\"])(.*?)\1\s*\](.*?)\[/downloadbtn\]", re.S | re.I)


def inside_root(path):
    resolved = path.resolve()
    if not resolved.is_relative_to(ROOT) or resolved == ROOT:
        raise ValueError(f"Unexpected migration path: {resolved}")
    return resolved


def archive_demo(name):
    source = inside_root(ROOT / "src/content" / name)
    destination = inside_root(ROOT / ".migration/upstream-content" / name)
    if source.exists() and not destination.exists():
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(destination))
    source.mkdir(parents=True, exist_ok=True)


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, value):
        self.parts.append(value)


def plain(value):
    parser = PlainText()
    parser.feed(value)
    return re.sub(r"\s+", " ", " ".join(parser.parts)).strip()


def image_tag(match, title):
    class Tag(HTMLParser):
        attrs = {}

        def handle_starttag(self, tag, attrs):
            self.attrs = dict(attrs)

    parser = Tag()
    parser.feed(match[0])
    attrs = parser.attrs
    src = attrs.get("src", "")
    parts = urllib.parse.urlsplit(src)
    if parts.hostname == "gal.yeque.top":
        src = parts.path
    src = urllib.parse.quote(urllib.parse.unquote(src), safe="/%:@?&=+-._~")
    local = ROOT / "public" / urllib.parse.unquote(src.lstrip("/"))
    if src.startswith("/wp-content/uploads/") and local.is_file():
        with local.open("rb") as source:
            if not source.read(32).strip(b"\0"):
                label = html.escape(f"{title} 游戏截图暂缺", quote=True)
                return f'\n\n<div class="missing-media" role="img" aria-label="{label}">图片暂缺</div>\n\n'
    values = {"src": src, "alt": attrs.get("alt") or f"{title} 游戏截图",
              "loading": "lazy", "decoding": "async"}
    for name in ("width", "height"):
        if attrs.get(name, "").isdigit():
            values[name] = attrs[name]
    attributes = " ".join(f'{key}="{html.escape(value, quote=True)}"' for key, value in values.items())
    return f'\n\n<figure class="game-screenshot"><img {attributes} /></figure>\n\n'


def convert_body(post):
    content = post["content"].replace("\r", "")
    buttons = []
    for match in BUTTON.finditer(content):
        target = html.unescape(match[2])
        if urllib.parse.urlsplit(target).scheme not in ("http", "https"):
            raise ValueError(f"Unsafe download scheme in post {post['id']}")
        parts = urllib.parse.urlsplit(target)
        target = urllib.parse.urlunsplit((parts.scheme, parts.netloc,
            urllib.parse.quote(urllib.parse.unquote(parts.path), safe="/%:@!$&()*+,;=-._~"),
            parts.query, parts.fragment))
        label = plain(match[3]) or "下载资源"
        buttons.append(f'<a class="resource-download" href="{html.escape(target, quote=True)}" target="_blank" rel="noopener noreferrer">{html.escape(label)}<span aria-hidden="true"> ↗</span></a>')
    content = BUTTON.sub("", content)
    if re.search(r"\[/?downloadbtn\b", content, re.I):
        raise ValueError(f"Unconverted download shortcode in post {post['id']}")
    content = re.sub(r"<!--.*?-->", "", content, flags=re.S)
    # Keep authored HTML, while headings and image boundaries become real blocks.
    content = re.sub(r"<h([1-6])\b[^>]*>(.*?)</h\1>",
        lambda m: "\n\n" + "#" * int(m[1]) + " " + plain(m[2]).rstrip("：:") + "\n\n", content, flags=re.S | re.I)
    content = re.sub(r"<img\b[^>]*>", lambda m: image_tag(m, post["title"]), content, flags=re.I)
    content = re.sub(r"\n## 下载链接\s*$", "", content.rstrip())
    content = re.sub(r"\n{3,}", "\n\n", content).strip()
    if buttons:
        content += '\n\n## 下载资源\n\n<div class="resource-downloads" data-pagefind-ignore>\n<p>选择对应版本下载。</p>\n<div class="resource-download-actions">\n' + "\n".join(buttons) + '\n</div>\n</div>\n'
    else:
        content += '\n\n## 下载资源\n\n暂无下载链接。\n'
    return content, len(buttons)


def main():
    args = argparse.ArgumentParser()
    args.add_argument("export", type=pathlib.Path)
    options = args.parse_args()
    data = json.loads(options.export.read_text(encoding="utf-8"))
    archive = ROOT / ".migration/uploads.tar.gz"
    upload_root = inside_root(ROOT / "public/wp-content")
    upload_root.mkdir(parents=True, exist_ok=True)
    if archive.exists():
        with tarfile.open(archive) as source:
            source.extractall(upload_root, filter="data")
    for name in ("posts", "dynamic", "projects", "spec"):
        archive_demo(name)
    metadata = collections.defaultdict(dict)
    for row in data["metadata"]:
        metadata[row["postId"]][row["key"]] = row["value"]
    terms = {term["taxonomyId"]: term for term in data["terms"]}
    relationships = collections.defaultdict(list)
    for row in data["relationships"]:
        if row["taxonomyId"] in terms:
            relationships[row["postId"]].append(terms[row["taxonomyId"]])
    urls, ids, old_slugs = {}, {}, {}
    downloads = 0
    for post in data["posts"]:
        post_id = post["id"]
        slug = urllib.parse.unquote(post["slug"])
        if not slug or "/" in slug or slug in urls.values():
            raise ValueError(f"Invalid or duplicate legacy slug: {post_id}")
        file_id = f"wp-{post_id}"
        urls[file_id] = slug
        ids[str(post_id)] = "/" + urllib.parse.quote(slug) + "/"
        if metadata[post_id].get("_wp_old_slug"):
            old_slugs[urllib.parse.unquote(metadata[post_id]["_wp_old_slug"])] = slug
        assigned = relationships[post_id]
        categories = [term["name"] for term in assigned if term["taxonomy"] == "category"]
        if len(categories) > 1:
            raise ValueError(f"Multiple categories need explicit migration: {post_id}")
        tags = [term["name"] for term in assigned if term["taxonomy"] == "post_tag"]
        thumbnail_id = int(metadata[post_id].get("_thumbnail_id", 0))
        thumbnail = metadata[thumbnail_id].get("_wp_attached_file", "")
        summary_source = post["excerpt"] or re.split(r"<h2[^>]*>\s*游戏截图|\[downloadbtn", post["content"], flags=re.I)[0]
        description = plain(summary_source).removeprefix("游戏介绍：").strip()[:140]
        frontmatter = {"title": post["title"], "description": description,
            "image": "/wp-content/uploads/" + urllib.parse.quote(thumbnail) if thumbnail else "",
            "category": categories[0] if categories else "未分类", "tags": tags,
            "legacyId": post_id, "legacySlug": slug, "comment": False}
        if metadata[post_id].get("game_year"):
            frontmatter["gameYear"] = int(metadata[post_id]["game_year"])
        lines = ["---"]
        for key, value in frontmatter.items():
            lines.append(f"{key}: {json.dumps(value, ensure_ascii=False)}")
        for key, source in (("published", "publishedGmt"), ("updated", "modifiedGmt")):
            value = post.get(source)
            if not value or value.startswith("0000"):
                raise ValueError(f"Missing UTC publication date in post {post_id}")
            lines.append(f"{key}: {value.replace(' ', 'T')}Z")
        body, count = convert_body(post)
        downloads += count
        (ROOT / "src/content/posts" / f"{file_id}.md").write_text("\n".join(lines) + "\n---\n\n" + body, encoding="utf-8")
    output = ROOT / "src/data/wordpress-legacy.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"posts": urls, "ids": ids, "oldSlugs": old_slugs, "terms": data["terms"]}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    about = """# 关于资源库

这里收录 GalGame 的介绍、封面、截图及不同版本的下载链接。

可以通过站内搜索查找游戏，也可以按分类、标签或已收录的发行年份浏览。
部分游戏暂未补充发行年份，不会出现在年份筛选结果中。

下载前请确认所选版本和运行平台。发现链接失效时，可记录游戏名称和对应版本以便后续核对。

本站使用 [Firefly](https://github.com/CuteLeaf/Firefly) 构建。
"""
    (ROOT / "src/content/spec/about.md").write_text(about, encoding="utf-8")
    print(json.dumps({"posts": len(urls), "attachments": len(data["attachments"]), "download_buttons": downloads,
        "year_metadata": sum(bool(metadata[p["id"]].get("game_year")) for p in data["posts"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
