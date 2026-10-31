"""Restore the original WordPress Nginx attachment; never restores over content."""
import os
import pathlib
import subprocess
import sys

backup = pathlib.Path(sys.argv[1]).resolve(strict=True)
if backup.parent != pathlib.Path("/var/backups") or not backup.name.startswith("galgame-firefly-"):
    raise SystemExit("Unexpected backup directory")
old = pathlib.Path("/etc/nginx/sites-enabled/wordpress.conf")
new = pathlib.Path("/etc/nginx/sites-enabled/galgame-firefly.conf")
saved = backup / "wordpress-enabled.conf"
disabled = backup / "firefly-enabled.conf"
if not saved.is_symlink() or old.exists() or old.is_symlink() or not new.is_symlink():
    raise SystemExit("Unexpected Nginx attachment state")

subprocess.run(["systemctl", "enable", "--now", "php8.4-fpm"], check=True)
os.replace(new, disabled)
os.replace(saved, old)
try:
    subprocess.run(["nginx", "-t"], check=True)
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
except BaseException:
    os.replace(old, saved)
    os.replace(disabled, new)
    subprocess.run(["nginx", "-t"], check=True)
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
    raise
print("WordPress routing restored. Firefly files and backups are retained.")
