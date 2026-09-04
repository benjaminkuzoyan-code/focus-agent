#!/bin/bash
# Build the Chrome Web Store zip: the extension minus every dev artifact.
# Strips: localhost host permission + content-script match, the demo adapter,
# the demo portal, the bridge server, and repo docs. Mock data STAYS — the
# "demo" data source doubles as the try-before-your-portal experience.
#
# Usage: bash scripts/package-store.sh   → dist/focus-agent-<version>.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# 1. Copy only what ships.
mkdir -p "$STAGE"
cp -R "$ROOT/adapters" "$ROOT/lib" "$ROOT/overlay" "$ROOT/annotate" \
      "$ROOT/sidepanel" "$ROOT/popup" "$ROOT/icons" \
      "$ROOT/content.js" "$ROOT/background.js" "$ROOT/manifest.json" "$STAGE/"

# 2. Remove dev-only files.
rm -f "$STAGE/adapters/demo.js"

# 3. Clean the manifest: drop localhost everywhere, drop the demo adapter.
python3 - "$STAGE/manifest.json" << 'PYEOF'
import json, sys
path = sys.argv[1]
m = json.load(open(path))

m["host_permissions"] = [h for h in m.get("host_permissions", []) if "localhost" not in h and "127.0.0.1" not in h]
if not m["host_permissions"]:
    del m["host_permissions"]

for cs in m.get("content_scripts", []):
    cs["matches"] = [x for x in cs["matches"] if "localhost" not in x]
    cs["js"] = [j for j in cs["js"] if j != "adapters/demo.js"]

json.dump(m, open(path, "w"), indent=2)
print("manifest cleaned:", m.get("host_permissions", "no host_permissions"), "|", len(m["content_scripts"][0]["js"]), "content scripts")
PYEOF

# 4. Sanity: no localhost/demo references anywhere in the staged build.
if grep -rl "localhost:8000\|127.0.0.1:8000" "$STAGE" --include="*.json" | grep -q .; then
  echo "FAIL: localhost still referenced in staged manifest" >&2; exit 1
fi

# NOTE: lib/ai.js still contains the bridge URL — harmless in the store
# build (the health check fails fast and MockCoach takes over), and it's
# what makes the local-brain dev setup work. When the hosted backend
# ships, BRIDGE points there instead.

# 5. Zip it.
mkdir -p "$DIST"
VERSION=$(python3 -c "import json; print(json.load(open('$STAGE/manifest.json'))['version'])")
OUT="$DIST/focus-agent-$VERSION.zip"
rm -f "$OUT"
(cd "$STAGE" && zip -qr "$OUT" .)
echo "packaged: $OUT"
unzip -l "$OUT" | tail -3
