#!/bin/bash
# Build the extension zip: everything that ships, nothing that doesn't.
#
#   bash scripts/package-store.sh            → dist/focus-agent-<version>.zip        (store build)
#   bash scripts/package-store.sh --friends  → dist/focus-agent-<version>-friends.zip (pilot build)
#
# Both strip: the localhost host permission + content-script match, the
# bridge server, deploy kit, docs, tests, harness. Both INCLUDE viewer/
# (pdf.js) and offscreen/ (the timer chime) — leaving them out broke PDF
# highlighting and the chime silently.
#
# --friends additionally writes build.json {"build":"friends"}: the panel
# removes every developer control at boot (the server already refuses
# developer methods for student codes; this keeps the UI honest too).
set -euo pipefail

BUILD="store"
[ "${1:-}" = "--friends" ] && BUILD="friends"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# 1. Copy only what ships.
mkdir -p "$STAGE"
cp -R "$ROOT/adapters" "$ROOT/lib" "$ROOT/overlay" "$ROOT/annotate" \
      "$ROOT/sidepanel" "$ROOT/popup" "$ROOT/icons" "$ROOT/viewer" "$ROOT/offscreen" \
      "$ROOT/content.js" "$ROOT/background.js" "$ROOT/manifest.json" "$STAGE/"
rm -f "$STAGE/viewer/pdfjs/LICENSE.md" 2>/dev/null || true

# 2. Clean the manifest: no localhost anywhere.
python3 - "$STAGE/manifest.json" << 'PYEOF'
import json, sys
path = sys.argv[1]
m = json.load(open(path))
m["host_permissions"] = [h for h in m.get("host_permissions", []) if "localhost" not in h and "127.0.0.1" not in h]
if not m["host_permissions"]:
    del m["host_permissions"]
for cs in m.get("content_scripts", []):
    cs["matches"] = [x for x in cs["matches"] if "localhost" not in x and "127.0.0.1" not in x]
json.dump(m, open(path, "w"), indent=2)
print("manifest cleaned:", m.get("host_permissions", "no host_permissions"))
PYEOF

# 3. Build flag.
if [ "$BUILD" = "friends" ]; then
  echo '{"build":"friends"}' > "$STAGE/build.json"
fi

# 4. Sanity checks on the staged build.
if grep -rl "localhost:8000\|127.0.0.1:8000" "$STAGE" --include="*.json" | grep -q .; then
  echo "FAIL: localhost still referenced in staged manifest" >&2; exit 1
fi
for must in viewer/pdfjs/web/viewer.html offscreen/sound.html sidepanel/panel.html background.js; do
  [ -f "$STAGE/$must" ] || { echo "FAIL: $must missing from the staged build" >&2; exit 1; }
done
# Every file the code references by extension URL must exist in the stage.
for ref in $(grep -ohE '"(viewer|offscreen|sidepanel|popup|annotate|overlay)/[A-Za-z0-9_./-]+"' "$ROOT/background.js" "$ROOT/sidepanel/panel.js" "$ROOT/lib/"*.js | tr -d '"' | sort -u); do
  [ -e "$STAGE/$ref" ] || { echo "FAIL: code references $ref but it is not in the build" >&2; exit 1; }
done

# 5. Zip it.
mkdir -p "$DIST"
VERSION=$(python3 -c "import json; print(json.load(open('$STAGE/manifest.json'))['version'])")
SUFFIX=""; [ "$BUILD" = "friends" ] && SUFFIX="-friends"
OUT="$DIST/focus-agent-$VERSION$SUFFIX.zip"
rm -f "$OUT"
(cd "$STAGE" && zip -qr "$OUT" . -x ".DS_Store")
echo "packaged ($BUILD): $OUT"
echo "sha256: $(shasum -a 256 "$OUT" | cut -d' ' -f1)"
unzip -l "$OUT" | tail -1
