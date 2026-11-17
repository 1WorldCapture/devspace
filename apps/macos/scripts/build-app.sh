#!/usr/bin/env bash
# Builds DevSpace.app (Apple Silicon) from this checkout:
# downloads and verifies Node, packs DevSpace, installs its production
# dependencies with the bundled Node, builds the Swift menu bar app,
# assembles the bundle, and signs every Mach-O file with one identity.
#
# Environment:
#   DEVSPACE_CODESIGN_IDENTITY  codesign identity (name or SHA-1). Defaults to
#                               the first "Apple Development" identity. Use the
#                               same one for every build: macOS keys Screen
#                               Recording permission to the signature. "-"
#                               signs ad hoc (permission resets every build).
#   DEVSPACE_BUNDLE_ID          CFBundleIdentifier (default below).
#   DEVSPACE_APP_OUTPUT         Output directory (default apps/macos/build).
set -euo pipefail

NODE_VERSION="24.22.3"
NODE_SHA256="ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd"
NODE_DIST="node-v${NODE_VERSION}-darwin-arm64"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
OUTPUT="${DEVSPACE_APP_OUTPUT:-$APP_DIR/build}"
BUNDLE_ID="${DEVSPACE_BUNDLE_ID:-io.github.1worldcapture.devspace}"
CACHE="$OUTPUT/cache"
WORK="$OUTPUT/work"
APP="$OUTPUT/DevSpace.app"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "DevSpace.app can only be built on macOS."
[[ "$(uname -m)" == "arm64" ]] || die "Only Apple Silicon (arm64) builds are supported."

for tool in swift codesign curl shasum pnpm npm file; do
  command -v "$tool" >/dev/null || die "$tool is required."
done

identity="${DEVSPACE_CODESIGN_IDENTITY:-}"

if [[ -z "$identity" ]]; then
  identity="$(security find-identity -v -p codesigning | awk -F'"' '/"Apple Development:/ { print $2; exit }')"
  [[ -n "$identity" ]] || die "No Apple Development identity found; set DEVSPACE_CODESIGN_IDENTITY (\"-\" for ad hoc)."
fi

echo "Signing identity: $identity"

rm -rf "$WORK" "$APP"
mkdir -p "$CACHE" "$WORK"

log "Node $NODE_VERSION"
tarball="$CACHE/$NODE_DIST.tar.gz"

if [[ ! -f "$tarball" ]] || ! echo "$NODE_SHA256  $tarball" | shasum -a 256 -c --status; then
  curl -fL --retry 3 -o "$tarball.partial" "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.gz"
  mv "$tarball.partial" "$tarball"
fi

echo "$NODE_SHA256  $tarball" | shasum -a 256 -c --status || die "Node tarball checksum mismatch."
tar -xzf "$tarball" -C "$WORK"
NODE_HOME="$WORK/$NODE_DIST"

log "Building and packing DevSpace"
package_version="$("$NODE_HOME/bin/node" -p "require('$REPO_ROOT/package.json').version")"
package_file="waishnav-devspace-$package_version.tgz"
(cd "$REPO_ROOT" && pnpm build && npm pack --ignore-scripts --pack-destination "$WORK" >/dev/null)
[[ -f "$WORK/$package_file" ]] || die "npm pack did not produce $package_file."

log "Installing production dependencies with the bundled Node"
runtime="$WORK/devspace"
mkdir -p "$runtime"
printf '{ "name": "devspace-app-runtime", "private": true }\n' > "$runtime/package.json"
# The bundled Node goes first on PATH so install scripts (for example koffi's)
# build or select native modules for the Node ABI the app ships.
(cd "$runtime" && PATH="$NODE_HOME/bin:$PATH" npm_config_update_notifier=false \
  "$NODE_HOME/bin/npm" install --omit=dev --no-audit --no-fund "$WORK/$package_file")
[[ -f "$runtime/node_modules/@waishnav/devspace/dist/cli.js" ]] || die "Installed package has no dist/cli.js."

log "Building the menu bar app"
(cd "$APP_DIR" && swift build -c release --arch arm64)
binary="$(cd "$APP_DIR" && swift build -c release --arch arm64 --show-bin-path)/DevSpace"

log "Assembling $APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$binary" "$APP/Contents/MacOS/DevSpace"
cp "$NODE_HOME/bin/node" "$APP/Contents/MacOS/node"
cp "$NODE_HOME/LICENSE" "$APP/Contents/Resources/node-LICENSE"
mv "$runtime" "$APP/Contents/Resources/devspace"

build_number="$(git -C "$REPO_ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"
sed -e "s/__BUNDLE_IDENTIFIER__/$BUNDLE_ID/" \
    -e "s/__SHORT_VERSION__/$package_version/" \
    -e "s/__BUILD_VERSION__/$build_number/" \
    "$APP_DIR/Resources/Info.plist" > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

log "Signing"
sign() { codesign --force --timestamp=none --sign "$identity" "$@"; }

# Nested code first (native modules, bundled tools), then Node, then the
# bundle itself, which seals every resource. --deep is avoided on purpose.
nested=0

while IFS= read -r -d '' candidate; do
  if file -b "$candidate" | grep -q '^Mach-O'; then
    sign "$candidate"
    nested=$((nested + 1))
  fi
done < <(find "$APP/Contents/Resources" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print0)

echo "Signed $nested nested Mach-O files."
sign --identifier "$BUNDLE_ID.node" "$APP/Contents/MacOS/node"
sign --identifier "$BUNDLE_ID" "$APP"
codesign --verify --strict --deep "$APP"

rm -rf "$WORK"

log "Built $APP ($package_version, build $build_number, $(du -sh "$APP" | cut -f1))"
