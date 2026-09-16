#!/bin/bash
# ============================================================
# 卜卜宠物 · macOS universal 一键打包脚本
# 规避了 electron-builder universal 的 SHA bug：
#   1) 分别构建 x64 / arm64 的 dir 包（用本地缓存的 electron）
#   2) electron-builder 会把项目根的单架构 audio-helper 拷进两架构包，
#      因此构建后为 x64 包替换为正确的 x86_64 helper
#   3) lipo 合并主程序 + helper 成 fat (x86_64+arm64)
#   4) adhoc 重签名，整包验证
#   5) 复制到 release/
# 用法：bash scripts/build-mac-universal.sh
# 注：最终打 dmg 需在非沙盒终端跑，见文件末尾提示。
# ============================================================
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
VERSION="${VERSION:-0.2.1}"
DMG="$ROOT/dist/卜卜宠物-${VERSION}-universal.dmg"

echo "========== 0. 校验语法 =========="
node --check main.js
node --check preload.js

echo "========== 1. 编译 x86_64 + arm64 helper =========="
swiftc -O -target x86_64-apple-macos13.0 -o /tmp/audio-helper-x64 "$ROOT/src/audio-helper.swift" -framework ScreenCaptureKit
swiftc -O -target arm64-apple-macos13.0 -o /tmp/audio-helper-arm64 "$ROOT/src/audio-helper.swift" -framework ScreenCaptureKit
echo "x86_64 + arm64 helper OK"

echo "========== 2. 构建 x64 dir 包 =========="
NODE_TLS_REJECT_UNAUTHORIZED=0 CSC_IDENTITY_AUTO_DISCOVERY=false ELECTRON_MIRROR="$MIRROR" \
  npx electron-builder --mac dir --x64 --publish never 2>&1 | tail -5

echo "========== 3. 构建 arm64 dir 包 =========="
NODE_TLS_REJECT_UNAUTHORIZED=0 CSC_IDENTITY_AUTO_DISCOVERY=false ELECTRON_MIRROR="$MIRROR" \
  npx electron-builder --mac dir --arm64 --publish never 2>&1 | tail -5

X64APP="$ROOT/dist/mac/卜卜宠物.app"
ARMAPP="$ROOT/dist/mac-arm64/卜卜宠物.app"

echo "========== 4. 替换 x64 app 内 helper 为正确 x86_64 =========="
cp /tmp/audio-helper-x64 "$X64APP/Contents/Resources/app.asar.unpacked/audio-helper"
codesign --force --deep --sign - "$X64APP/Contents/Resources/app.asar.unpacked/audio-helper" 2>&1 | tail -1
codesign --force --deep --sign - "$X64APP" 2>&1 | tail -1
codesign --verify --deep --strict "$X64APP" && echo "x64 app 签名 OK"

echo "========== 4b. 替换 arm64 app 内 helper 为正确 arm64 =========="
cp /tmp/audio-helper-arm64 "$ARMAPP/Contents/Resources/app.asar.unpacked/audio-helper"
codesign --force --deep --sign - "$ARMAPP/Contents/Resources/app.asar.unpacked/audio-helper" 2>&1 | tail -1
codesign --force --deep --sign - "$ARMAPP" 2>&1 | tail -1
codesign --verify --deep --strict "$ARMAPP" && echo "arm64 app 签名 OK"

echo "========== 5. 合并 universal（主程序 + helper）=========="
rm -rf "$ROOT/dist/mac-universal"
ditto "$ARMAPP" "$ROOT/dist/mac-universal/卜卜宠物.app"
lipo -create "$X64APP/Contents/MacOS/卜卜宠物" "$ARMAPP/Contents/MacOS/卜卜宠物" \
  -output "$ROOT/dist/mac-universal/卜卜宠物.app/Contents/MacOS/卜卜宠物"
lipo -create "$X64APP/Contents/Resources/app.asar.unpacked/audio-helper" \
  "$ARMAPP/Contents/Resources/app.asar.unpacked/audio-helper" \
  -output "$ROOT/dist/mac-universal/卜卜宠物.app/Contents/Resources/app.asar.unpacked/audio-helper"

echo "========== 6. 重签名 universal + 验证 =========="
codesign --force --deep --sign - --entitlements scripts/entitlements.mac.plist \
  "$ROOT/dist/mac-universal/卜卜宠物.app/Contents/Resources/app.asar.unpacked/audio-helper" 2>&1 | tail -1
codesign --force --deep --sign - "$ROOT/dist/mac-universal/卜卜宠物.app" 2>&1 | tail -1
codesign --verify --deep --strict "$ROOT/dist/mac-universal/卜卜宠物.app" && echo "universal 签名验证通过"

echo "========== 7. 架构确认 =========="
lipo -info "$ROOT/dist/mac-universal/卜卜宠物.app/Contents/MacOS/卜卜宠物"
lipo -info "$ROOT/dist/mac-universal/卜卜宠物.app/Contents/Resources/app.asar.unpacked/audio-helper"

echo "========== 8. 复制到 release/ =========="
mkdir -p "$ROOT/release"
rm -rf "$ROOT/release/卜卜宠物.app"
cp -R "$ROOT/dist/mac-universal/卜卜宠物.app" "$ROOT/release/卜卜宠物.app"
echo "✅ 完成：release/卜卜宠物.app"
echo ""
echo "── 打 dmg（需在非沙盒终端）──"
echo "cd \"$ROOT\" && rm -rf /tmp/bobo_dmg && mkdir -p /tmp/bobo_dmg && ln -s /Applications /tmp/bobo_dmg/Applications && cp -R release/卜卜宠物.app /tmp/bobo_dmg/卜卜宠物.app && hdiutil create -volname \"卜卜宠物 ${VERSION}\" -srcfolder /tmp/bobo_dmg -ov -format UDZO -imagekey zlib-level=9 \"$DMG\""