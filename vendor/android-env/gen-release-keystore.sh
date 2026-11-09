#!/usr/bin/env bash
#
# 生成 release 签名用的 keystore（T15.3 / T15.8）
#
# ## 为什么现在就生成，而不是"等要发版了再说"
#
# **debug 签名与 release 签名不兼容**：用 debug 签的 APK 装上之后，
# 换成 release 签名的新版本**装不上去**，只能先卸载 —— 而卸载会清掉
# `files/` 下的 ST 数据、角色卡与聊天记录。
#
# 所以"先用 debug 装着测试、以后再换 release"等于**给用户预约一次卸载重装**。
# 从第一个测试 APK 起就必须用同一套 release 签名。
#
# ## 三条纪律
#
# 1. **密码不落仓库**。生成时写进 `$KEY_DIR/keystore.properties`（在仓库外），
#    仓库里只有指纹（`RELEASE-KEY-FINGERPRINT.md`）。
# 2. **两处离线备份**。脚本在 `$KEY_DIR/backup/` 放一份，第二份需要人工拷到
#    离线介质（U 盘/网盘/纸质密码本）—— 这一步脚本替不了。
# 3. **指纹可核**。APK 签名与预期指纹不符 = 装上去会与旧版冲突，
#    发版前必须比对（`T15.8` 验收项）。
#
# ## keystore 丢了会怎样
#
# 已发布的 App **再也无法更新**（Android 只认同一把密钥签名的新版本）。
# 只能换包名重新上架，用户数据全丢。所以备份不是"最好有"，是**必需**。
#
# 用法：
#   bash gen-release-keystore.sh            # 生成
#   bash gen-release-keystore.sh --show     # 只打印现有指纹
#
set -euo pipefail

# keystore 放在**仓库外**：它一旦被提交，等于把签名私钥公开。
# 默认位置刻意与 android-env 分开 —— env 目录可能被打包/拷贝给别人。
KEY_DIR="${TCS_KEY_DIR:-D:/tcs-release-keys}"
STORE="$KEY_DIR/tcs-release.jks"
PROPS="$KEY_DIR/keystore.properties"
ALIAS="tcs-release"
JDK="${JAVA_HOME:-D:/android-env/jdk-17}"
KEYTOOL="$JDK/bin/keytool.exe"

[ -x "$KEYTOOL" ] || { echo "✘ 找不到 keytool：$KEYTOOL"; echo "  先跑 vendor/android-env/install-android-env-win.sh"; exit 1; }

if [ "${1:-}" = "--show" ]; then
  [ -f "$STORE" ] || { echo "✘ 还没有 keystore：$STORE"; exit 1; }
  PASS=$(sed -n 's/^storePassword=//p' "$PROPS")
  "$KEYTOOL" -list -v -keystore "$STORE" -storepass "$PASS" 2>/dev/null \
    | grep -E "Owner|Valid|SHA256:|Alias name" | sed 's/^/  /'
  exit 0
fi

if [ -f "$STORE" ]; then
  echo "keystore 已存在：$STORE"
  echo "（要重建请先自己备份并删除它 —— 重建会让已发布版本无法更新）"
  "${BASH_SOURCE[0]}" --show
  exit 0
fi

mkdir -p "$KEY_DIR/backup"

# 强密码：32 字符，大小写+数字，去掉容易看错的 0/O/1/l/I。
# 用 /dev/urandom 而不是 $RANDOM：后者在 bash 里只有 15 位熵且可预测。
PASS=$(head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' | head -c 32)

echo "== 生成 keystore：$STORE =="
# -keyalg RSA -keysize 4096：Android 支持的最小安全档（2048 也够，但 4096 无额外成本）
# -validity 10000：约 27 年。Android 要求发布密钥有效期覆盖 App 生命周期，
#                  过期后同样无法更新 —— 这一项不是"随便填"。
"$KEYTOOL" -genkeypair -v \
  -keystore "$STORE" \
  -storetype PKCS12 \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 \
  -validity 10000 \
  -storepass "$PASS" -keypass "$PASS" \
  -dname "CN=Tavern Card Studio, OU=Release, O=Tavern Card Studio, L=Chengdu, ST=Sichuan, C=CN" \
  2>&1 | sed 's/^/  /'

cat > "$PROPS" <<EOF
# 这个文件**绝不能进仓库**。它和 tcs-release.jks 是一对。
# 丢了密码 = keystore 作废 = 已发布版本无法更新。
storeFile=$STORE
storePassword=$PASS
keyAlias=$ALIAS
keyPassword=$PASS
EOF

# 备份一份到 backup/（第二份要人工拷到离线介质）
cp "$STORE" "$KEY_DIR/backup/tcs-release-$(date +%Y%m%d).jks"
cp "$PROPS" "$KEY_DIR/backup/keystore-$(date +%Y%m%d).properties"

echo
echo "== 指纹（仓库里只留这个）=="
FP=$("$KEYTOOL" -list -v -keystore "$STORE" -storepass "$PASS" 2>/dev/null | awk -F': ' '/SHA256:/{print $2; exit}')
echo "  SHA-256: $FP"
echo
echo "== 已生成 =="
echo "  keystore : $STORE"
echo "  密码      : $PROPS（仓库外）"
echo "  本地备份  : $KEY_DIR/backup/"
echo
echo "⚠ 还差一步（脚本替不了）：把 $KEY_DIR/backup/ 里的两份拷到**离线介质**"
echo "   （U 盘 / 网盘 / 密码本）。keystore 丢了，已发布版本就再也无法更新。"
