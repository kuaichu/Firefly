"""Atomically select a new, already uploaded static release. Run on server."""
import json
import os
import pathlib
import sys

release = pathlib.Path(sys.argv[1]).resolve(strict=True)
base = pathlib.Path("/opt/galgame-firefly")
current = base / "current"
staged = base / "current.next"
if release.parent != base / "releases" or not (release / "index.html").is_file() or not (release / "pagefind/pagefind.js").is_file():
    raise SystemExit("Unexpected or incomplete static release")
if not current.is_symlink() or current.resolve().parent != base / "releases":
    raise SystemExit("Unexpected current release attachment")
if staged.exists() or staged.is_symlink():
    raise SystemExit("A pending release attachment already exists")
previous = current.resolve()
staged.symlink_to(release, target_is_directory=True)
os.replace(staged, current)
state_file = base / "active-release.json"
state = json.loads(state_file.read_text())
state.update({"status": "active", "release": str(release), "previous": str(previous)})
state_file.write_text(json.dumps(state, indent=2) + "\n")
print(json.dumps(state))
