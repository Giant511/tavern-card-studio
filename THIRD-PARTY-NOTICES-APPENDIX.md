# 第三方组件清单（附录）

本文件由 `node .verify/gen-third-party-appendix.mjs` 生成，**请勿手工编辑** —— 改了会在下次生成时被覆盖。

义务说明与合规立场见主文件 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)；许可全文在 [`LICENSES/`](LICENSES/)。

生成时间：2026-11-18T07:37:00.712Z

---

## 摘要

| 范围 | 组件数 |
| --- | --- |
| 直接嵌入分发物 | 5 |
| Node 开发依赖 | 175 |
| Node 随 MSI 分发 | 99 |
| Rust crate | 497 |

**强 copyleft（GPL/AGPL）在依赖树中的数量：0。**
唯一的 AGPL 组件是直接嵌入的 SillyTavern，见 §A；唯一的弱 copyleft 是 §D 的 MPL-2.0 × 5。

---

## A. 直接嵌入分发物的组件

这些组件的内容**原样进入了安装包**，不属于"依赖库"范畴。

### SillyTavern 1.19.0

| 项 | 内容 |
| --- | --- |
| 许可 | **AGPL-3.0** |
| 版权 | Copyright (C) SillyTavern contributors |
| 用途 | 安卓端内置的聊天引擎，打包进 APK 的 assets/st.zip（未修改原样分发） |
| 出现位置 | APK：assets/st.zip（21,034 个文件） |
| 上游 | https://github.com/SillyTavern/SillyTavern |
| 说明 | AGPL-3.0 §5/§6：分发目标代码时须提供对应源码。本仓库未修改其源码，对应源码即上游 tag 1.19.0。 |

### Node.js 22.22.2

| 项 | 内容 |
| --- | --- |
| 许可 | **MIT** |
| 版权 | Copyright Node.js contributors. All rights reserved. |
| 用途 | 服务端二进制运行时；安卓端 Node VM 宿主 |
| 出现位置 | MSI：release/server/node.exe（87 MB）；APK：vendor/node-android/bin/libnode-arm64-20.18.0.so |
| 上游 | https://github.com/nodejs/node |
| 说明 | MIT 要求随分发保留版权与许可声明 —— 此前产物里没有，本轮补上。 |

### libc++（LLVM） 随 Node.js Android 构建

| 项 | 内容 |
| --- | --- |
| 许可 | **Apache-2.0 WITH LLVM-exception** |
| 版权 | Copyright (C) LLVM Project |
| 用途 | 安卓端 Node 的 C++ 运行库 |
| 出现位置 | APK：vendor/node-android/bin/libc++_shared-arm64.so |
| 上游 | https://github.com/llvm/llvm-project |
| 说明 | Apache-2.0 要求保留 NOTICE 与许可声明。 |

### WinSW 2.12.0

| 项 | 内容 |
| --- | --- |
| 许可 | **MIT** |
| 版权 | Copyright (C) WinSW contributors |
| 用途 | 把服务端注册成 Windows 服务 |
| 出现位置 | MSI：vendor/winsw/WinSW.NET4.exe |
| 上游 | https://github.com/winsw/winsw |

### WiX Toolset（UI 扩展） 5.0.2

| 项 | 内容 |
| --- | --- |
| 许可 | **MS-RL** |
| 版权 | Copyright (C) .NET Foundation and contributors |
| 用途 | 仅构建期被 WiX 加载以生成 MSI 向导界面，不进 MSI 产物 |
| 出现位置 | 构建期：vendor/wixext/WixToolset.UI.wixext.dll |
| 上游 | https://github.com/wixtoolset/wix |
| 说明 | 文件级 copyleft；不随产品分发，reciprocal 义务不触发。 |

---

## B. Node 依赖（随 MSI 分发）

这 99 个包的实际文件会进入服务端安装包，
因此它们的版权声明必须随包提供（MIT/Apache-2.0 均如此要求）。

协议分布：

- MIT —— 80 个
- ISC —— 6 个
- Apache-2.0 —— 5 个
- BSD-3-Clause —— 2 个
- (未声明) —— 1 个
- (MIT OR WTFPL) —— 1 个
- (MIT AND Zlib) —— 1 个
- (BSD-2-Clause OR MIT OR Apache-2.0) —— 1 个
- (MIT AND BSD-3-Clause) —— 1 个
- 0BSD —— 1 个

| 组件 | 版本 | 许可 | 源码/主页 |
| --- | --- | --- | --- |
| `@node-rs/argon2` | 2.2.2 | MIT | github.com/napi-rs/node-rs |
| `@node-rs/argon2-win32-x64-msvc` | 2.2.2 | MIT | github.com/napi-rs/node-rs |
| `@peculiar/asn1-cms` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-csr` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-ecc` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-pfx` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-pkcs8` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-pkcs9` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-rsa` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-schema` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-x509` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-x509-attr` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/utils` | 2.0.3 | MIT | github.com/PeculiarVentures/pvtsutils |
| `@peculiar/x509` | 1.12.3 | MIT | github.com/PeculiarVentures/x509 |
| `@tcs/shared` | 0.1.10 | (未声明) |  |
| `abort-controller` | 3.0.0 | MIT | github.com/mysticatea/abort-controller |
| `asn1js` | 3.1.0 | BSD-3-Clause | github.com/PeculiarVentures/ASN1.js |
| `async-lock` | 1.4.1 | MIT | github.com/rogierschouten/async-lock |
| `available-typed-arrays` | 1.0.7 | MIT | github.com/inspect-js/available-typed-arrays |
| `base64-js` | 1.5.1 | MIT | github.com/beatgammit/base64-js |
| `better-sqlite3` | 11.10.0 | MIT | github.com/WiseLibs/better-sqlite3 |
| `bindings` | 1.5.0 | MIT | github.com/TooTallNate/node-bindings |
| `bl` | 4.1.0 | MIT | github.com/rvagg/bl |
| `buffer` | 6.0.3 | MIT | github.com/feross/buffer |
| `call-bind` | 1.0.9 | MIT | github.com/ljharb/call-bind |
| `call-bind-apply-helpers` | 1.0.2 | MIT | github.com/ljharb/call-bind-apply-helpers |
| `call-bound` | 1.0.4 | MIT | github.com/ljharb/call-bound |
| `chownr` | 1.1.4 | ISC | github.com/isaacs/chownr |
| `clean-git-ref` | 2.0.1 | Apache-2.0 | github.com/TheSavior/clean-git-ref |
| `crc-32` | 1.2.2 | Apache-2.0 | github.com/SheetJS/js-crc32 |
| `decompress-response` | 6.0.0 | MIT | sindresorhus/decompress-response |
| `deep-extend` | 0.6.0 | MIT | github.com/unclechu/node-deep-extend |
| `define-data-property` | 1.1.4 | MIT | github.com/ljharb/define-data-property |
| `detect-libc` | 2.1.2 | Apache-2.0 | github.com/lovell/detect-libc |
| `diff3` | 0.0.3 | MIT | github.com/axosoft/diff3 |
| `dunder-proto` | 1.0.1 | MIT | github.com/es-shims/dunder-proto |
| `end-of-stream` | 1.4.5 | MIT | github.com/mafintosh/end-of-stream |
| `es-define-property` | 1.0.1 | MIT | github.com/ljharb/es-define-property |
| `es-errors` | 1.3.0 | MIT | github.com/ljharb/es-errors |
| `es-object-atoms` | 1.1.2 | MIT | github.com/ljharb/es-object-atoms |
| `event-target-shim` | 5.0.1 | MIT | github.com/mysticatea/event-target-shim |
| `events` | 3.3.0 | MIT | github.com/Gozala/events |
| `expand-template` | 2.0.3 | (MIT OR WTFPL) | github.com/ralphtheninja/expand-template |
| `file-uri-to-path` | 1.0.0 | MIT | github.com/TooTallNate/file-uri-to-path |
| `for-each` | 0.3.5 | MIT | github.com/Raynos/for-each |
| `fs-constants` | 1.0.0 | MIT | github.com/mafintosh/fs-constants |
| `function-bind` | 1.1.2 | MIT | github.com/Raynos/function-bind |
| `get-intrinsic` | 1.3.0 | MIT | github.com/ljharb/get-intrinsic |
| `get-proto` | 1.0.1 | MIT | github.com/ljharb/get-proto |
| `github-from-package` | 0.0.0 | MIT | github.com/substack/github-from-package |
| `gopd` | 1.2.0 | MIT | github.com/ljharb/gopd |
| `has-property-descriptors` | 1.0.2 | MIT | github.com/inspect-js/has-property-descriptors |
| `has-symbols` | 1.1.0 | MIT | github.com/inspect-js/has-symbols |
| `has-tostringtag` | 1.0.2 | MIT | github.com/inspect-js/has-tostringtag |
| `hasown` | 2.0.4 | MIT | github.com/inspect-js/hasOwn |
| `ieee754` | 1.2.1 | BSD-3-Clause | github.com/feross/ieee754 |
| `ignore` | 5.3.2 | MIT | git@github.com:kaelzhang/node-ignore |
| `inherits` | 2.0.4 | ISC | github.com/isaacs/inherits |
| `ini` | 1.3.8 | ISC | github.com/isaacs/ini |
| `is-callable` | 1.2.7 | MIT | github.com/inspect-js/is-callable |
| `is-typed-array` | 1.1.15 | MIT | github.com/inspect-js/is-typed-array |
| `isarray` | 2.0.5 | MIT | github.com/juliangruber/isarray |
| `isomorphic-git` | 1.44.3 | MIT | github.com/isomorphic-git/isomorphic-git |
| `math-intrinsics` | 1.1.0 | MIT | github.com/es-shims/math-intrinsics |
| `mimic-response` | 3.1.0 | MIT | sindresorhus/mimic-response |
| `minimist` | 1.2.8 | MIT | github.com/minimistjs/minimist |
| `minimisted` | 2.0.1 | MIT | github.com/kt3k/minimisted |
| `mkdirp-classic` | 0.5.3 | MIT | github.com/mafintosh/mkdirp-classic |
| `napi-build-utils` | 2.0.0 | MIT | github.com/inspiredware/napi-build-utils |
| `node-abi` | 3.99.0 | MIT | github.com/electron/node-abi |
| `once` | 1.4.0 | ISC | github.com/isaacs/once |
| `pako` | 1.0.11 | (MIT AND Zlib) | nodeca/pako |
| `pify` | 4.0.1 | MIT | sindresorhus/pify |
| `possible-typed-array-names` | 1.1.0 | MIT | github.com/ljharb/possible-typed-array-names |
| `prebuild-install` | 7.1.3 | MIT | github.com/prebuild/prebuild-install |
| `process` | 0.11.10 | MIT | github.com/shtylman/node-process |
| `pump` | 3.0.4 | MIT | github.com/mafintosh/pump |
| `pvtsutils` | 1.3.6 | MIT | github.com/PeculiarVentures/pvtsutils |
| `pvutils` | 1.2.0 | MIT | github.com/PeculiarVentures/pvutils |
| `rc` | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) | github.com/dominictarr/rc |
| `readable-stream` | 4.8.0 | MIT | github.com/nodejs/readable-stream |
| `reflect-metadata` | 0.2.2 | Apache-2.0 | github.com/rbuckton/reflect-metadata |
| `safe-buffer` | 5.2.1 | MIT | github.com/feross/safe-buffer |
| `semver` | 7.8.5 | ISC | github.com/npm/node-semver |
| `set-function-length` | 1.2.2 | MIT | github.com/ljharb/set-function-length |
| `sha.js` | 2.4.12 | (MIT AND BSD-3-Clause) | github.com/crypto-browserify/sha.js |
| `simple-concat` | 1.0.1 | MIT | github.com/feross/simple-concat |
| `simple-get` | 4.0.1 | MIT | github.com/feross/simple-get |
| `string_decoder` | 1.3.0 | MIT | github.com/nodejs/string_decoder |
| `strip-json-comments` | 2.0.1 | MIT | sindresorhus/strip-json-comments |
| `tar-fs` | 2.1.5 | MIT | github.com/mafintosh/tar-fs |
| `tar-stream` | 2.2.0 | MIT | github.com/mafintosh/tar-stream |
| `to-buffer` | 1.2.2 | MIT | github.com/browserify/to-buffer |
| `tslib` | 2.8.1 | 0BSD | github.com/Microsoft/tslib |
| `tsyringe` | 4.10.0 | MIT | github.com/Microsoft/tsyringe |
| `tunnel-agent` | 0.6.0 | Apache-2.0 | github.com/mikeal/tunnel-agent |
| `typed-array-buffer` | 1.0.3 | MIT | github.com/inspect-js/typed-array-buffer |
| `which-typed-array` | 1.1.24 | MIT | github.com/inspect-js/which-typed-array |
| `wrappy` | 1.0.2 | ISC | github.com/npm/wrappy |

---

## C. Node 开发依赖（不随产品分发）

仅用于构建与测试。列在这里是为了让审查者能确认"没有 copyleft 混进来"，
而不是因为分发义务。

| 组件 | 版本 | 许可 | 源码/主页 |
| --- | --- | --- | --- |
| `@codemirror/commands` | 6.11.1 | MIT | code.haverbeke.berlin/codemirror/commands |
| `@codemirror/language` | 6.13.1 | MIT | code.haverbeke.berlin/codemirror/language |
| `@codemirror/state` | 6.7.6 | MIT | code.haverbeke.berlin/codemirror/state |
| `@codemirror/streamparser` | 6.0.0 | MIT | code.haverbeke.berlin/codemirror/streamparser |
| `@codemirror/view` | 6.43.15 | MIT | code.haverbeke.berlin/codemirror/view |
| `@esbuild/win32-x64` | 0.25.12 | MIT | github.com/evanw/esbuild |
| `@lezer/common` | 1.5.3 | MIT | code.haverbeke.berlin/lezer/common |
| `@lezer/highlight` | 1.2.5 | MIT | code.haverbeke.berlin/lezer/highlight |
| `@lezer/lr` | 1.4.11 | MIT | code.haverbeke.berlin/lezer/lr |
| `@marijn/find-cluster-break` | 1.0.4 | MIT | code.haverbeke.berlin/marijn/find-cluster-break |
| `@node-rs/argon2` | 2.2.2 | MIT | github.com/napi-rs/node-rs |
| `@node-rs/argon2-win32-x64-msvc` | 2.2.2 | MIT | github.com/napi-rs/node-rs |
| `@peculiar/asn1-cms` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-csr` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-ecc` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-pfx` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-pkcs8` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-pkcs9` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-rsa` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-schema` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-x509` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/asn1-x509-attr` | 2.11.0 | MIT | github.com/PeculiarVentures/asn1-schema |
| `@peculiar/utils` | 2.0.3 | MIT | github.com/PeculiarVentures/pvtsutils |
| `@peculiar/x509` | 1.12.3 | MIT | github.com/PeculiarVentures/x509 |
| `@rollup/rollup-win32-x64-gnu` | 4.64.12 | MIT | github.com/rollup/rollup |
| `@rollup/rollup-win32-x64-msvc` | 4.64.12 | MIT | github.com/rollup/rollup |
| `@tauri-apps/api` | 2.12.4 | Apache-2.0 OR MIT | github.com/tauri-apps/tauri |
| `@tauri-apps/cli` | 2.12.3 | Apache-2.0 OR MIT | github.com/tauri-apps/tauri |
| `@tauri-apps/cli-win32-x64-msvc` | 2.12.3 | Apache-2.0 OR MIT | github.com/tauri-apps/tauri |
| `@tauri-apps/plugin-dialog` | 2.8.3 | MIT OR Apache-2.0 | github.com/tauri-apps/plugins-workspace |
| `@tauri-apps/plugin-fs` | 2.7.1 | MIT OR Apache-2.0 | github.com/tauri-apps/plugins-workspace |
| `@tauri-apps/plugin-log` | 2.10.1 | MIT OR Apache-2.0 | github.com/tauri-apps/plugins-workspace |
| `@tauri-apps/plugin-opener` | 2.7.2 | MIT OR Apache-2.0 | github.com/tauri-apps/plugins-workspace |
| `@tauri-apps/plugin-store` | 2.5.0 | MIT OR Apache-2.0 | github.com/tauri-apps/plugins-workspace |
| `@types/better-sqlite3` | 7.6.13 | MIT | github.com/DefinitelyTyped/DefinitelyTyped |
| `@types/estree` | 1.0.9 | MIT | github.com/DefinitelyTyped/DefinitelyTyped |
| `@types/node` | 22.20.5 | MIT | github.com/DefinitelyTyped/DefinitelyTyped |
| `abort-controller` | 3.0.0 | MIT | github.com/mysticatea/abort-controller |
| `ajv` | 8.20.0 | MIT | ajv-validator/ajv |
| `ansi-regex` | 5.0.1 | MIT | chalk/ansi-regex |
| `ansi-styles` | 4.3.0 | MIT | chalk/ansi-styles |
| `asn1js` | 3.1.0 | BSD-3-Clause | github.com/PeculiarVentures/ASN1.js |
| `async-lock` | 1.4.1 | MIT | github.com/rogierschouten/async-lock |
| `available-typed-arrays` | 1.0.7 | MIT | github.com/inspect-js/available-typed-arrays |
| `b4a` | 1.9.0 | Apache-2.0 | github.com/holepunchto/b4a |
| `bare-events` | 2.9.2 | Apache-2.0 | github.com/holepunchto/bare-events |
| `bare-stream` | 2.13.4 | Apache-2.0 | github.com/holepunchto/bare-stream |
| `base64-js` | 1.5.1 | MIT | github.com/beatgammit/base64-js |
| `better-sqlite3` | 11.10.0 | MIT | github.com/WiseLibs/better-sqlite3 |
| `bindings` | 1.5.0 | MIT | github.com/TooTallNate/node-bindings |
| `bl` | 4.1.0 | MIT | github.com/rvagg/bl |
| `buffer` | 6.0.3 | MIT | github.com/feross/buffer |
| `buffer-crc32` | 0.2.13 | MIT | github.com/brianloveswords/buffer-crc32 |
| `call-bind` | 1.0.9 | MIT | github.com/ljharb/call-bind |
| `call-bind-apply-helpers` | 1.0.2 | MIT | github.com/ljharb/call-bind-apply-helpers |
| `call-bound` | 1.0.4 | MIT | github.com/ljharb/call-bound |
| `chownr` | 1.1.4 | ISC | github.com/isaacs/chownr |
| `clean-git-ref` | 2.0.1 | Apache-2.0 | github.com/TheSavior/clean-git-ref |
| `cliui` | 8.0.1 | ISC | yargs/cliui |
| `color-convert` | 2.0.1 | MIT | Qix-/color-convert |
| `color-name` | 1.1.4 | MIT | git@github.com:colorjs/color-name |
| `crc-32` | 1.2.2 | Apache-2.0 | github.com/SheetJS/js-crc32 |
| `crelt` | 1.0.7 | MIT | code.haverbeke.berlin/marijn/crelt |
| `debug` | 4.4.3 | MIT | github.com/debug-js/debug |
| `decompress-response` | 6.0.0 | MIT | sindresorhus/decompress-response |
| `deep-extend` | 0.6.0 | MIT | github.com/unclechu/node-deep-extend |
| `define-data-property` | 1.1.4 | MIT | github.com/ljharb/define-data-property |
| `detect-libc` | 2.1.2 | Apache-2.0 | github.com/lovell/detect-libc |
| `diff3` | 0.0.3 | MIT | github.com/axosoft/diff3 |
| `dunder-proto` | 1.0.1 | MIT | github.com/es-shims/dunder-proto |
| `emoji-regex` | 8.0.0 | MIT | github.com/mathiasbynens/emoji-regex |
| `end-of-stream` | 1.4.5 | MIT | github.com/mafintosh/end-of-stream |
| `es-define-property` | 1.0.1 | MIT | github.com/ljharb/es-define-property |
| `es-errors` | 1.3.0 | MIT | github.com/ljharb/es-errors |
| `es-object-atoms` | 1.1.2 | MIT | github.com/ljharb/es-object-atoms |
| `esbuild` | 0.25.12 | MIT | github.com/evanw/esbuild |
| `escalade` | 3.2.0 | MIT | lukeed/escalade |
| `estraverse` | 5.3.0 | BSD-2-Clause | github.com/estools/estraverse |
| `esutils` | 2.0.3 | BSD-2-Clause | github.com/estools/esutils |
| `event-target-shim` | 5.0.1 | MIT | github.com/mysticatea/event-target-shim |
| `events` | 3.3.0 | MIT | github.com/Gozala/events |
| `events-universal` | 1.0.1 | Apache-2.0 | github.com/holepunchto/events-universal |
| `expand-template` | 2.0.3 | (MIT OR WTFPL) | github.com/ralphtheninja/expand-template |
| `fast-deep-equal` | 3.1.3 | MIT | github.com/epoberezkin/fast-deep-equal |
| `fast-fifo` | 1.3.2 | MIT | github.com/mafintosh/fast-fifo |
| `fast-uri` | 3.1.9 | BSD-3-Clause | github.com/fastify/fast-uri |
| `fd-slicer` | 1.1.0 | MIT | github.com/andrewrk/node-fd-slicer |
| `fdir` | 6.5.0 | MIT | github.com/thecodrr/fdir |
| `file-uri-to-path` | 1.0.0 | MIT | github.com/TooTallNate/file-uri-to-path |
| `for-each` | 0.3.5 | MIT | github.com/Raynos/for-each |
| `fs-constants` | 1.0.0 | MIT | github.com/mafintosh/fs-constants |
| `function-bind` | 1.1.2 | MIT | github.com/Raynos/function-bind |
| `get-caller-file` | 2.0.5 | ISC | github.com/stefanpenner/get-caller-file |
| `get-intrinsic` | 1.3.0 | MIT | github.com/ljharb/get-intrinsic |
| `get-proto` | 1.0.1 | MIT | github.com/ljharb/get-proto |
| `github-from-package` | 0.0.0 | MIT | github.com/substack/github-from-package |
| `gopd` | 1.2.0 | MIT | github.com/ljharb/gopd |
| `has-property-descriptors` | 1.0.2 | MIT | github.com/inspect-js/has-property-descriptors |
| `has-symbols` | 1.1.0 | MIT | github.com/inspect-js/has-symbols |
| `has-tostringtag` | 1.0.2 | MIT | github.com/inspect-js/has-tostringtag |
| `hasown` | 2.0.4 | MIT | github.com/inspect-js/hasOwn |
| `ieee754` | 1.2.1 | BSD-3-Clause | github.com/feross/ieee754 |
| `ignore` | 5.3.2 | MIT | git@github.com:kaelzhang/node-ignore |
| `inherits` | 2.0.4 | ISC | github.com/isaacs/inherits |
| `ini` | 1.3.8 | ISC | github.com/isaacs/ini |
| `ip-address` | 10.7.4 | MIT | github.com/beaugunderson/ip-address |
| `is-callable` | 1.2.7 | MIT | github.com/inspect-js/is-callable |
| `is-typed-array` | 1.1.15 | MIT | github.com/inspect-js/is-typed-array |
| `isarray` | 2.0.5 | MIT | github.com/juliangruber/isarray |
| `isomorphic-git` | 1.44.3 | MIT | github.com/isomorphic-git/isomorphic-git |
| `json-schema-traverse` | 1.0.0 | MIT | github.com/epoberezkin/json-schema-traverse |
| `math-intrinsics` | 1.1.0 | MIT | github.com/es-shims/math-intrinsics |
| `mimic-response` | 3.1.0 | MIT | sindresorhus/mimic-response |
| `minimist` | 1.2.8 | MIT | github.com/minimistjs/minimist |
| `minimisted` | 2.0.1 | MIT | github.com/kt3k/minimisted |
| `mkdirp-classic` | 0.5.3 | MIT | github.com/mafintosh/mkdirp-classic |
| `ms` | 2.1.3 | MIT | vercel/ms |
| `nanoid` | 3.3.20 | MIT | ai/nanoid |
| `napi-build-utils` | 2.0.0 | MIT | github.com/inspiredware/napi-build-utils |
| `netmask` | 2.1.1 | MIT | github.com/rs/node-netmask |
| `node-abi` | 3.99.0 | MIT | github.com/electron/node-abi |
| `once` | 1.4.0 | ISC | github.com/isaacs/once |
| `pako` | 1.0.11 | (MIT AND Zlib) | nodeca/pako |
| `pend` | 1.2.0 | MIT | github.com/andrewrk/node-pend |
| `picocolors` | 1.1.1 | ISC | alexeyraspopov/picocolors |
| `picomatch` | 4.0.7 | MIT | micromatch/picomatch |
| `pify` | 4.0.1 | MIT | sindresorhus/pify |
| `possible-typed-array-names` | 1.1.0 | MIT | github.com/ljharb/possible-typed-array-names |
| `postcss` | 8.5.31 | MIT | postcss/postcss |
| `prebuild-install` | 7.1.3 | MIT | github.com/prebuild/prebuild-install |
| `process` | 0.11.10 | MIT | github.com/shtylman/node-process |
| `pump` | 3.0.4 | MIT | github.com/mafintosh/pump |
| `pvtsutils` | 1.3.6 | MIT | github.com/PeculiarVentures/pvtsutils |
| `pvutils` | 1.2.0 | MIT | github.com/PeculiarVentures/pvutils |
| `rc` | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) | github.com/dominictarr/rc |
| `readable-stream` | 4.8.0 | MIT | github.com/nodejs/readable-stream |
| `reflect-metadata` | 0.2.2 | Apache-2.0 | github.com/rbuckton/reflect-metadata |
| `require-directory` | 2.1.1 | MIT | github.com/troygoode/node-require-directory |
| `require-from-string` | 2.0.2 | MIT | floatdrop/require-from-string |
| `rollup` | 4.64.12 | MIT | github.com/rollup/rollup |
| `safe-buffer` | 5.2.1 | MIT | github.com/feross/safe-buffer |
| `semver` | 7.8.5 | ISC | github.com/npm/node-semver |
| `set-function-length` | 1.2.2 | MIT | github.com/ljharb/set-function-length |
| `sha.js` | 2.4.12 | (MIT AND BSD-3-Clause) | github.com/crypto-browserify/sha.js |
| `simple-concat` | 1.0.1 | MIT | github.com/feross/simple-concat |
| `simple-get` | 4.0.1 | MIT | github.com/feross/simple-get |
| `smart-buffer` | 4.2.0 | MIT | github.com/JoshGlazebrook/smart-buffer |
| `source-map` | 0.6.1 | BSD-3-Clause | github.com/mozilla/source-map |
| `source-map-js` | 1.2.2 | BSD-3-Clause | 7rulnik/source-map-js |
| `streamx` | 2.28.1 | MIT | github.com/mafintosh/streamx |
| `string_decoder` | 1.3.0 | MIT | github.com/nodejs/string_decoder |
| `string-width` | 4.2.3 | MIT | sindresorhus/string-width |
| `strip-ansi` | 6.0.1 | MIT | chalk/strip-ansi |
| `strip-json-comments` | 2.0.1 | MIT | sindresorhus/strip-json-comments |
| `style-mod` | 4.1.4 | MIT | code.haverbeke.berlin/marijn/style-mod |
| `tar-fs` | 2.1.5 | MIT | github.com/mafintosh/tar-fs |
| `tar-stream` | 2.2.0 | MIT | github.com/mafintosh/tar-stream |
| `text-decoder` | 1.2.7 | Apache-2.0 | github.com/holepunchto/text-decoder |
| `through` | 2.3.8 | MIT | github.com/dominictarr/through |
| `tinyglobby` | 0.2.17 | MIT | github.com/SuperchupuDev/tinyglobby |
| `to-buffer` | 1.2.2 | MIT | github.com/browserify/to-buffer |
| `tslib` | 2.8.1 | 0BSD | github.com/Microsoft/tslib |
| `tsyringe` | 4.10.0 | MIT | github.com/Microsoft/tsyringe |
| `tunnel-agent` | 0.6.0 | Apache-2.0 | github.com/mikeal/tunnel-agent |
| `typed-array-buffer` | 1.0.3 | MIT | github.com/inspect-js/typed-array-buffer |
| `typescript` | 5.9.3 | Apache-2.0 | github.com/microsoft/TypeScript |
| `undici-types` | 6.21.0 | MIT | github.com/nodejs/undici |
| `util-deprecate` | 1.0.2 | MIT | github.com/TooTallNate/util-deprecate |
| `vite` | 6.4.5 | MIT | github.com/vitejs/vite |
| `w3c-keyname` | 2.2.8 | MIT | github.com/marijnh/w3c-keyname |
| `which-typed-array` | 1.1.24 | MIT | github.com/inspect-js/which-typed-array |
| `wrap-ansi` | 7.0.0 | MIT | chalk/wrap-ansi |
| `wrappy` | 1.0.2 | ISC | github.com/npm/wrappy |
| `y18n` | 5.0.8 | ISC | yargs/y18n |
| `yargs-parser` | 21.1.1 | ISC | github.com/yargs/yargs-parser |

---

## D. Rust crate

由 `client/src-tauri/Cargo.lock` 提取，逐个**按锁定版本**查 crates.io API。

> ★ 不能用 `index.crates.io`（sparse index）判协议：它的 JSON 里没有
> license 字段，会把全部 crate 读成"未知"，从而得出错误的"干净"结论。

协议分布（前 15）：

- MIT OR Apache-2.0 —— 224 个
- MIT —— 117 个
- Apache-2.0 OR MIT —— 52 个
- MIT/Apache-2.0 —— 20 个
- Unicode-3.0 —— 18 个
- Zlib OR Apache-2.0 OR MIT —— 17 个
- Unlicense OR MIT —— 9 个
- MPL-2.0 —— 5 个
- Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT —— 5 个
- Apache-2.0/MIT —— 3 个
- Apache-2.0 —— 3 个
- BSD-3-Clause —— 2 个
- Zlib —— 2 个
- MIT OR Zlib OR Apache-2.0 —— 2 个
- BSD-3-Clause OR MIT OR Apache-2.0 —— 2 个

| 组件 | 版本 | 许可 | 源码/主页 |
| --- | --- | --- | --- |
| `adler2` | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | github.com/oyvindln/adler2 |
| `aho-corasick` | 1.1.5 | Unlicense OR MIT | github.com/BurntSushi/aho-corasick |
| `alloc-no-stdlib` | 3.0.0 | BSD-3-Clause | github.com/dropbox/rust-alloc-no-stdlib |
| `alloc-stdlib` | 0.3.0 | BSD-3-Clause | github.com/dropbox/rust-alloc-no-stdlib |
| `android_log-sys` | 0.3.2 | MIT OR Apache-2.0 | github.com/rust-mobile/android_log-sys-rs |
| `android_logger` | 0.15.1 | MIT OR Apache-2.0 | github.com/rust-mobile/android_logger-rs |
| `android_system_properties` | 0.1.6 | MIT OR Apache-2.0 | github.com/nical/android_system_properties |
| `anyhow` | 1.0.104 | MIT OR Apache-2.0 | github.com/dtolnay/anyhow |
| `async-broadcast` | 0.7.2 | MIT OR Apache-2.0 | github.com/smol-rs/async-broadcast |
| `async-channel` | 2.5.0 | Apache-2.0 OR MIT | github.com/smol-rs/async-channel |
| `async-executor` | 1.14.0 | Apache-2.0 OR MIT | github.com/smol-rs/async-executor |
| `async-io` | 2.6.0 | Apache-2.0 OR MIT | github.com/smol-rs/async-io |
| `async-lock` | 3.4.2 | Apache-2.0 OR MIT | github.com/smol-rs/async-lock |
| `async-process` | 2.5.0 | Apache-2.0 OR MIT | github.com/smol-rs/async-process |
| `async-recursion` | 1.2.0 | MIT OR Apache-2.0 | github.com/dcchut/async-recursion |
| `async-signal` | 0.2.14 | Apache-2.0 OR MIT | github.com/smol-rs/async-signal |
| `async-task` | 4.7.1 | Apache-2.0 OR MIT | github.com/smol-rs/async-task |
| `async-trait` | 0.1.92 | MIT OR Apache-2.0 | github.com/dtolnay/async-trait |
| `atk` | 0.18.2 | MIT | github.com/gtk-rs/gtk3-rs |
| `atk-sys` | 0.18.2 | MIT | github.com/gtk-rs/gtk3-rs |
| `atomic-waker` | 1.1.2 | Apache-2.0 OR MIT | github.com/smol-rs/atomic-waker |
| `autocfg` | 1.5.1 | Apache-2.0 OR MIT | github.com/cuviper/autocfg |
| `base64` | 0.21.7 | MIT OR Apache-2.0 | github.com/marshallpierce/rust-base64 |
| `base64` | 0.22.1 | MIT OR Apache-2.0 | github.com/marshallpierce/rust-base64 |
| `base64` | 0.23.1 | MIT OR Apache-2.0 | github.com/marshallpierce/rust-base64 |
| `bit-set` | 0.8.0 | Apache-2.0 OR MIT | github.com/contain-rs/bit-set |
| `bit-vec` | 0.8.0 | Apache-2.0 OR MIT | github.com/contain-rs/bit-vec |
| `bitflags` | 1.3.2 | MIT/Apache-2.0 | github.com/bitflags/bitflags |
| `bitflags` | 2.13.2 | MIT OR Apache-2.0 | github.com/bitflags/bitflags |
| `block-buffer` | 0.10.4 | MIT OR Apache-2.0 | github.com/RustCrypto/utils |
| `block2` | 0.6.2 | MIT | github.com/madsmtm/objc2 |
| `blocking` | 1.7.0 | Apache-2.0 OR MIT | github.com/smol-rs/blocking |
| `brotli` | 9.0.0 | BSD-3-Clause AND MIT | github.com/dropbox/rust-brotli |
| `brotli-decompressor` | 6.0.1 | BSD-3-Clause/MIT | github.com/dropbox/rust-brotli-decompressor |
| `bs58` | 0.5.1 | MIT/Apache-2.0 | github.com/Nullus157/bs58-rs |
| `bumpalo` | 3.20.3 | MIT OR Apache-2.0 | github.com/fitzgen/bumpalo |
| `bytemuck` | 1.25.2 | Zlib OR Apache-2.0 OR MIT | github.com/Lokathor/bytemuck |
| `byteorder` | 1.5.0 | Unlicense OR MIT | github.com/BurntSushi/byteorder |
| `bytes` | 1.12.1 | MIT | github.com/tokio-rs/bytes |
| `cairo-rs` | 0.18.5 | MIT | github.com/gtk-rs/gtk-rs-core |
| `cairo-sys-rs` | 0.18.2 | MIT | github.com/gtk-rs/gtk-rs-core |
| `camino` | 1.2.6 | MIT OR Apache-2.0 | github.com/camino-rs/camino |
| `cargo_metadata` | 0.19.2 | MIT | github.com/oli-obk/cargo_metadata |
| `cargo_toml` | 1.0.1 | Apache-2.0 OR MIT | gitlab.com/lib.rs/cargo_toml |
| `cargo-platform` | 0.1.9 | MIT OR Apache-2.0 | github.com/rust-lang/cargo |
| `cc` | 1.9.0 | MIT OR Apache-2.0 | github.com/rust-lang/cc-rs |
| `cesu8` | 1.1.0 | Apache-2.0/MIT | github.com/emk/cesu8-rs |
| `cfb` | 0.14.0 | MIT | github.com/mdsteele/rust-cfb |
| `cfg-expr` | 0.15.8 | MIT OR Apache-2.0 | github.com/EmbarkStudios/cfg-expr |
| `cfg-if` | 1.0.5 | MIT OR Apache-2.0 | github.com/rust-lang/cfg-if |
| `chrono` | 0.4.45 | MIT OR Apache-2.0 | github.com/chronotope/chrono |
| `combine` | 4.6.9 | MIT | github.com/Marwes/combine |
| `concurrent-queue` | 2.5.0 | Apache-2.0 OR MIT | github.com/smol-rs/concurrent-queue |
| `cookie` | 0.18.2 | MIT OR Apache-2.0 | github.com/SergioBenitez/cookie-rs |
| `cookie_store` | 0.22.1 | MIT OR Apache-2.0 | github.com/pfernie/cookie_store |
| `core-foundation` | 0.10.1 | MIT OR Apache-2.0 | github.com/servo/core-foundation-rs |
| `core-foundation-sys` | 0.8.7 | MIT OR Apache-2.0 | github.com/servo/core-foundation-rs |
| `core-graphics` | 0.25.0 | MIT OR Apache-2.0 | github.com/servo/core-foundation-rs |
| `core-graphics-types` | 0.2.0 | MIT OR Apache-2.0 | github.com/servo/core-foundation-rs |
| `cpufeatures` | 0.2.17 | MIT OR Apache-2.0 | github.com/RustCrypto/utils |
| `crc32fast` | 1.5.3 | MIT OR Apache-2.0 | github.com/srijs/rust-crc32fast |
| `crossbeam-channel` | 0.5.17 | MIT OR Apache-2.0 | github.com/crossbeam-rs/crossbeam |
| `crossbeam-utils` | 0.8.23 | MIT OR Apache-2.0 | github.com/crossbeam-rs/crossbeam |
| `crypto-common` | 0.1.7 | MIT OR Apache-2.0 | github.com/RustCrypto/traits |
| `cssparser` | 0.37.0 | MPL-2.0 | github.com/servo/rust-cssparser |
| `cssparser-macros` | 0.7.1 | MPL-2.0 | github.com/servo/rust-cssparser |
| `ctor` | 1.0.13 | Apache-2.0 OR MIT | github.com/mmastrac/linktime |
| `darling` | 0.24.1 | MIT | github.com/TedDriggs/darling |
| `darling_core` | 0.24.1 | MIT | github.com/TedDriggs/darling |
| `darling_macro` | 0.24.1 | MIT | github.com/TedDriggs/darling |
| `dbus` | 0.9.12 | Apache-2.0/MIT | github.com/diwic/dbus-rs |
| `defmt` | 1.2.0 | MIT OR Apache-2.0 | github.com/knurling-rs/defmt |
| `defmt-macros` | 1.2.0 | MIT OR Apache-2.0 | github.com/knurling-rs/defmt |
| `defmt-parser` | 1.1.0 | MIT OR Apache-2.0 | github.com/knurling-rs/defmt |
| `deranged` | 0.5.9 | MIT OR Apache-2.0 | github.com/jhpratt/deranged |
| `derive_more` | 2.1.1 | MIT | github.com/JelteF/derive_more |
| `derive_more-impl` | 2.1.1 | MIT | github.com/JelteF/derive_more |
| `digest` | 0.10.7 | MIT OR Apache-2.0 | github.com/RustCrypto/traits |
| `dirs` | 7.0.0 | MIT OR Apache-2.0 | codeberg.org/dirs/dirs-rs |
| `dirs-sys` | 0.5.0 | MIT OR Apache-2.0 | github.com/dirs-dev/dirs-sys-rs |
| `dispatch2` | 0.3.1 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `displaydoc` | 0.2.7 | MIT OR Apache-2.0 | github.com/yaahc/displaydoc |
| `dlopen2` | 0.8.2 | MIT | github.com/OpenByteDev/dlopen2 |
| `dlopen2_derive` | 0.4.3 | MIT | github.com/OpenByteDev/dlopen2 |
| `document-features` | 0.2.12 | MIT OR Apache-2.0 | github.com/slint-ui/document-features |
| `dom_query` | 0.28.0 | MIT | github.com/niklak/dom_query |
| `dpi` | 0.1.2 | Apache-2.0 AND MIT | github.com/rust-windowing/winit |
| `dtoa` | 1.0.11 | MIT OR Apache-2.0 | github.com/dtolnay/dtoa |
| `dtoa-short` | 0.3.5 | MPL-2.0 | github.com/upsuper/dtoa-short |
| `dunce` | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 | gitlab.com/kornelski/dunce |
| `dyn-clone` | 1.0.20 | MIT OR Apache-2.0 | github.com/dtolnay/dyn-clone |
| `embed_plist` | 1.2.2 | MIT OR Apache-2.0 | github.com/nvzqz/embed-plist-rs |
| `embed-resource` | 3.0.12 | MIT | github.com/nabijaczleweli/rust-embed-resource |
| `endi` | 1.1.1 | MIT | github.com/zeenix/endi |
| `enumflags2` | 0.7.12 | MIT OR Apache-2.0 | github.com/meithecatte/enumflags2 |
| `enumflags2_derive` | 0.7.12 | MIT OR Apache-2.0 | github.com/meithecatte/enumflags2 |
| `env_filter` | 0.1.4 | MIT OR Apache-2.0 | github.com/rust-cli/env_logger |
| `equivalent` | 1.0.3 | Apache-2.0 OR MIT | github.com/indexmap-rs/equivalent |
| `erased-serde` | 0.4.10 | MIT OR Apache-2.0 | github.com/dtolnay/erased-serde |
| `errno` | 0.3.14 | MIT OR Apache-2.0 | github.com/lambda-fairy/rust-errno |
| `event-listener` | 5.4.2 | Apache-2.0 OR MIT | github.com/smol-rs/event-listener |
| `event-listener-strategy` | 0.5.4 | Apache-2.0 OR MIT | github.com/smol-rs/event-listener-strategy |
| `fastrand` | 2.5.0 | Apache-2.0 OR MIT | github.com/smol-rs/fastrand |
| `fdeflate` | 0.3.7 | MIT OR Apache-2.0 | github.com/image-rs/fdeflate |
| `fern` | 0.7.1 | MIT | github.com/daboross/fern |
| `field-offset` | 0.3.6 | MIT OR Apache-2.0 | github.com/Diggsey/rust-field-offset |
| `find-msvc-tools` | 0.1.15 | MIT OR Apache-2.0 | github.com/rust-lang/cc-rs |
| `flate2` | 1.1.10 | MIT OR Apache-2.0 | github.com/rust-lang/flate2-rs |
| `fnv` | 1.0.7 | Apache-2.0 / MIT | github.com/servo/rust-fnv |
| `foldhash` | 0.2.0 | Zlib | github.com/orlp/foldhash |
| `foreign-types` | 0.3.2 | MIT/Apache-2.0 | github.com/sfackler/foreign-types |
| `foreign-types` | 0.5.0 | MIT/Apache-2.0 | github.com/sfackler/foreign-types |
| `foreign-types-macros` | 0.2.4 | MIT/Apache-2.0 | github.com/sfackler/foreign-types |
| `foreign-types-shared` | 0.1.1 | MIT/Apache-2.0 | github.com/sfackler/foreign-types |
| `foreign-types-shared` | 0.3.1 | MIT/Apache-2.0 | github.com/sfackler/foreign-types |
| `form_urlencoded` | 1.2.2 | MIT OR Apache-2.0 | github.com/servo/rust-url |
| `futures-channel` | 0.3.34 | MIT OR Apache-2.0 | github.com/rust-lang/futures-rs |
| `futures-core` | 0.3.34 | MIT OR Apache-2.0 | github.com/rust-lang/futures-rs |
| `futures-executor` | 0.3.34 | MIT OR Apache-2.0 | github.com/rust-lang/futures-rs |
| `futures-io` | 0.3.34 | MIT OR Apache-2.0 | github.com/rust-lang/futures-rs |
| `futures-lite` | 2.6.1 | Apache-2.0 OR MIT | github.com/smol-rs/futures-lite |
| `futures-macro` | 0.3.34 | MIT OR Apache-2.0 | github.com/rust-lang/futures-rs |
| `futures-sink` | 0.3.34 | MIT OR Apache-2.0 | github.com/rust-lang/futures-rs |
| `futures-task` | 0.3.34 | MIT OR Apache-2.0 | github.com/rust-lang/futures-rs |
| `futures-util` | 0.3.34 | MIT OR Apache-2.0 | github.com/rust-lang/futures-rs |
| `gdk` | 0.18.2 | MIT | github.com/gtk-rs/gtk3-rs |
| `gdk-pixbuf` | 0.18.5 | MIT | github.com/gtk-rs/gtk-rs-core |
| `gdk-pixbuf-sys` | 0.18.0 | MIT | github.com/gtk-rs/gtk-rs-core |
| `gdk-sys` | 0.18.2 | MIT | github.com/gtk-rs/gtk3-rs |
| `gdkwayland-sys` | 0.18.2 | MIT | github.com/gtk-rs/gtk3-rs |
| `gdkx11` | 0.18.2 | MIT | github.com/gtk-rs/gtk3-rs |
| `gdkx11-sys` | 0.18.2 | MIT | github.com/gtk-rs/gtk3-rs |
| `generic-array` | 0.14.7 | MIT | github.com/fizyk20/generic-array |
| `getrandom` | 0.3.4 | MIT OR Apache-2.0 | github.com/rust-random/getrandom |
| `getrandom` | 0.4.3 | MIT OR Apache-2.0 | github.com/rust-random/getrandom |
| `gio` | 0.18.4 | MIT | github.com/gtk-rs/gtk-rs-core |
| `gio-sys` | 0.18.1 | MIT | github.com/gtk-rs/gtk-rs-core |
| `glib` | 0.18.5 | MIT | github.com/gtk-rs/gtk-rs-core |
| `glib-macros` | 0.18.5 | MIT | github.com/gtk-rs/gtk-rs-core |
| `glib-sys` | 0.18.1 | MIT | github.com/gtk-rs/gtk-rs-core |
| `glob` | 0.3.4 | MIT OR Apache-2.0 | github.com/rust-lang/glob |
| `gobject-sys` | 0.18.0 | MIT | github.com/gtk-rs/gtk-rs-core |
| `gtk` | 0.18.2 | MIT | github.com/gtk-rs/gtk3-rs |
| `gtk-sys` | 0.18.2 | MIT | github.com/gtk-rs/gtk3-rs |
| `gtk3-macros` | 0.18.2 | MIT | github.com/gtk-rs/gtk3-rs |
| `hashbrown` | 0.12.3 | MIT OR Apache-2.0 | github.com/rust-lang/hashbrown |
| `hashbrown` | 0.16.1 | MIT OR Apache-2.0 | github.com/rust-lang/hashbrown |
| `heck` | 0.4.1 | MIT OR Apache-2.0 | github.com/withoutboats/heck |
| `heck` | 0.5.0 | MIT OR Apache-2.0 | github.com/withoutboats/heck |
| `hermit-abi` | 0.5.3 | MIT OR Apache-2.0 | github.com/hermit-os/hermit-rs |
| `hex` | 0.4.3 | MIT OR Apache-2.0 | github.com/KokaKiwi/rust-hex |
| `html5ever` | 0.39.0 | MIT OR Apache-2.0 | github.com/servo/html5ever |
| `http` | 1.5.0 | MIT OR Apache-2.0 | github.com/hyperium/http |
| `http-body` | 1.1.0 | MIT | github.com/hyperium/http-body |
| `http-body-util` | 0.1.5 | MIT | github.com/hyperium/http-body |
| `httparse` | 1.10.1 | MIT OR Apache-2.0 | github.com/seanmonstar/httparse |
| `httpdate` | 1.0.3 | MIT OR Apache-2.0 | github.com/pyfisch/httpdate |
| `hyper` | 1.12.0 | MIT | github.com/hyperium/hyper |
| `hyper-tls` | 0.6.0 | MIT/Apache-2.0 | github.com/hyperium/hyper-tls |
| `hyper-util` | 0.1.21 | MIT | github.com/hyperium/hyper-util |
| `iana-time-zone` | 0.1.65 | MIT OR Apache-2.0 | github.com/strawlab/iana-time-zone |
| `iana-time-zone-haiku` | 0.1.2 | MIT OR Apache-2.0 | github.com/strawlab/iana-time-zone |
| `ico` | 0.5.0 | MIT | github.com/mdsteele/rust-ico |
| `icu_collections` | 2.3.0 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `icu_locale_core` | 2.3.0 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `icu_normalizer` | 2.3.0 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `icu_normalizer_data` | 2.3.0 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `icu_properties` | 2.3.0 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `icu_properties_data` | 2.3.0 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `icu_provider` | 2.3.1 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `ident_case` | 1.0.1 | MIT/Apache-2.0 | github.com/TedDriggs/ident_case |
| `idna` | 1.1.0 | MIT OR Apache-2.0 | github.com/servo/rust-url/ |
| `idna_adapter` | 1.2.2 | Apache-2.0 OR MIT | github.com/hsivonen/idna_adapter |
| `indexmap` | 1.9.3 | Apache-2.0 OR MIT | github.com/bluss/indexmap |
| `indexmap` | 2.13.0 | Apache-2.0 OR MIT | github.com/indexmap-rs/indexmap |
| `infer` | 0.22.0 | MIT | github.com/bojand/infer |
| `ipnet` | 2.12.2 | MIT OR Apache-2.0 | github.com/krisprice/ipnet |
| `is-docker` | 0.2.0 | MIT | github.com/TheLarkInn/is-docker |
| `is-wsl` | 0.4.0 | MIT | github.com/TheLarkInn/is-wsl |
| `itoa` | 1.0.18 | MIT OR Apache-2.0 | github.com/dtolnay/itoa |
| `javascriptcore-rs` | 1.1.2 | MIT | github.com/tauri-apps/javascriptcore-rs |
| `javascriptcore-rs-sys` | 1.1.1 | MIT | github.com/tauri-apps/javascriptcore-rs |
| `jiff` | 0.2.38 | Unlicense OR MIT | github.com/BurntSushi/jiff |
| `jiff-core` | 0.1.1 | Unlicense OR MIT | github.com/BurntSushi/jiff |
| `jiff-static` | 0.2.38 | Unlicense OR MIT | github.com/BurntSushi/jiff |
| `jiff-tzdb` | 0.1.9 | Unlicense OR MIT | github.com/BurntSushi/jiff |
| `jiff-tzdb-platform` | 0.1.3 | Unlicense OR MIT | github.com/BurntSushi/jiff |
| `jni` | 0.21.1 | MIT/Apache-2.0 | github.com/jni-rs/jni-rs |
| `jni-sys` | 0.3.1 | MIT OR Apache-2.0 | github.com/jni-rs/jni-sys |
| `jni-sys` | 0.4.1 | MIT OR Apache-2.0 | github.com/jni-rs/jni-sys |
| `jni-sys-macros` | 0.4.1 | MIT OR Apache-2.0 | github.com/jni-rs/jni-sys |
| `js-sys` | 0.3.106 | MIT OR Apache-2.0 | github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/js-sys |
| `json-patch` | 4.2.0 | MIT/Apache-2.0 | github.com/idubrov/json-patch |
| `jsonptr` | 0.7.1 | MIT OR Apache-2.0 | github.com/chanced/jsonptr |
| `keyboard-types` | 0.8.3 | MIT OR Apache-2.0 | github.com/rust-windowing/keyboard-types |
| `libappindicator` | 0.9.0 | Apache-2.0 OR MIT |  |
| `libappindicator-sys` | 0.9.0 | Apache-2.0 OR MIT |  |
| `libc` | 0.2.191 | MIT OR Apache-2.0 | github.com/rust-lang/libc |
| `libdbus-sys` | 0.2.7 | Apache-2.0/MIT | github.com/diwic/dbus-rs |
| `libloading` | 0.7.4 | ISC | github.com/nagisa/rust_libloading/ |
| `libredox` | 0.1.25 | MIT | gitlab.redox-os.org/redox-os/libredox |
| `linux-raw-sys` | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | github.com/sunfishcode/linux-raw-sys |
| `litemap` | 0.8.3 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `litrs` | 1.0.1 | MIT OR Apache-2.0 | github.com/LukasKalbertodt/litrs |
| `lock_api` | 0.4.14 | MIT OR Apache-2.0 | github.com/Amanieu/parking_lot |
| `log` | 0.4.34 | MIT OR Apache-2.0 | github.com/rust-lang/log |
| `markup5ever` | 0.39.0 | MIT OR Apache-2.0 | github.com/servo/html5ever |
| `memchr` | 2.8.3 | Unlicense OR MIT | github.com/BurntSushi/memchr |
| `memoffset` | 0.9.1 | MIT | github.com/Gilnaa/memoffset |
| `mime` | 0.3.17 | MIT OR Apache-2.0 | github.com/hyperium/mime |
| `miniz_oxide` | 0.8.9 | MIT OR Zlib OR Apache-2.0 | github.com/Frommi/miniz_oxide/tree/master/miniz_oxide |
| `miniz_oxide` | 0.9.1 | MIT OR Zlib OR Apache-2.0 | github.com/Frommi/miniz_oxide/tree/master/miniz_oxide |
| `mio` | 1.2.4 | MIT | github.com/tokio-rs/mio |
| `muda` | 0.20.0 | Apache-2.0 OR MIT | github.com/tauri-apps/muda |
| `native-tls` | 0.2.18 | MIT OR Apache-2.0 | github.com/rust-native-tls/rust-native-tls |
| `ndk` | 0.9.0 | MIT OR Apache-2.0 | github.com/rust-mobile/ndk |
| `ndk-context` | 0.1.1 | MIT OR Apache-2.0 | github.com/rust-windowing/android-ndk-rs |
| `ndk-sys` | 0.6.0+11769913 | MIT OR Apache-2.0 | github.com/rust-mobile/ndk |
| `new_debug_unreachable` | 1.0.6 | MIT | github.com/mbrubeck/rust-debug-unreachable |
| `num_enum` | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 | github.com/illicitonion/num_enum |
| `num_enum_derive` | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 | github.com/illicitonion/num_enum |
| `num_threads` | 0.1.8 | MIT OR Apache-2.0 | github.com/jhpratt/num_threads |
| `num-conv` | 0.2.2 | MIT OR Apache-2.0 | github.com/jhpratt/num-conv |
| `num-traits` | 0.2.19 | MIT OR Apache-2.0 | github.com/rust-num/num-traits |
| `objc2` | 0.6.5 | MIT | github.com/madsmtm/objc2 |
| `objc2-app-kit` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `objc2-cloud-kit` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `objc2-core-data` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `objc2-core-foundation` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `objc2-core-graphics` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `objc2-core-image` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `objc2-core-location` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `objc2-core-text` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `objc2-encode` | 4.1.0 | MIT | github.com/madsmtm/objc2 |
| `objc2-exception-helper` | 0.1.1 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `objc2-foundation` | 0.3.2 | MIT | github.com/madsmtm/objc2 |
| `objc2-io-surface` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `objc2-quartz-core` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `objc2-ui-kit` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `objc2-user-notifications` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `objc2-web-kit` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | github.com/madsmtm/objc2 |
| `once_cell` | 1.21.4 | MIT OR Apache-2.0 | github.com/matklad/once_cell |
| `open` | 5.4.4 | MIT | github.com/Byron/open-rs |
| `openssl` | 0.10.82 | Apache-2.0 | github.com/rust-openssl/rust-openssl |
| `openssl-macros` | 0.1.1 | MIT/Apache-2.0 |  |
| `openssl-probe` | 0.2.2 | MIT OR Apache-2.0 | github.com/rustls/openssl-probe |
| `openssl-sys` | 0.9.118 | MIT | github.com/rust-openssl/rust-openssl |
| `option-ext` | 0.2.0 | MPL-2.0 | github.com/soc/option-ext |
| `ordered-stream` | 0.2.0 | MIT OR Apache-2.0 | github.com/danieldg/ordered-stream |
| `pango` | 0.18.3 | MIT | github.com/gtk-rs/gtk-rs-core |
| `pango-sys` | 0.18.0 | MIT | github.com/gtk-rs/gtk-rs-core |
| `parking` | 2.2.1 | Apache-2.0 OR MIT | github.com/smol-rs/parking |
| `parking_lot` | 0.12.5 | MIT OR Apache-2.0 | github.com/Amanieu/parking_lot |
| `parking_lot_core` | 0.9.12 | MIT OR Apache-2.0 | github.com/Amanieu/parking_lot |
| `percent-encoding` | 2.3.2 | MIT OR Apache-2.0 | github.com/servo/rust-url/ |
| `phf` | 0.13.1 | MIT | github.com/rust-phf/rust-phf |
| `phf_codegen` | 0.13.1 | MIT | github.com/rust-phf/rust-phf |
| `phf_generator` | 0.13.1 | MIT | github.com/rust-phf/rust-phf |
| `phf_macros` | 0.13.1 | MIT | github.com/rust-phf/rust-phf |
| `phf_shared` | 0.13.1 | MIT | github.com/rust-phf/rust-phf |
| `pin-project-lite` | 0.2.17 | Apache-2.0 OR MIT | github.com/taiki-e/pin-project-lite |
| `piper` | 0.2.5 | MIT OR Apache-2.0 | github.com/smol-rs/piper |
| `pkg-config` | 0.3.34 | MIT OR Apache-2.0 | github.com/rust-lang/pkg-config-rs |
| `plist` | 1.10.0 | MIT | github.com/ebarnard/rust-plist/ |
| `png` | 0.17.16 | MIT OR Apache-2.0 | github.com/image-rs/image-png |
| `png` | 0.18.1 | MIT OR Apache-2.0 | github.com/image-rs/image-png |
| `polling` | 3.11.0 | Apache-2.0 OR MIT | github.com/smol-rs/polling |
| `portable-atomic` | 1.15.0 | Apache-2.0 OR MIT | github.com/taiki-e/portable-atomic |
| `portable-atomic-util` | 0.2.8 | Apache-2.0 OR MIT | github.com/taiki-e/portable-atomic-util |
| `potential_utf` | 0.1.6 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `powerfmt` | 0.2.1 | MIT OR Apache-2.0 | github.com/jhpratt/powerfmt |
| `precomputed-hash` | 0.1.1 | MIT | github.com/emilio/precomputed-hash |
| `proc-macro-crate` | 1.3.1 | MIT OR Apache-2.0 | github.com/bkchr/proc-macro-crate |
| `proc-macro-crate` | 2.0.2 | MIT OR Apache-2.0 | github.com/bkchr/proc-macro-crate |
| `proc-macro-crate` | 3.5.0 | MIT OR Apache-2.0 | github.com/bkchr/proc-macro-crate |
| `proc-macro-error` | 1.0.4 | MIT OR Apache-2.0 | gitlab.com/CreepySkeleton/proc-macro-error |
| `proc-macro-error-attr` | 1.0.4 | MIT OR Apache-2.0 | gitlab.com/CreepySkeleton/proc-macro-error |
| `proc-macro2` | 1.0.107 | MIT OR Apache-2.0 | github.com/dtolnay/proc-macro2 |
| `psl-types` | 2.0.11 | MIT/Apache-2.0 | github.com/addr-rs/psl-types |
| `publicsuffix` | 2.3.0 | MIT/Apache-2.0 | github.com/rushmorem/publicsuffix |
| `quick-xml` | 0.41.0 | MIT | github.com/tafia/quick-xml |
| `quote` | 1.0.47 | MIT OR Apache-2.0 | github.com/dtolnay/quote |
| `r-efi` | 5.3.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later | github.com/r-efi/r-efi |
| `r-efi` | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later | github.com/r-efi/r-efi |
| `raw-window-handle` | 0.6.2 | MIT OR Apache-2.0 OR Zlib | github.com/rust-windowing/raw-window-handle |
| `redox_syscall` | 0.5.18 | MIT | gitlab.redox-os.org/redox-os/syscall |
| `redox_users` | 0.5.3 | MIT | gitlab.redox-os.org/redox-os/users |
| `ref-cast` | 1.0.27 | MIT OR Apache-2.0 | github.com/dtolnay/ref-cast |
| `ref-cast-impl` | 1.0.27 | MIT OR Apache-2.0 | github.com/dtolnay/ref-cast |
| `regex` | 1.13.1 | MIT OR Apache-2.0 | github.com/rust-lang/regex |
| `regex-automata` | 0.4.18 | MIT OR Apache-2.0 | github.com/rust-lang/regex |
| `regex-syntax` | 0.8.11 | MIT OR Apache-2.0 | github.com/rust-lang/regex |
| `reqwest` | 0.12.28 | MIT OR Apache-2.0 | github.com/seanmonstar/reqwest |
| `reqwest` | 0.13.5 | MIT OR Apache-2.0 | github.com/seanmonstar/reqwest |
| `rfd` | 0.16.0 | MIT | github.com/PolyMeilex/rfd |
| `rustc_version` | 0.4.1 | MIT OR Apache-2.0 | github.com/djc/rustc-version-rs |
| `rustc-hash` | 2.1.3 | Apache-2.0 OR MIT | github.com/rust-lang/rustc-hash |
| `rustix` | 1.1.5 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | github.com/bytecodealliance/rustix |
| `rustls-pki-types` | 1.15.1 | MIT OR Apache-2.0 | github.com/rustls/pki-types |
| `rustversion` | 1.0.23 | MIT OR Apache-2.0 | github.com/dtolnay/rustversion |
| `ryu` | 1.0.23 | Apache-2.0 OR BSL-1.0 | github.com/dtolnay/ryu |
| `same-file` | 1.0.6 | Unlicense/MIT | github.com/BurntSushi/same-file |
| `schannel` | 0.1.30 | MIT | github.com/steffengy/schannel-rs |
| `schemars` | 0.8.22 | MIT | github.com/GREsau/schemars |
| `schemars` | 0.9.0 | MIT | github.com/GREsau/schemars |
| `schemars` | 1.2.3 | MIT | github.com/GREsau/schemars |
| `schemars_derive` | 0.8.22 | MIT | github.com/GREsau/schemars |
| `scopeguard` | 1.2.0 | MIT OR Apache-2.0 | github.com/bluss/scopeguard |
| `security-framework` | 3.7.0 | MIT OR Apache-2.0 | github.com/kornelski/rust-security-framework |
| `security-framework-sys` | 2.17.0 | MIT OR Apache-2.0 | github.com/kornelski/rust-security-framework |
| `selectors` | 0.38.0 | MPL-2.0 | github.com/servo/stylo |
| `semver` | 1.0.28 | MIT OR Apache-2.0 | github.com/dtolnay/semver |
| `serde` | 1.0.229 | MIT OR Apache-2.0 | github.com/serde-rs/serde |
| `serde_core` | 1.0.229 | MIT OR Apache-2.0 | github.com/serde-rs/serde |
| `serde_derive` | 1.0.229 | MIT OR Apache-2.0 | github.com/serde-rs/serde |
| `serde_derive_internals` | 0.29.1 | MIT OR Apache-2.0 | github.com/serde-rs/serde |
| `serde_json` | 1.0.154 | MIT OR Apache-2.0 | github.com/serde-rs/json |
| `serde_repr` | 0.1.21 | MIT OR Apache-2.0 | github.com/dtolnay/serde-repr |
| `serde_spanned` | 0.6.9 | MIT OR Apache-2.0 | github.com/toml-rs/toml |
| `serde_spanned` | 1.1.2 | MIT OR Apache-2.0 | github.com/toml-rs/toml |
| `serde_urlencoded` | 0.7.1 | MIT/Apache-2.0 | github.com/nox/serde_urlencoded |
| `serde_with` | 3.24.0 | MIT OR Apache-2.0 | github.com/jonasbb/serde_with/ |
| `serde_with_macros` | 3.24.0 | MIT OR Apache-2.0 | github.com/jonasbb/serde_with/ |
| `serde-untagged` | 0.1.9 | MIT OR Apache-2.0 | github.com/dtolnay/serde-untagged |
| `serialize-to-javascript` | 0.1.2 | MIT OR Apache-2.0 | github.com/chippers/serialize-to-javascript |
| `serialize-to-javascript-impl` | 0.1.2 | MIT OR Apache-2.0 | github.com/chippers/serialize-to-javascript |
| `servo_arc` | 0.4.3 | MIT OR Apache-2.0 | github.com/servo/stylo |
| `sha2` | 0.10.9 | MIT OR Apache-2.0 | github.com/RustCrypto/hashes |
| `shlex` | 2.0.1 | MIT OR Apache-2.0 | github.com/comex/rust-shlex |
| `signal-hook-registry` | 1.4.8 | MIT OR Apache-2.0 | github.com/vorner/signal-hook |
| `simd-adler32` | 0.3.10 | MIT | github.com/mcountryman/simd-adler32 |
| `siphasher` | 1.0.4 | MIT OR Apache-2.0 | github.com/jedisct1/rust-siphash |
| `slab` | 0.4.12 | MIT | github.com/tokio-rs/slab |
| `smallvec` | 1.16.3 | MIT OR Apache-2.0 | github.com/servo/rust-smallvec |
| `socket2` | 0.6.5 | MIT OR Apache-2.0 | github.com/rust-lang/socket2 |
| `softbuffer` | 0.4.8 | MIT OR Apache-2.0 | github.com/rust-windowing/softbuffer |
| `soup3` | 0.5.0 | MIT | gitlab.gnome.org/World/Rust/soup3-rs |
| `soup3-sys` | 0.5.0 | MIT | gitlab.gnome.org/World/Rust/soup3-rs |
| `stable_deref_trait` | 1.2.1 | MIT OR Apache-2.0 | github.com/storyyeller/stable_deref_trait |
| `static_vcruntime` | 3.0.0 | MIT OR Apache-2.0 OR Zlib | github.com/ChrisDenton/static_vcruntime |
| `string_cache` | 0.9.0 | MIT OR Apache-2.0 | github.com/servo/string-cache |
| `string_cache_codegen` | 0.6.1 | MIT OR Apache-2.0 | github.com/servo/string-cache |
| `strsim` | 0.11.1 | MIT | github.com/rapidfuzz/strsim-rs |
| `swift-rs` | 1.0.9 | MIT OR Apache-2.0 | github.com/Brendonovich/swift-rs |
| `syn` | 1.0.109 | MIT OR Apache-2.0 | github.com/dtolnay/syn |
| `syn` | 2.0.119 | MIT OR Apache-2.0 | github.com/dtolnay/syn |
| `syn` | 3.0.9 | MIT OR Apache-2.0 | github.com/dtolnay/syn |
| `sync_wrapper` | 1.0.2 | Apache-2.0 | github.com/Actyx/sync_wrapper |
| `synstructure` | 0.14.0 | MIT | github.com/mystor/synstructure |
| `system-deps` | 6.2.2 | MIT OR Apache-2.0 | github.com/gdesmott/system-deps |
| `tao` | 0.37.1 | Apache-2.0 | github.com/tauri-apps/tao |
| `tao-macros` | 0.1.4 | MIT OR Apache-2.0 | github.com/tauri-apps/tao |
| `target-lexicon` | 0.12.16 | Apache-2.0 WITH LLVM-exception | github.com/bytecodealliance/target-lexicon |
| `tauri` | 2.12.4 | Apache-2.0 OR MIT | github.com/tauri-apps/tauri |
| `tauri-build` | 2.7.3 | Apache-2.0 OR MIT | github.com/tauri-apps/tauri |
| `tauri-codegen` | 2.7.3 | Apache-2.0 OR MIT | github.com/tauri-apps/tauri |
| `tauri-macros` | 2.7.3 | Apache-2.0 OR MIT | github.com/tauri-apps/tauri |
| `tauri-plugin` | 2.7.2 | Apache-2.0 OR MIT | github.com/tauri-apps/tauri |
| `tauri-plugin-dialog` | 2.8.3 | Apache-2.0 OR MIT | github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-fs` | 2.7.1 | Apache-2.0 OR MIT | github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-log` | 2.10.1 | Apache-2.0 OR MIT | github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-opener` | 2.7.2 | Apache-2.0 OR MIT | github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-single-instance` | 2.5.4 | Apache-2.0 OR MIT | github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-store` | 2.5.0 | Apache-2.0 OR MIT | github.com/tauri-apps/plugins-workspace |
| `tauri-plugin-window-state` | 2.5.0 | Apache-2.0 OR MIT | github.com/tauri-apps/plugins-workspace |
| `tauri-runtime` | 2.12.2 | Apache-2.0 OR MIT | github.com/tauri-apps/tauri |
| `tauri-runtime-wry` | 2.12.2 | Apache-2.0 OR MIT | github.com/tauri-apps/tauri |
| `tauri-utils` | 2.10.2 | Apache-2.0 OR MIT | github.com/tauri-apps/tauri |
| `tauri-winres` | 0.3.7 | MIT | github.com/tauri-apps/winres |
| `tempfile` | 3.27.0 | MIT OR Apache-2.0 | github.com/Stebalien/tempfile |
| `tendril` | 0.5.1 | MIT OR Apache-2.0 | github.com/servo/html5ever |
| `thiserror` | 1.0.69 | MIT OR Apache-2.0 | github.com/dtolnay/thiserror |
| `thiserror` | 2.0.21 | MIT OR Apache-2.0 | github.com/dtolnay/thiserror |
| `thiserror-impl` | 1.0.69 | MIT OR Apache-2.0 | github.com/dtolnay/thiserror |
| `thiserror-impl` | 2.0.21 | MIT OR Apache-2.0 | github.com/dtolnay/thiserror |
| `time` | 0.3.55 | MIT OR Apache-2.0 | github.com/time-rs/time |
| `time-core` | 0.1.9 | MIT OR Apache-2.0 | github.com/time-rs/time |
| `time-macros` | 0.2.32 | MIT OR Apache-2.0 | github.com/time-rs/time |
| `tinystr` | 0.8.4 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `tinyvec` | 1.13.3 | Zlib OR Apache-2.0 OR MIT | github.com/Lokathor/tinyvec |
| `tokio` | 1.54.0 | MIT | github.com/tokio-rs/tokio |
| `tokio-macros` | 2.7.2 | MIT | github.com/tokio-rs/tokio |
| `tokio-native-tls` | 0.3.1 | MIT | github.com/tokio-rs/tls |
| `tokio-util` | 0.7.20 | MIT | github.com/tokio-rs/tokio |
| `toml` | 0.8.2 | MIT OR Apache-2.0 | github.com/toml-rs/toml |
| `toml` | 1.1.8+spec-1.1.0 | MIT OR Apache-2.0 | github.com/toml-rs/toml |
| `toml_datetime` | 0.6.3 | MIT OR Apache-2.0 | github.com/toml-rs/toml |
| `toml_datetime` | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 | github.com/toml-rs/toml |
| `toml_edit` | 0.19.15 | MIT OR Apache-2.0 | github.com/toml-rs/toml |
| `toml_edit` | 0.20.2 | MIT OR Apache-2.0 | github.com/toml-rs/toml |
| `toml_edit` | 0.25.17+spec-1.1.0 | MIT OR Apache-2.0 | github.com/toml-rs/toml |
| `toml_parser` | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0 | github.com/toml-rs/toml |
| `toml_writer` | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 | github.com/toml-rs/toml |
| `tower` | 0.5.3 | MIT | github.com/tower-rs/tower |
| `tower-http` | 0.6.11 | MIT | github.com/tower-rs/tower-http |
| `tower-layer` | 0.3.3 | MIT | github.com/tower-rs/tower |
| `tower-service` | 0.3.3 | MIT | github.com/tower-rs/tower |
| `tracing` | 0.1.44 | MIT | github.com/tokio-rs/tracing |
| `tracing-attributes` | 0.1.31 | MIT | github.com/tokio-rs/tracing |
| `tracing-core` | 0.1.36 | MIT | github.com/tokio-rs/tracing |
| `tray-icon` | 0.25.1 | MIT OR Apache-2.0 | github.com/tauri-apps/tray-icon |
| `try-lock` | 0.2.5 | MIT | github.com/seanmonstar/try-lock |
| `typeid` | 1.0.3 | MIT OR Apache-2.0 | github.com/dtolnay/typeid |
| `typenum` | 1.20.1 | MIT OR Apache-2.0 | github.com/paholg/typenum |
| `uds_windows` | 1.2.1 | MIT | github.com/haraldh/rust_uds_windows |
| `unicode-ident` | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 | github.com/dtolnay/unicode-ident |
| `unicode-segmentation` | 1.13.3 | MIT OR Apache-2.0 | github.com/unicode-rs/unicode-segmentation |
| `url` | 2.5.8 | MIT OR Apache-2.0 | github.com/servo/rust-url |
| `urlpattern` | 0.6.0 | MIT | github.com/denoland/rust-urlpattern |
| `utf8_iter` | 1.0.4 | Apache-2.0 OR MIT | github.com/hsivonen/utf8_iter |
| `uuid` | 1.28.0 | Apache-2.0 OR MIT | github.com/uuid-rs/uuid |
| `vcpkg` | 0.2.15 | MIT/Apache-2.0 | github.com/mcgoo/vcpkg-rs |
| `version_check` | 0.9.5 | MIT/Apache-2.0 | github.com/SergioBenitez/version_check |
| `version-compare` | 0.2.1 | MIT | gitlab.com/timvisee/version-compare |
| `vswhom` | 0.1.0 | MIT | github.com/nabijaczleweli/vswhom.rs |
| `vswhom-sys` | 0.1.3 | MIT | github.com/nabijaczleweli/vswhom-sys.rs |
| `walkdir` | 2.5.0 | Unlicense/MIT | github.com/BurntSushi/walkdir |
| `want` | 0.3.2 | MIT | github.com/seanmonstar/want |
| `wasi` | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | github.com/bytecodealliance/wasi |
| `wasip2` | 1.0.4+wasi-0.2.12 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | github.com/bytecodealliance/wasi-rs |
| `wasm-bindgen` | 0.2.129 | MIT OR Apache-2.0 | github.com/wasm-bindgen/wasm-bindgen |
| `wasm-bindgen-futures` | 0.4.79 | MIT OR Apache-2.0 | github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/futures |
| `wasm-bindgen-macro` | 0.2.129 | MIT OR Apache-2.0 | github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro |
| `wasm-bindgen-macro-support` | 0.2.129 | MIT OR Apache-2.0 | github.com/wasm-bindgen/wasm-bindgen/tree/main/crates/macro-support |
| `wasm-bindgen-shared` | 0.2.129 | MIT OR Apache-2.0 | github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/shared |
| `wasm-streams` | 0.4.2 | MIT OR Apache-2.0 | github.com/MattiasBuelens/wasm-streams/ |
| `wasm-streams` | 0.5.0 | MIT OR Apache-2.0 | github.com/MattiasBuelens/wasm-streams/ |
| `web_atoms` | 0.2.6 | MIT OR Apache-2.0 | github.com/servo/html5ever |
| `web-sys` | 0.3.106 | MIT OR Apache-2.0 | github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/web-sys |
| `web-time` | 1.1.0 | MIT OR Apache-2.0 | github.com/daxpedda/web-time |
| `webkit2gtk` | 2.0.2 | MIT | github.com/tauri-apps/webkit2gtk-rs |
| `webkit2gtk-sys` | 2.0.2 | MIT | github.com/tauri-apps/webkit2gtk-rs |
| `webview2-com` | 0.39.1 | MIT | github.com/wravery/webview2-rs |
| `webview2-com-macros` | 0.8.1 | MIT | github.com/wravery/webview2-rs |
| `webview2-com-sys` | 0.39.1 | MIT | github.com/wravery/webview2-rs |
| `winapi` | 0.3.9 | MIT/Apache-2.0 | github.com/retep998/winapi-rs |
| `winapi-i686-pc-windows-gnu` | 0.4.0 | MIT/Apache-2.0 | github.com/retep998/winapi-rs |
| `winapi-util` | 0.1.11 | Unlicense OR MIT | github.com/BurntSushi/winapi-util |
| `winapi-x86_64-pc-windows-gnu` | 0.4.0 | MIT/Apache-2.0 | github.com/retep998/winapi-rs |
| `window-vibrancy` | 0.8.1 | Apache-2.0 OR MIT | github.com/tauri-apps/tauri-plugin-vibrancy |
| `windows` | 0.62.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_aarch64_gnullvm` | 0.42.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_aarch64_gnullvm` | 0.53.1 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_aarch64_msvc` | 0.42.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_aarch64_msvc` | 0.53.1 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_i686_gnu` | 0.42.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_i686_gnu` | 0.53.1 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_i686_gnullvm` | 0.53.1 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_i686_msvc` | 0.42.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_i686_msvc` | 0.53.1 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_x86_64_gnu` | 0.42.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_x86_64_gnu` | 0.53.1 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_x86_64_gnullvm` | 0.42.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_x86_64_gnullvm` | 0.53.1 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_x86_64_msvc` | 0.42.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows_x86_64_msvc` | 0.53.1 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-collections` | 0.3.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-core` | 0.62.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-future` | 0.3.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-implement` | 0.60.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-interface` | 0.59.3 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-link` | 0.2.1 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-numerics` | 0.3.1 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-result` | 0.4.1 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-strings` | 0.5.1 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-sys` | 0.45.0 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-sys` | 0.60.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-sys` | 0.61.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-targets` | 0.42.2 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-targets` | 0.53.5 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-threading` | 0.2.1 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `windows-version` | 0.1.7 | MIT OR Apache-2.0 | github.com/microsoft/windows-rs |
| `winnow` | 0.5.40 | MIT | github.com/winnow-rs/winnow |
| `winnow` | 1.0.4 | MIT | github.com/winnow-rs/winnow |
| `winreg` | 0.56.0 | MIT | github.com/gentoo90/winreg-rs |
| `wit-bindgen` | 0.57.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | github.com/bytecodealliance/wit-bindgen |
| `writeable` | 0.6.4 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `wry` | 0.57.0 | Apache-2.0 OR MIT | github.com/tauri-apps/wry |
| `x11` | 2.21.0 | MIT | github.com/AltF02/x11-rs |
| `x11-dl` | 2.21.0 | MIT | github.com/AltF02/x11-rs |
| `yoke` | 0.8.3 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `yoke-derive` | 0.8.4 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `zbus` | 5.19.0 | MIT | github.com/z-galaxy/zbus/ |
| `zbus_macros` | 5.19.0 | MIT | github.com/z-galaxy/zbus/ |
| `zbus_names` | 4.3.5 | MIT | github.com/z-galaxy/zbus/ |
| `zcheapstr` | 1.1.0 | MIT | github.com/z-galaxy/zcheapstr/ |
| `zerofrom` | 0.1.8 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `zerofrom-derive` | 0.1.8 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `zeroize` | 1.9.1 | Apache-2.0 OR MIT | github.com/RustCrypto/utils |
| `zerotrie` | 0.2.5 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `zerovec` | 0.11.8 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `zerovec-derive` | 0.11.6 | Unicode-3.0 | github.com/unicode-org/icu4x |
| `zlib-rs` | 0.6.8 | Zlib | github.com/trifectatechfoundation/zlib-rs |
| `zmij` | 1.0.23 | MIT | github.com/dtolnay/zmij |
| `zvariant` | 5.15.1 | MIT | github.com/z-galaxy/zbus/ |
| `zvariant_derive` | 5.15.1 | MIT | github.com/z-galaxy/zbus/ |
| `zvariant_utils` | 4.2.0 | MIT | github.com/z-galaxy/zbus/ |

---

## E. Android 依赖

全部为 Apache-2.0，来源见 `client/src-tauri/gen/android/app/build.gradle.kts`。

| 组件 | 版本 | 许可 |
| --- | --- | --- |
| `androidx.webkit:webkit` | 1.14.0 | Apache-2.0 |
| `androidx.appcompat:appcompat` | 1.7.1 | Apache-2.0 |
| `androidx.activity:activity-ktx` | 1.10.1 | Apache-2.0 |
| `com.google.android.material:material` | 1.12.0 | Apache-2.0 |
| `androidx.lifecycle:lifecycle-process` | 2.10.0 | Apache-2.0 |

---

## F. 需要人工处理的条目

第三方依赖中**没有**未声明许可的包。

> 备注：`@tcs/shared@0.1.10`
> 是本项目自己的包，出现在未声明列表里是因为 `release/server/app/node_modules`
> 是**上次构建的副本**（版本滞后于源码）。源码的 `package.json` 已声明 `MIT`，
> 下次构建后此处会自动消失。
