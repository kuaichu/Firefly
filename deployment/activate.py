"""Run on the server as root after staging and validating a Firefly release.

Usage: python3 activate.py /opt/galgame-firefly/releases/release-... /var/backups/galgame-firefly-...
Only changes the Nginx site attachment. WordPress files/database are retained.
"""
import json
import os
import pathlib
import subprocess
import sys

release = pathlib.Path(sys.argv[1]).resolve(strict=True)
backup = pathlib.Path(sys.argv[2]).resolve(strict=True)
if release.parent != pathlib.Path("/opt/galgame-firefly/releases"):
    raise SystemExit("Unexpected release path")
if backup.parent != pathlib.Path("/var/backups") or not backup.name.startswith("galgame-firefly-"):
    raise SystemExit("Unexpected backup path")
if not (backup / "wordpress.sql").is_file() or not (backup / "wordpress-files.tar.gz").is_file():
    raise SystemExit("WordPress backup is incomplete")
if not (release / "index.html").is_file() or not (release / "pagefind/pagefind.js").is_file():
    raise SystemExit("Static release is incomplete")

old = pathlib.Path("/etc/nginx/sites-enabled/wordpress.conf")
new = pathlib.Path("/etc/nginx/sites-enabled/galgame-firefly.conf")
configuration = pathlib.Path("/etc/nginx/sites-available/galgame-firefly.conf")
current = pathlib.Path("/opt/galgame-firefly/current")
saved = backup / "wordpress-enabled.conf"
if not old.is_symlink() or old.resolve() != pathlib.Path("/etc/nginx/sites-available/wordpress.conf"):
    raise SystemExit("Unexpected active WordPress Nginx attachment")
if new.exists() or new.is_symlink() or current.exists() or saved.exists() or saved.is_symlink():
    raise SystemExit("An active release or cutover backup already exists")
if not configuration.is_file():
    raise SystemExit("Missing production Nginx configuration")

current.symlink_to(release, target_is_directory=True)
os.replace(old, saved)
new.symlink_to(configuration)
try:
    subprocess.run(["nginx", "-t"], check=True)
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
except BaseException:
    new.unlink(missing_ok=True)
    os.replace(saved, old)
    subprocess.run(["nginx", "-t"], check=True)
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
    current.unlink(missing_ok=True)
    raise

result = {"status": "active", "release": str(release), "backup": str(backup)}
pathlib.Path("/opt/galgame-firefly/active-release.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
