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
VERSION="1.0"

echo "==> building PSHNotch.swift"
swiftc -parse-as-library -swift-version 5 -O -o dist-build-PSHNotch PSHNotch.swift

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv dist-build-PSHNotch "$BIN"
chmod +x "$BIN"

# An icon only if one is genuinely there. SVG is not a bundle icon, so it is skipped
# rather than converted into something that would not draw.
ICON=""
for candidate in icon.icns AppIcon.icns ../../public/icon.icns; do
    if [ -f "$candidate" ]; then ICON="$candidate"; break; fi
done
if [ -z "$ICON" ]; then
    for candidate in icon.png ../../public/icon.png ../../public/favicon.png; do
        if [ -f "$candidate" ]; then
            if command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
                echo "==> converting $candidate to an icns"
                ICONSET="dist/AppIcon.iconset"
                rm -rf "$ICONSET"; mkdir -p "$ICONSET"
                for size in 16 32 64 128 256 512; do
                    sips -z "$size" "$size" "$candidate" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
                done
                iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" >/dev/null 2>&1 \
                    && ICON="AppIcon.icns"
                rm -rf "$ICONSET"
            fi
            break
        fi
    done
fi
if [ -n "$ICON" ]; then
    case "$ICON" in
        *.icns) [ -f "$APP/Contents/Resources/$ICON" ] || cp "$ICON" "$APP/Contents/Resources/AppIcon.icns" ;;
    esac
    ICON_ENTRY="  <key>CFBundleIconFile</key><string>AppIcon.icns</string>"
    echo "==> icon: $ICON"
else
    ICON_ENTRY=""
    echo "==> icon: none found, skipping (no icns or png in this folder or public/)"
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
# Two things in the window, not one: the app and a shortcut to Applications, so the install is a
# drag rather than an instruction someone has to read.
rm -rf dist/dmgroot
mkdir -p dist/dmgroot
cp -R "$APP" "dist/dmgroot/psh notch.app"
ln -s /Applications dist/dmgroot/Applications
rm -f "$DMG"
hdiutil create -quiet -volname "psh notch" -srcfolder dist/dmgroot -ov -format UDZO "$DMG"
rm -rf dist/dmgroot


# An older build sat in the same folder under the old name, and a stale copy next to the new
# one is how someone installs the version nobody rebuilt.
rm -rf dist/PSHNotch.app

echo "==> done"
ls -lh "$DMG" | awk '{print "    "$9" "$5}'
du -sh "$APP" | sed 's/^/    /'
