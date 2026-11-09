# Release 签名密钥指纹

> **仓库里只留这一份指纹。** keystore 本体与密码在 `D:/tcs-release-keys/`（仓库外），
> 绝不入库 —— 它们一旦被提交，等于把签名私钥公开，且 git 历史不可撤销。

## 当前密钥

| 项 | 值 |
|---|---|
| 生成时间 | 2026-10-30 |
| 算法 | RSA 4096 / PKCS12 (`SHA384withRSA`) |
| 别名（alias） | `tcs-release` |
| 有效期 | 10000 天（约 27 年，至 2054 年前后） |
| **SHA-256 指纹** | `97:F3:2D:F4:20:6D:2F:9B:CB:C2:E7:77:87:76:5D:80:10:84:A4:6D:70:D4:5A:21:DE:1D:B1:70:7A:8F:E9:A2` |
| DN | `CN=Tavern Card Studio, OU=Release, O=Tavern Card Studio, L=Chengdu, ST=Sichuan, C=CN` |

## 校验手上的包是不是这把密钥签的

```bash
# 出包环境（build-tools 里有 apksigner）
apksigner verify --print-certs app-release.apk | grep SHA-256

# 装到设备后复核
adb shell dumpsys package studio.taverncard.probe | grep -A2 signatures
```

**判据是"逐字相同"**，不是"看起来差不多"。指纹不符的包**不能发** ——
它装到已装旧版的用户机上会直接失败（Android 拒绝签名不一致的更新）。

## 为什么这一条不能省

Android 只认**同一把密钥**签名的新版本：

- 密钥丢了 / 过期了 ⇒ 已发布的 App **再也无法更新**，只能换包名重新上架，
  用户数据全部丢失；
- 打包时换了 keystore 或换了 alias ⇒ 升级链断裂，而这件事**只在发第二个版本时**
  才暴露，那时已经有一批用户装着旧包。

所以两件事都是硬要求：**指纹入库备查**，**密钥两处离线备份**
（`D:/tcs-release-keys/backup/` 一份，另一份必须拷到离线介质 —— 脚本替不了这一步）。

## 配套

- 生成 / 查看：`bash vendor/android-env/gen-release-keystore.sh [--show]`
- 打包前的完整验收清单：`docs/t15.3-apk-design.md` §7.5（5 条，含"连签两个版本能覆盖安装"）
