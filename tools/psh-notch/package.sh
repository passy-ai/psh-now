#!/bin/sh
# Build "psh notch.app" and psh-notch.dmg for handing to someone else.
#
# The bundle is named the way it should read in Spotlight, Raycast and Login Items. The
# executable inside it stays PSHNotch, which is what CFBundleExecutable points at.
#
# Everything is written under dist/ and previous output is removed first, so this is
# safe to re-run. The app is signed ad hoc: without a Developer ID it cannot be
# notarised, so a downloaded copy needs one "Open" from the right-click menu. See the
# README section "The dmg, and the one warning".
set -eu
cd "$(dirname "$0")"

APP="dist/psh notch.app"
DMG="dist/psh-notch.dmg"
BIN="$APP/Contents/MacOS/PSHNotch"
# The version the app reports (and what the update check compares). The workflow sets it
# from the tag; a laptop build falls back to the newest notch tag, then 1.0.
VERSION="${PSH_NOTCH_VERSION:-$(git describe --tags --match 'v*-notch' --abbrev=0 2>/dev/null || true)}"
# Accept whatever a tag or an env hands us: v1.2.0-notch, 1.2.0-notch, v1.2.0.
VERSION="${VERSION#v}"
VERSION="${VERSION%-notch}"
VERSION="${VERSION:-1.0}"

echo "==> building PSHNotch.swift"
swiftc -parse-as-library -swift-version 5 -O -o dist-build-PSHNotch PSHNotch.swift

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv dist-build-PSHNotch "$BIN"
chmod +x "$BIN"

# The icon is the idle notch on a white plate, drawn by make-icon.swift, so the thing in
# the dmg window is recognisable as this app. An icon.icns next to the source wins.
ICON=""
for candidate in icon.icns AppIcon.icns; do
    if [ -f "$candidate" ]; then ICON="$candidate"; break; fi
done
if [ -z "$ICON" ]; then
    echo "==> drawing the app icon"
    swiftc -O -o dist-build-mkicon make-icon.swift 2>&1 | sed 's/^/    /'
    ./dist-build-mkicon dist/icon-1024.png | sed 's/^/    /'
    rm -f dist-build-mkicon
    if command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
        ICONSET="dist/AppIcon.iconset"
        rm -rf "$ICONSET"; mkdir -p "$ICONSET"
        for size in 16 32 64 128 256 512; do
            sips -z "$size" "$size" dist/icon-1024.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
        done
        sips -z 1024 1024 dist/icon-1024.png --out "$ICONSET/icon_512x512@2x.png" >/dev/null
        iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" >/dev/null 2>&1 \
            && ICON="AppIcon.icns"
        rm -rf "$ICONSET"
    fi
fi
if [ -n "$ICON" ]; then
    case "$ICON" in
        *.icns) [ -f "$APP/Contents/Resources/$ICON" ] || cp "$ICON" "$APP/Contents/Resources/AppIcon.icns" ;;
    esac
    ICON_ENTRY="  <key>CFBundleIconFile</key><string>AppIcon.icns</string>"
    echo "==> icon: $ICON"
else
    ICON_ENTRY=""
    echo "==> icon: none"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.psh.notch</string>
  <key>CFBundleName</key><string>psh notch</string>
  <key>CFBundleDisplayName</key><string>psh notch</string>
  <key>CFBundleExecutable</key><string>PSHNotch</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <!-- The dashboard hands the device token over with this scheme. It only exists in the
       bundle: a bare binary run from a terminal has no URL scheme, which is why --pair and
       --handle-url exist. -->
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>dev.psh.notch.connect</string>
    <key>CFBundleURLSchemes</key><array><string>psh-notch</string></array>
  </dict></array>
$ICON_ENTRY
</dict></plist>
PLIST

echo "==> signing ad hoc"
codesign --force --sign - --timestamp=none "$APP" 2>&1 | sed 's/^/    /'
codesign --verify --strict "$APP"

echo "==> writing $DMG"
# Two icons, not one: the app and a shortcut to Applications, so the install is a drag
# rather than an instruction someone has to read. No background image on purpose - see
# dmg-settings.py. A painted plate cannot know whether the person opening it uses light or
# dark mode, and the answer is one of the two, so leaving it to Finder is what makes the
# window look like a Finder window instead of a coloured slab.
rm -f "$DMG"
# dmgbuild writes the .DS_Store and the icon layout itself. Finder automation would do the
# same thing, but macOS refuses to grant a build shell permission to drive Finder, and a build
# must not depend on that grant.
if ! python3 -c "import dmgbuild" >/dev/null 2>&1; then
    echo "==> preparing dmgbuild (one-time)"
    python3 -m venv dist/.dmgvenv >/dev/null 2>&1 || true
    dist/.dmgvenv/bin/pip install --quiet dmgbuild >/dev/null 2>&1 || true
fi
PYBUILD=""
if python3 -c "import dmgbuild" >/dev/null 2>&1; then PYBUILD=python3
elif [ -x dist/.dmgvenv/bin/python ] && dist/.dmgvenv/bin/python -c "import dmgbuild" >/dev/null 2>&1; then PYBUILD=dist/.dmgvenv/bin/python
fi

if [ -n "$PYBUILD" ]; then
    "$PYBUILD" -m dmgbuild -s dmg-settings.py -D app="$APP" "psh notch" "$DMG" 2>&1 | sed 's/^/    /'
fi
if [ ! -f "$DMG" ]; then
    echo "    dmgbuild unavailable, falling back to a plain window"
    rm -rf dist/dmgroot
    mkdir -p dist/dmgroot
    cp -R "$APP" "dist/dmgroot/psh notch.app"
    ln -s /Applications dist/dmgroot/Applications
    hdiutil create -quiet -volname "psh notch" -srcfolder dist/dmgroot -ov -format UDZO "$DMG"
    rm -rf dist/dmgroot
fi
# An older build sat in the same folder under the old name, and a stale copy next to the new
# one is how someone installs the version nobody rebuilt.
rm -rf dist/PSHNotch.app

echo "==> done"
ls -lh "$DMG" | awk '{print "    "$9" "$5}'
du -sh "$APP" | sed 's/^/    /'
