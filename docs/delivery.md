# 最终源码交付与运行（2026-11-25）

最终源码提交位置为 `交付/SFT-4.0.0-git-final-20261125`，包含源码目录 `SFT-4.0.0`、源码 ZIP、逐文件清单和 SHA-256。此前已验收的完整可运行副本仍保留在 `交付/SFT-4.0.0-final/SFT-4.0.0`，不在本轮重新构建或验证。原工作目录及原 Git 历史保留，旧 `artifacts/delivery` 下的包不再作为本轮提交版本。

首次运行和日常操作见 [README](../README.md)，已完成的验证见 [release-validation.md](release-validation.md)。该验收记录保持原样；本轮只整理源码与 Git，不新增功能、验收记录或测试执行，也不推送远端。

## 文件清单与依赖检查

`tools/release-files.txt` 是 115 个文件的源码白名单，包含四个 CMD、`tools/launch.ps1`、`tools/launch-common.ps1` 及全部依赖入口。`SOURCE-MANIFEST.json` 列出每个源码文件的大小和 SHA-256，记录真实 Git HEAD、父提交和源码 blob 对应关系。最终源码包不含运行依赖和构建输出；此前的可运行副本额外包含以下三棵生成目录：

- `publish/client`：本轮从干净副本执行 Release publish 得到的完整目录，包含 EXE、DLL、deps、runtimeconfig、协议程序集及发布产生的其他文件。
- `tools/runtime/node-v22.23.5-win-x64`：由已校验官方 ZIP 解出的完整便携 Node / npm 运行时，未借用旧验收运行目录。Node EXE SHA-256 固定为 `247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a`。
- `server-node/node_modules`：在干净副本通过现有 `run-node.mjs npm-ci` 按 `package-lock.json` 还原的完整依赖。

.NET 解决方案中五个项目全部保留。客户端和服务器的 Protocol 项目引用、GuiChecks 到 Client 的引用、ConnectionChecks 对 Networking 源码的链接均保留，已从副本成功构建。`server-node/scripts/check-csharp.js`、`check-smoke.js`、`check-enhanced-csharp.js` 导入 `test/helpers.js`，测试还会创建 resume / crash 等子进程，因此完整保留 `server-node/test` 代码及这些样本。

本轮检查了 `artifacts` 的用途和测试引用：旧二进制、验收运行目录、证书、临时数据库、迁移副本、私有备份、旧 ZIP 和下载对象均为可再生成或私有状态，没有构建必需输入。相关样本由保留的脚本生成，无须携带旧文件。保留本轮新入口验证的公开记录和截图；旧证据、报告草稿、私人附件、备份工具及旧报告打包流程留在原工作目录，新的源码包使用本轮导出工具。没有删除原工程的 `tests` 或 `artifacts`。

交付副本没有初始化后的 `runtime`，没有账户库、上传对象、CA 私钥、服务器私钥、客户端私钥、PFX 或原 `.git`。实际验证使用另建的 `artifacts/final-entry-check` 副本，其中的临时账户和证书不进入交付。

## Git 收尾与重新导出

以 `a1566bbe3b943ec42badf6a7b15ef77c501bac45` 为父提交，新增一次提交，标题为“增加启动入口、账户管理菜单并整理交付源码”。最新 Git 目录树与上述 115 个源码文件一致。121 个不在最终清单中的旧日志、历史资料和旧交付工具按逐文件清单执行 `git rm --cached`；本地原件及历史提交保留。`.gitignore` 仅补充已核对的历史路径和本地附件，不整体忽略 `tests`、`tools` 或 `docs`。

完整新增、修改和取消跟踪清单保存在原工程 `artifacts/git-final-20261125/reviewed-files.json`，对应的 `commit-reviewed.ps1` 会核对父提交、源码摘要、暂存内容及保留文件，再执行真实 Git 提交。若 Git 写入受阻，源码包明确标为待提交；脚本成功后根据实际新提交更新源码包和哈希。没有删除或重建 `.git`，没有更改历史提交，也不创建替代仓库。原验收文档中的未提交描述是先前阶段的记录，当前状态只以生成的 Git 元数据为准。

需要以后重新导出**另一份可运行交付**时，可继续使用现有工具；这不是本轮执行步骤：

在原工作目录执行（目标目录必须不存在）：

```powershell
python tools/export-release.py export --directory '交付/SFT-4.0.0-reexport/SFT-4.0.0'
```

之后从已验证的干净构建副本复制上述三个**完整生成目录**，不能复制其运行数据；或在新构建副本重建这些目录。最后封装：

```powershell
python tools/export-release.py seal --directory '交付/SFT-4.0.0-reexport/SFT-4.0.0' --output '交付/SFT-4.0.0-reexport'
python tools/export-release.py verify --directory '交付/SFT-4.0.0-reexport/SFT-4.0.0'
```

封装拒绝未列入白名单的文件、链接、运行私钥和数据库，校验 ZIP CRC 与所有源码摘要，不覆盖已有包。`DELIVERY-MANIFEST.json` 覆盖源码和额外运行文件；`FILELIST.txt` 是可读路径清单；`SHA256SUMS.txt` 覆盖交付文件、源码 ZIP、清单和 ZIP 单独校验文件（不包含它自己）。初始化或运行后生成的私有状态不属于这些交付哈希。

从纯源码 ZIP 重现时先准备 Node，再执行 `首次配置.cmd`。从可运行副本首次使用时仍须安装 OpenSSL 和 .NET Desktop Runtime 10，然后执行首次配置；本副本没有把这些系统依赖伪装成免安装运行环境。

本次源码包的 Git 结果以生成的 `SOURCE-MANIFEST.json` 和 `DELIVERY-MANIFEST.json` 为准。哈希核对仅用于确认交付文件与 Git 内容一致，不属于重新运行验收或业务测试。
