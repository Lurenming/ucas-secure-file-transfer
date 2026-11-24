# EX1B 交付与恢复操作

> 本文保留P5交付历史。增强版当前状态见 [运行与验证指南](enhancements.md)，GUI需要重新验收，`submission-info.json`已将当前GUI验收标为false并单独保存历史摘要。当前源码包不等于最终课程作业包。

目前是**GUI 已验收、正式材料未齐备的候选包**，不是完整课程交付。2026-11-24 用户确认26项必做及A04通过，共27项；D05条件性未覆盖，自动模拟证据单列。姓名、学号、真实Git URL、MP4和正式PDF/DOCX仍缺失；不创建空文件占位冒充完成。逐项结果见 [验收记录](evidence/gui-20261124.md)，当前核对见 [交付收尾](delivery-closure.md)。代码开源/远端记录由用户后续真实完成，本轮不推送、不公开、不代提交。

P5独立复现和当前命令见 [p5.md](p5.md)。当前收尾候选路径为 `artifacts/delivery/GUI-ACCEPTED-CANDIDATE-20261124.zip`，整体校验值见同名 `.sha256` 及 `closure-result.json`。`P5-CANDIDATE-final.zip` 和此前P4候选保留为历史，不将新的GUI修复、截图或用户反馈倒写进P5自动复现结果。最终候选与实际验证的RC归档对应关系、源码哈希比对见P5证据。

运行前置为Windows x64、便携Node 22.23.5（自带npm10.9.9）、支持net10.0/windows的.NET SDK及目标包、已有OpenSSL命令；打包/复现工具另需Python3.11+，源码目录中的打包工具还需已有Git仓库。依赖还原需要访问npm及必要的NuGet源，不是完全无环境依赖。

```powershell
$Node = 'D:\UCAS\软件与系统安全\lab1-tools\node-v22.23.5-win-x64\node.exe'
# 在解压源码根目录运行，不能借用原工程node_modules/bin/obj：
& $Node .\tools\run-node.mjs npm-ci
& $Node .\tools\run-node.mjs build
& $Node .\tools\run-node.mjs certs
& $Node .\tools\run-node.mjs smoke
& $Node .\tools\run-node.mjs backend
& $Node .\tools\run-node.mjs csharp
```

启动/health/交互账户创建也必须通过同一工具；它显式调用便携Node和npm、为子进程设置本次PATH及运行时校验，不改变全局PATH。不要以裸npm start录屏后声称已使用新版。该工具是直接运行的JavaScript，不依赖调整PowerShell执行策略。完整自动新目录复现使用 `python tools/reproduce.py --archive 候选ZIP --destination 项目外全新目录 --node 便携node.exe`。

## 课程命名

已查看本地课件第2/3/33/36页，核对截止为北京时间 **2026-11-24 23:55**；提交课程网站，**ZIP且不加密**，不是rar/7z。1B结构为：

```text
姓名_学号_EX1B/
  姓名_学号_ex1B_src/               源码目录
  姓名_学号_ex1B_play.mp4           真实演示视频
  姓名_学号_ex1B_report.pdf         或 .docx，写入真实Git链接
```

注意EX1B目录名大写、ex1B文件名大小写与课件一致。课件说无需README，说明放进报告；源码内仍保留开发/验证文档。GitHub/Gitee/GitLab须有真实记录，允许提交后再公开；本轮没有替用户选择开源许可或声称仓库已公开。

## 候选包（现在可执行）

```powershell
Set-Location 'D:\UCAS\软件与系统安全\lab1'
python .\tools\delivery.py candidate
```

默认输出到被忽略的 `artifacts/delivery`，文件名带CANDIDATE及UTC时间。目录和名称暂用 `submission-info.json` 的明确占位符；包含源码、已审阅的人工反馈/截图/日志证据、展开协议图源的Markdown报告草稿、交付状态JSON。GUI状态按真实确认更新为完成，D05条件例外仍明列；其他缺项继续阻止final。没有MP4/PDF/DOCX就不生成这些伪文件。不要把CANDIDATE直接当最终作业上传。

P4历史候选包为 `artifacts/delivery/姓名待填写_学号待填写_EX1B_CANDIDATE.zip`；整体SHA-256见同名 `.zip.sha256`，旧生成结果在 `artifacts/delivery/p4-candidate-result.json`。当前使用本文开头的收尾候选；P5归档及哈希保持不变。使用 `--output 新ZIP路径` 可指定名称，脚本拒绝覆盖已有归档。

源码白名单覆盖当前工作区的被跟踪与新增未跟踪源码、配置、锁文件、测试和文档，**不只导出HEAD**。拒绝链接/重解析源路径，扫描PEM私钥块；排除.git、依赖、bin/obj、artifacts、环境秘密、证书/私钥、SQLite/WAL/SHM、上传/下载数据和课程PDF。截图仅放行tools/delivery.py中列明的5个已审阅图片路径，不任意打包图片目录；用户原始反馈和证据副本的哈希清单见docs/evidence/manual-20261124。白名单不能替代作者对源码中普通文本秘密的人工复核，后续添加文件时仍须审查。

每个ZIP带SOURCE-MANIFEST.json，记录源文件路径/长度/SHA-256、实际HEAD、Git工作区状态和生成时间。ZIP重新读取验证CRC、无加密标志、所有源文件哈希及无额外成员；整体再生成SHA-256旁文件。打包工具仅用Python标准库，不要求PDF依赖、Node依赖或大型导出工具。

```powershell
python .\tools\delivery.py verify --archive '候选或P4快照ZIP的实际路径'
Get-FileHash -LiteralPath 'ZIP实际路径' -Algorithm SHA256
python -m unittest discover -s tools/tests -v
```

旧P2/P3快照的manifest格式不同，请按其ZIP内SNAPSHOT-README及清单验证，不能套用新脚本的SOURCE-MANIFEST格式。

## 最终包（缺项时脚本明确失败）

GUI本次已按27/1确认完成；补齐录制及正式材料后，在报告填实际信息，渲染Mermaid、加入真实截图，导出非空PDF或DOCX；人工播放MP4，按 [demo-script.md](demo-script.md) 核对覆盖编译/部署/测试全过程。submission-info.json的guiAcceptanceCompleted现据实为true，并附27/1范围；reportReviewed和videoReviewed仍为false。只有实际审阅完成才更新对应标志，不能为通过脚本随意改值。

恢复正常Git写入后审阅并显式提交累计源码；不要盲目git add -A。配置真实远端、由用户授权并完成推送/公开要求，报告填真实URL。本轮脚本不会提交、推送或联系远端，也不验证远端真实历史/可访问性；这是必须另外人工核对的交付条件。

```powershell
python .\tools\delivery.py final --report '已审阅报告.pdf' --video '已录制演示.mp4'
```

final模式要求无占位信息、review标志、源码均已本地提交、配置远端、真实报告/视频文件；检查PDF/DOCX结构和ffprobe视频流/时长（需已有ffprobe，不自动安装）。这些检查不能证明报告内容、GUI操作、视频真实性或远端公开情况，操作者仍须审阅。候选包不会包含未提供的视频。源码和最终材料按课件命名，ZIP不加密，最后由用户提交。

## 内部恢复备份

旧P2/P3快照已保留原件并复制至 `D:\UCAS\软件与系统安全\lab1-backups`，来源/时间/长度/SHA-256见p4.md和该目录的备份验证JSON。

```powershell
python .\tools\delivery.py snapshot --output 'D:\UCAS\软件与系统安全\lab1-backups\P4-workingtree-新的时间.zip'
```

这是内部源码恢复快照，包含工作区状态但**不含Git对象历史或运行秘密**，不等于本地提交。恢复先解压到新的空目录，核对清单，然后人工比较合并，不直接覆盖当前工程；npm ci/dotnet build重建依赖与产物。真实账户/上传数据/证书需另按用户私密备份策略处理，本轮未复制它们。

当前权限配置对工程外写入可能要求运行环境授权；若拒绝，记录失败并保留工作区，不改ACL、不删锁、不重建.git。不要把源码备份当最终提交包，也不要把运行数据为“方便复现”放进开源仓库。
