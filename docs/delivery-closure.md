# 2026-11-24 人工验收后的交付收尾

> 这是增强开发前的P5历史收尾记录，不代表新GUI已验收或业务仍冻结。增强版实际结果见 [运行与验证指南](enhancements.md) 和 [新人工验收](manual-enhanced.md)。

**当前为 GUI 已验收、正式材料未齐备的候选状态，尚不满足最终课程 ZIP 条件。** 26 项必做全部通过，A04 条件项通过，D05 条件性未覆盖；共 27 项通过、1 项条件性未覆盖。用户确认是本轮结论来源，不将文档更新写成再次操作 GUI。本轮业务源码保持冻结。

## 已整理的材料

- [最终人工记录](evidence/gui-20261124.md)：28 项逐项结果，日志/截图与仅“用户人工确认通过”分开；D05 自动模拟证据单列。
- [统一清单](gui-p2-p3.md) 及根目录 `SFT_Manual_Acceptance_P5.md` 已更新；[补录前清单](evidence/manual-20261124/checklist-before-closure.md) 和 [中途记录](evidence/manual-20261124/gui-in-progress-original.md) 保留原样。
- [报告草稿](report-draft.md)：补入最终人工结论、真实截图、D02 目录混用经过、早期 UI 卡顿修复及覆盖限制；协议仍只维护 [protocol.md](protocol.md)，打包时展开，不另造协议。
- [交付说明](delivery.md)、[录屏脚本](demo-script.md)：GUI 不再写为待验收；仍明确视频、正式报告及真实身份/Git资料的缺口。
- [证据目录](evidence/manual-20261124/evidence-manifest.json)：17 个原始证据副本，逐字节复制并核对大小/SHA-256；包括两张用户截图、原反馈、原准备清单和早期失败/复测记录。截图没有补画，用户原件没有覆盖。

D02 保留最初源文件混用：48017 字节上传的实际源位于 `lab1-manual-20261119-124555-87e0a880/sources`，与 `lab1-manual-20261124-184911-6749a0d8/sources` 下同名文件内容不同。8193 字节用唯一名称 `D02-8193-20261124-202228.bin` 新用例复核。用户确认最终六种边界和一个64 MiB文件的源/服务器/下载大小、SHA-256一致；本轮另做的9对源/下载只读复核见JSON，不冒充重读了服务器。

## 现有材料检查

| 必需材料 | 实际状态 | 剩余动作 |
| --- | --- | --- |
| GUI 人工验收 | 27 项通过、D05 条件性未覆盖，已归档 | D05 非必做阻塞项；以后有合适目录再另记，不改 ACL 强行制造 |
| 姓名、学号 | submission-info.json 仍为明确占位 | 用户提供真实值；不能从系统用户名或 Git 配置猜测 |
| 真实 Git 仓库链接 | 占位；git remote -v 无输出 | 提供真实 GitHub/Gitee/GitLab 项目 URL，并真实保存对应源码/历史；本轮无推送授权 |
| 正式 PDF/DOCX | 项目和长期备份目录中未找到正式报告；原课程 PDF 不是报告 | 补身份/链接，渲染协议图，导出并逐页审阅；已有文件请提供实际路径 |
| MP4 | 项目和长期备份目录中未找到实际 MP4 | 按录屏脚本录制/提供路径，实际播放检查；不能用截图或空文件替代 |
| ffprobe | 只读确认已有 `D:\Program Files\ffmpeg\ffmpeg-master-latest-win64-gpl-shared\bin\ffprobe.exe` | 没有视频输入，未执行视频内容/时长验证 |
| 最终课程 ZIP | 未生成 | 必需信息、真实报告/视频和 Git 条件满足后执行 final；由用户提交课程网站 |

搜索范围是项目与 `D:\UCAS\软件与系统安全\lab1-backups`，排除依赖、构建产物、证书和运行数据；不宣称搜遍整台电脑。本轮已询问缺少的姓名、学号、仓库URL及已有报告/视频路径，未擅自填写。

`guiAcceptanceCompleted=true` 依据用户本轮确认，并附27/1统计、D05理由及证据入口。`reportReviewed=false`、`videoReviewed=false` 保持不变。候选工具原先无条件输出“GUI pending”，现改为读取真实验收状态；只允许5个已审阅的截图路径进入源码证据，并修复展开报告移动到源码目录外后图片链接的相对路径。没有放宽正式包的缺项检查。

## 本轮检查与历史证据的区别

| 类别 | 命令或方法 | 实际结果 |
| --- | --- | --- |
| 已有文件只读复核 | `python artifacts/delivery-closure-20261124/collect_evidence.py`，流式SHA-256 | 退出0；17份复制一致，9对源/下载大小和摘要一致；没有读取账户库或重新传输 |
| 交付工具定向检查 | `python -m unittest discover -s tools/tests -v` | 退出0，5项通过；白名单、命名、ZIP校验/禁止覆盖、真实GUI状态、报告相对图片链接 |
| 已有构建日志核对 | 读取 `2026-11-24T10-47-32-787Z-build/result.json` 及 stdout.txt | 历史退出0、0警告0错误；本轮未执行构建 |
| P4/P5 后端及真实C# | 保留既有阶段记录和原日志 | 历史自动证据，未为更新验收记录重复运行 |
| 当前源码归档 | `python tools/delivery.py candidate --output artifacts/delivery/GUI-ACCEPTED-CANDIDATE-20261124.zip`，再用 verify | 实际生成与核验详情、整体SHA-256以同目录 closure-result.json 和 ZIP.sha256 为准 |
| final 缺项门禁 | 缺姓名学号/URL、真实报告/视频与Git条件时运行 final | 实际退出1，按预期拒绝，没有生成正式ZIP；缺项原文保存在收尾日志，不能改审核标志绕过 |

本轮日志和只读盘点位于 `artifacts/delivery-closure-20261124/`，正式包/候选/快照不是同一概念。候选清单包含当前工作区的新增源码、GUI进度修复和已审阅证据；P5历史ZIP与已有独立复现结果保持不变，不能宣称这个新候选又跑过整套P5复现。

当前恢复快照在 `artifacts/delivery/GUI-ACCEPTED-workingtree-20261124.zip`，含源码、文档与已审阅证据，不含运行秘密或Git对象。若项目外写入许可允许，另复制到 `D:\UCAS\软件与系统安全\lab1-backups`；是否实际复制成功及校验值以 `artifacts/delivery/closure-result.json` 为准，未获许可不绕过。恢复时解压到新的空目录，运行 delivery.py verify 核对清单，比较后再合并，不能直接覆盖当前工程。

## Git 与服务状态

实际 HEAD：`2aa0e325ba0d93f73265c7b96920d8b24c5ae3fa`，P1；P2/P3/P4/P5及GUI修复、当前文档累计未提交。普通权限执行 `git add -- submission-info.json` 退出1：

```text
fatal: Unable to create 'D:/UCAS/软件与系统安全/lab1/.git/index.lock': Permission denied
```

当前受管环境将 `.git` 设为只读；没有发现需删除的锁，也未修改权限、删锁、重建仓库或反复请求提权。未产生新提交，未配置远端、未推送或公开。正常可写环境下仍须审阅并显式提交，不盲目 `git add -A`，不把课程PDF、未知脚本、账户/私钥/上传数据收入提交。快照不能替代真实Git记录。

本轮没有启动或终止业务服务。收尾只读查询未见8443/8444监听；这是查询时的状态，不承诺用户后续操作后的状态。启动继续明确指定已验证便携运行时：

```powershell
Set-Location -LiteralPath 'D:\UCAS\软件与系统安全\lab1'
$sftNode = 'D:\UCAS\软件与系统安全\lab1-tools\node-v22.23.5-win-x64\node.exe'
& $sftNode .\tools\run-node.mjs start
# 另一个终端在相同目录定义 $sftNode 后：
& $sftNode .\tools\run-node.mjs health
```

## 最短剩余操作

1. 提供姓名、学号、真实仓库链接；若正式报告/MP4已有，提供其实际本机路径。
2. 基于已整理草稿导出并审阅PDF/DOCX，按已有录屏脚本录制并播放MP4，核对声音/画面/隐私；无需重做已确认的整套GUI验收。
3. 在正常允许写入的环境保存真实本地和远端Git记录，核对开源/访问要求。报告中写真实URL。
4. 材料审阅完成后再更新对应review标志，运行 `python tools/delivery.py final --report '实际报告.pdf' --video '实际视频.mp4'`，核验未加密ZIP并由用户提交课程网站。截止北京时间2026-11-24 23:55。
