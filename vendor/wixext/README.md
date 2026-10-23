# WiX UI 扩展（入库的第三方二进制）

`WixToolset.UI.wixext.5.0.2.dll` —— 服务端 MSI 的向导界面靠它（`WixUI_InstallDir`
+ 自定义 `DeleteDataDlg`，见 `installer/Product.wxs`）。

**为什么入库而不是构建时下载。** 这是 v0.1.2（F14.1）明确要求的前提：
"离线环境能拿到扩展包"。构建机常常没有外网（本项目的打包机就没有稳定的
nuget 通路），而这一颗 DLL 只有 755 KiB。先例是 `vendor/winsw/WinSW.NET4.exe`：
同样入库、同样在 `build-msi.ps1` 里校验 sha256。

## 身份

| 项 | 值 |
| --- | --- |
| 扩展 | WiX Toolset UI Extension（`WixToolset.UI.wixext`） |
| 版本 | 5.0.2（必须与 `wix.exe` 的大版本一致，v5 的扩展不认 v4/v6） |
| 大小 | 773 392 字节 |
| sha256 | `5ce7f958b6a2b57bcb98c19615c5a3da46976a6e78a6af055fdef99e9e9e8f06` |
| 来源 | `https://www.nuget.org/api/v2/package/WixToolset.UI.wixext/5.0.2` |
| 许可证 | Microsoft Reciprocal License (MS-RL)，随 WiX Toolset 分发 |

`build-msi.ps1` 每次打包都校验上面这个 sha256；不符就拒绝出包 —— 否则
"我用的是哪个扩展"无法自证。

## 更新方法

```powershell
# 1. 取新包（离线机可先在有网机器上下好再拷进来）
curl -L -o WixToolset.UI.wixext.nupkg `
  https://www.nuget.org/api/v2/package/WixToolset.UI.wixext/5.0.2

# 2. 解压，取出 tools\<tfm>\any\ 下的 dll
Expand-Archive WixToolset.UI.wixext.nupkg -Destination .\ext

# 3. 按版本号命名后放进来，并更新本文件与 build-msi.ps1 里的 sha256
Copy-Item .\ext\wixext5\WixToolset.UI.wixext.dll .\vendor\wixext\WixToolset.UI.wixext.5.0.2.dll
```

`wix.exe` 本身仍不入库（100 MiB 级，见 `.tools/wix/` 与 `build-msi.ps1` 抬头）。
