"""Generate Nginx preview/production configurations and WordPress URL maps."""
import json
import pathlib
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEST = ROOT / "deployment"
DEST.mkdir(exist_ok=True)
data = json.loads((ROOT / "src/data/wordpress-legacy.json").read_text(encoding="utf-8"))


def quote(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('$', '\\$') + '"'


def post_url(slug):
    return "/" + urllib.parse.quote(slug, safe="!~*'()") + "/"


redirects = {}
for post_id, slug in data["posts"].items():
    redirects[f"/posts/{post_id}/"] = post_url(slug)
for old, slug in data["oldSlugs"].items():
    if old not in data["posts"].values():
        redirects[f"/{old}/"] = post_url(slug)
for term in data["terms"]:
    slug = urllib.parse.unquote(term["slug"])
    key = "category" if term["taxonomy"] == "category" else "tag"
    target = f"/archive/?{key}=" + urllib.parse.quote(term["name"])
    redirects[f"/{key}/{slug}/"] = target
    # The old theme can remove the category URL prefix.
    if key == "category" and slug not in data["posts"].values():
        redirects[f"/{slug}/"] = target
for number in range(2, 1 + len(list((ROOT / 'dist').glob('[0-9]*/index.html'))) + 1):
    redirects[f"/page/{number}/"] = f"/{number}/"

maps = ["# Generated from public WordPress metadata; no database credentials.",
        "map_hash_bucket_size 512;",
        "map $uri $galgame_legacy_redirect {", '    default "";']
for source, target in redirects.items():
    maps.append(f"    {quote(source)} {quote(target)};")
maps.append("}")
maps.extend(["map $arg_p $galgame_post_id_redirect {", '    default "";'])
maps.extend(f"    {quote(key)} {quote(value)};" for key, value in data["ids"].items())
maps.extend(["}", "map $arg_game_year $galgame_year_redirect {", '    default "";'])
maps.extend(f'    "{path.name}" "/years/{path.name}/";' for path in sorted((ROOT / "dist/years").iterdir()) if path.is_dir())
maps.append("}")
(DEST / "galgame-firefly-maps.conf").write_text("\n".join(maps) + "\n", encoding="utf-8")

for preview in (True, False):
    kind = "preview" if preview else "production"
    port = 4322 if preview else 4321
    link = "preview" if preview else "current"
    access = """
    allow 10.0.0.0/8;
    allow 172.16.0.0/12;
    allow 192.168.0.0/16;
    allow 127.0.0.1;
    deny all;
    add_header X-Robots-Tag "noindex, nofollow" always;
""" if preview else ""
    config = f"""# Firefly {kind}; replaces no PHP or database configuration.
server {{
    listen {port};
    server_name gal.yeque.top 10.0.0.211 _;
    root /opt/galgame-firefly/{link};
    index index.html;
    charset utf-8;
    absolute_redirect off;
    access_log /var/log/nginx/galgame-firefly-{kind}.access.log;
    error_log /var/log/nginx/galgame-firefly-{kind}.error.log;
    {access}
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
    add_header Strict-Transport-Security "max-age=31536000" always;

    gzip on;
    gzip_min_length 1024;
    gzip_vary on;
    gzip_types text/css application/javascript application/json application/wasm image/svg+xml application/xml;

    if ($galgame_legacy_redirect != "") {{ return 301 $galgame_legacy_redirect; }}

    error_page 404 /404.html;
    location = /404.html {{ internal; }}

    location = / {{
        if ($galgame_post_id_redirect != "") {{ return 301 $galgame_post_id_redirect; }}
        if ($arg_s != "") {{ return 302 /search/?q=$arg_s; }}
        if ($galgame_year_redirect != "") {{ return 302 $galgame_year_redirect; }}
        try_files /index.html =404;
    }}
    location = /wp-sitemap.xml {{ return 301 /sitemap-index.xml; }}
    location = /feed/ {{ return 301 /rss.xml; }}
    location ^~ /api/v1/ {{
        client_max_body_size 5m;
        proxy_pass http://127.0.0.1:4323;
        proxy_read_timeout 20s;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }}
    location ~ ^/(?:friends|guestbook|dynamic|projects|gallery|booknav|bilibili|bangumi|vndb|myanimelist|sponsor)(?:/|$) {{ return 404; }}
    location ~ /\\. {{ deny all; }}
    location ~ \\.php(?:/|$) {{ return 404; }}
    location /_astro/ {{
        expires 1y;
        try_files $uri =404;
    }}
    location /pagefind/ {{
        expires 5m;
        try_files $uri =404;
    }}
    location ~* \\.(?:webp|png|jpe?g|gif|avif|svg|ico)$ {{
        expires 7d;
        try_files $uri =404;
    }}
    location / {{ try_files $uri $uri/ =404; }}
}}
"""
    (DEST / f"galgame-firefly-{kind}.conf").write_text(config, encoding="utf-8")
print(f"Generated Nginx configs with {len(redirects)} legacy path redirects.")
