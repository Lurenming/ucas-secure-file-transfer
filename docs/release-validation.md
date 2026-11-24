# 最终入口与干净交付验证（2026-11-25）

本轮验证范围是新双击入口、共同数据目录、普通 / VIP 管理和一次小文件往返。只修改入口、打包工具和说明，不更改传输业务代码，不重跑完整后端回归，不做压力测试。

实际执行了两个独立导出副本：`artifacts/final-entry-check/SFT clean copy` 用于依赖还原、发布和构建；`SFT desktop copy` 用当前桌面用户验证真实 GUI。初次在隔离工具身份下启动的 GUI 无法被桌面自动化发现，因此另建副本重做；未复用旧验收数据库、证书或旧客户端构建。

| 检查 | 实际结果 |
| --- | --- |
| `首次配置.cmd` | 成功；新测试 CA、服务器证书、独立数据目录；客户端 Release 发布成功 |
| `启动服务器.cmd` | 菜单选择密码模式成功监听；切换 mTLS 后同样启动，未带客户端证书的请求被 `ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED` 拒绝 |
| `启动客户端.cmd` | 实际启动副本 `publish/client` 的 GUI，自动填入当前副本的地址、端口和公共 CA；正常关闭后入口退出码 0 |
| `账户管理.cmd` | 菜单创建临时 `delivery_check`；两次密码均使用原 CLI 的不回显交互输入；菜单退出成功 |
| 普通 / VIP | 创建后查询为 `ordinary / 65536 / 65536`；设置 VIP 后通过菜单 2 查询为 `vip / 262144 / 262144`，单位均为字节/秒 |
| 同库验证 | 两种服务器模式与管理员入口均使用同一 `runtime/data`；模式切换后仍能查询到同一 VIP 账户 |
| 真实 GUI 登录 | 显示当前账户 `delivery_check` |
| 小文件往返 | `roundtrip-small.txt`，8225 字节；上传和下载都显示“完成”，原件与下载文件 SHA-256 完全相同 |
| 不覆盖 | 服务停止后对数据库、CA 私钥、服务器私钥、公共 CA 做前后摘要比较；重复初始化返回 1，四个文件均未改动 |
| 依赖提示 | 纯源码副本缺便携 Node 时明确给出准备命令并返回 1；没有创建运行目录 |
| 构建完整性 | 干净副本中整个解决方案的五个项目成功构建，0 警告、0 错误 |
| 源码和依赖 | 87 个原有业务与测试文件完整保留；100 个静态相对导入 / 项目引用均可解析；测试入口及业务文件与最终工作区源码逐字节一致 |
| Node / npm | 官方 ZIP SHA-256 正确，解出的 2032 个文件逐个与 ZIP 比对一致；服务器 `npm ci` 安装 66 个包，`npm ls --all` 成功，锁文件不变 |

往返文件 SHA-256：`f6c0f9ba37e2b3e5328e9889a99d517e820a420f9d5a1e88eb4c662d3c22a204`。实际上传文件 ID 为 `1029b6f1-0381-4844-a0cf-49a999ba91f6`。

证据：[结构化结果](evidence/release-entry-20261125/summary.json)、[实际完成截图](evidence/release-entry-20261125/gui-completed.jpg)、[界面文字](evidence/release-entry-20261125/gui-completed.txt)、[不覆盖检查](evidence/release-entry-20261125/no-overwrite.json)。没有将临时密码、账户库、上传对象、测试证书或任何私钥复制到交付目录。

验证期间发现并修复了包装脚本的 PowerShell 位置参数绑定问题，随后 `Cli info`、`Cli pki check runtime/certs --ip 127.0.0.1` 和 `Cli health` 参数转发均按预期工作。修改没有涉及任何认证、数据库或文件传输业务实现。

范围限制：本轮只验证本机回环，未重做完整 mTLS 客户端登录、吞吐测量、全量后端回归或压力测试。终端测试工具未产生可观察的 Ctrl+C 正常退出日志，测试服务在无传输活动后按已核对路径的本轮进程 ID 结束，不能将这一点记作“本轮验证了优雅停止”；原服务的 SIGINT 处理未修改。客户端正常关窗已实际验证。

## Git 与交付状态

原 Git 历史完整保留，当前真实 HEAD 为 `a1566bbe3b943ec42badf6a7b15ef77c501bac45`。本轮变更**尚未提交**：尝试仅暂存本轮指定文件时，Git 返回 `Unable to create '.git/index.lock': Permission denied`，当前工作区权限将 `.git` 限制为只读。没有删除或重建 `.git`，没有创建替代仓库或伪造提交。

最终包包含上述未提交工作区的真实文件；`SOURCE-MANIFEST.json` 明确记录 `sourceCommitted: false`、原 HEAD 和具体待提交源码文件，避免把包内新入口误称为已在原提交中。正式提交目录及校验方法见 [交付说明](delivery.md)。
