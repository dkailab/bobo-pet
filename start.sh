#!/bin/bash
# 卜卜宠物 · 一键启动
cd "$(dirname "$0")"

echo "==> 1/4 检查依赖"
if [ ! -d node_modules/electron ]; then
  echo "    安装 Electron..."
  npm install || { echo "    ✗ npm install 失败，请检查网络后重试"; exit 1; }
fi

echo "==> 2/4 编译音频节拍助手"
if [ ! -f audio-helper ] || [ src/audio-helper.swift -nt audio-helper ]; then
  TMP_DIR="$(mktemp -d)"
  OK=0
  # 本机架构：完整 ScreenCaptureKit 助手
  if swiftc -O -o "$TMP_DIR/ah-arm64" src/audio-helper.swift -framework ScreenCaptureKit 2>/tmp/bobo_swift.log; then
    # x86_64 占位切片（零系统依赖，交叉编译兼容性最好；Intel 上自动降级纯歌名模式）
    printf '// x86_64 placeholder slice, exits immediately\n' > "$TMP_DIR/stub.swift"
    SDKPATH="$(xcrun --show-sdk-path 2>/dev/null)"
    if swiftc -O -target x86_64-apple-macos12.3 -sdk "$SDKPATH" "$TMP_DIR/stub.swift" -o "$TMP_DIR/ah-x64" 2>>/tmp/bobo_swift.log && lipo -create "$TMP_DIR/ah-arm64" "$TMP_DIR/ah-x64" -output audio-helper 2>>/tmp/bobo_swift.log; then
      OK=1
    else
      cp "$TMP_DIR/ah-arm64" audio-helper   # 退回本机架构单切片
      OK=1
    fi
  fi
  rm -rf "$TMP_DIR"
  if [ "$OK" = "1" ]; then
    chmod +x audio-helper
    echo "    编译成功（架构: $(lipo -archs audio-helper 2>/dev/null)）"
  else
    echo "    ⚠ 编译失败（可忽略，将使用纯歌名模式）: $(tail -1 /tmp/bobo_swift.log)"
  fi
fi

echo "==> 3/4 防误报处理（Gatekeeper）"
# 本地编译的未签名二进制会被 macOS 拦截为“无法验证开发者”。
# 去掉隔离属性 + 本地签名（ad-hoc）即可消除弹窗；audio-helper 和 Electron 都要处理。
if [ -f audio-helper ]; then
  xattr -dr com.apple.quarantine audio-helper 2>/dev/null
  codesign --force --sign - audio-helper 2>/dev/null
  echo "    audio-helper 已解除隔离并本地签名"
fi
if [ -d node_modules/electron/dist/Electron.app ]; then
  xattr -dr com.apple.quarantine node_modules/electron/dist/Electron.app 2>/dev/null
  codesign --force --deep --sign - node_modules/electron/dist/Electron.app 2>/dev/null
  echo "    Electron.app 已解除隔离并本地签名（消除“包含恶意软件”误报）"
fi

echo "==> 4/4 启动卜卜"
ELECTRON_BIN="./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "    ✗ 未找到 Electron 可执行文件，请重新执行 npm install"
  exit 1
fi
# 直接调用 Electron 二进制（绕开 node_modules/.bin 符号链接——zip 打包会把它解引用成普通文件导致 npm start 失败）
exec "$ELECTRON_BIN" .
