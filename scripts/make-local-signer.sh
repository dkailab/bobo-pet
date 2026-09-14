#!/bin/bash
# 卜卜宠物 · 本地代码签名证书生成器（开发环境备用）
#
# 背景：macOS 的"屏幕与系统音频录制"权限按【App 的签名身份】记录。
# 若 App 用每次打包都变化的 adhoc(自签) 身份，"授权后仍反复弹窗"。
# 在没有 Apple 开发者证书时，可生成本地稳定证书作为签名身份，让权限能被记住。
#
# ⚠️ 此证书仅供开发自用，不能用于对外发布（正式发布需 Developer ID / Apple Development 证书）。
set -e

CERT_NAME="${1:-BoboLocalSigner}"
KEYCHAIN="${2:-login}"

echo "==> 需要的密码：将为您创建 $CERT_NAME 本地签名证书（保存到 $KEYCHAIN 钥匙串）"
echo "    本机架构: $(uname -m)"

cat > /tmp/bobo-cert-csr-$$.cnf <<EOF
[req]
distinguished_name = dn
req_extensions = reqext
prompt = no
[reqext]
keyUsage = digitalSignature
extendedKeyUsage = codeSigning
[dn]
CN = $CERT_NAME
O = Bobo Pet
EOF

echo "==> 1/4 生成密钥与证书请求"
openssl req -new -newkey rsa:2048 -nodes \
  -keyout /tmp/bobo-cert-$$.key \
  -out /tmp/bobo-cert-$$.csr \
  -config /tmp/bobo-cert-csr-$$.cnf 2>/dev/null

echo "==> 2/4 自签证书（含代码签名扩展）"
openssl x509 -req -in /tmp/bobo-cert-$$.csr \
  -signkey /tmp/bobo-cert-$$.key \
  -out /tmp/bobo-cert-$$.crt \
  -days 3650 \
  -extfile /tmp/bobo-cert-csr-$$.cnf -extensions reqext 2>/dev/null

echo "==> 3/4 导入钥匙串"
security import /tmp/bobo-cert-$$.crt -k "$HOME/Library/Keychains/$KEYCHAIN.keychain-db" -A 2>/dev/null \
  || security import /tmp/bobo-cert-$$.crt -A
security import /tmp/bobo-cert-$$.key -k "$HOME/Library/Keychains/$KEYCHAIN.keychain-db" -A 2>/dev/null \
  || security import /tmp/bobo-cert-$$.key -A

rm -f /tmp/bobo-cert-$$.key /tmp/bobo-cert-$$.csr /tmp/bobo-cert-$$.crt /tmp/bobo-cert-csr-$$.cnf

echo "==> 4/4 生成的签名身份可用性检查"
security find-identity -v -p codesigning 2>&1 | grep -i "$CERT_NAME" || echo "   （身份已导入，可用下方 identity 值）"

cat <<EOF

✅ 完成！本地证书 "$CERT_NAME" 已就绪。
打包时指定身份：  CSC_NAME="$CERT_NAME" npm run dist:mac
EOF