# Edge Kanban

GNOME Shell 45+ extension that adds an edge-anchored, auto-hiding Kanban board directly to Shell chrome. It uses standard JavaScript modules, `gi://` imports, `St`, `Clutter`, and `Main.layoutManager.addChrome()`.

## Install From This Workspace

```sh
UUID=edge-kanban@yulian.local
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
mkdir -p "$DEST"
cp -r extension.js kanban.js metadata.json prefs.js stylesheet.css schemas "$DEST/"
glib-compile-schemas "$DEST/schemas"
gnome-extensions enable "$UUID"
```

On Wayland, log out and back in if GNOME Shell has not loaded the new extension directory yet.

## Install With Homebrew

The release artifact is designed to work as a Homebrew cask from a personal tap:

```sh
brew tap daegalus/tap
brew install --cask daegalus/tap/edge-kanban-gnome-extension
```

The cask installs the extension files into:

```text
${XDG_DATA_HOME:-~/.local/share}/gnome-shell/extensions/edge-kanban@yulian.local
```

It compiles schemas and reloads the extension after install. For release updates,
tag this repository with `vX.Y.Z`; the GitHub release workflow builds
`edge-kanban@yulian.local.shell-extension.zip` and writes a matching SHA256 file
for the cask bump.

During development, `extension.js` is a stable cache-busting loader. After one clean Shell load, edits to `kanban.js`, `prefs.js`, `stylesheet.css`, or schemas can usually be picked up with:

```sh
cp -r extension.js kanban.js metadata.json prefs.js stylesheet.css schemas "$DEST/"
glib-compile-schemas "$DEST/schemas"
gnome-extensions disable "$UUID"
gnome-extensions enable "$UUID"
```

If packaging a zip, include `kanban.js` explicitly:

```sh
gnome-extensions pack . \
  --schema=schemas/org.gnome.shell.extensions.edge-kanban.gschema.xml \
  --extra-source=kanban.js \
  --out-dir=/tmp \
  -f
```

Task data defaults to:

```text
${XDG_CONFIG_HOME:-~/.config}/edge-kanban/tasks.json
```

If an older extension-local `tasks.json` exists and the default config file does not, the extension migrates those tasks into the default config path on first load.

Extension Preferences includes:

- Background modes: off-white, transparent, follow GNOME theme, or custom hex color.
- Handle visibility modes: visible only while hidden, always visible, or transparent hit area.
- Handle coverage controls how much of the edge is used as the centered reveal target; it defaults to 70%.
- Multi-monitor mode defaults to the primary display; choose outer display edge if you want the panel on the far edge of the joined desktop.
- Drag tasks by the small handle on each item to reorder within a column.
- Click a task to reveal an indented notes drawer for links, snippets, and future-reference comments.
- Copy a Slack-friendly standup summary from the header; it includes all task columns and skips the daily routine checklist.
- Export tasks to a JSON backup.
- Import tasks by replacing the active file.
- Merge tasks from a JSON backup using per-task timestamps.
- Choose a custom JSON storage file, which is useful with Syncthing, Nextcloud, Dropbox, or a git-tracked folder.
- Open the active data folder.

Tasks are stored with `order`, `notes`, `createdAt`, `updatedAt`, and `deletedAt`. Merge keeps the newest version of each task by timestamp, and deletes are preserved as tombstones so they can sync safely across machines.

Use Extension Preferences to choose `left`, `right`, `top`, or `bottom`. Left/right render as a vertical list of board sections; top/bottom render as horizontal Kanban columns.
