# dsh-vscode

通过 ACP v1 在 VS Code 侧栏使用已安装的 DeepSeek Harness。打开并信任项目文件夹，在活动栏点击 **dsh-vscode**，选择 **开始对话**。也可以在编辑器里选中文字，右键点击 **将选区加入 Harness 对话**。附件取自当前编辑器缓冲区，包含尚未保存的修改。确认附件和问题后点击 **发送**。

## 安装

复制图片或截图后，在聊天输入框按 ⌘V（Windows/Linux 为 Ctrl+V）即可添加图片附件。每次最多 32 张、合计 8 MiB。通过本地文件引用发送的剪贴板图片从最后一次作为附件使用起保留 30 天，扩展在启动时清理过期图片。

点击输入框下方的 **添加附件** 可一次选择多个文件。附件旁会显示大小和发送方式，点文件名可在编辑器中打开，点 × 移除。可以只发附件，也可以和问题、代码选区或对话引用一起发送。

扩展在选择时读取最多 256 KiB 的 UTF-8 文本。ACP 连接支持图片输入时，PNG、JPEG、GIF 和 WebP 可随消息发送。每份草稿最多内嵌 8 MiB 的文件内容。PDF、其他二进制文件、超出内嵌额度的文件，以及连接不支持的图片，会标为 **本地文件引用**，Harness 可按路径读取。发送引用时需保留原文件。

1. 安装 DeepSeek Harness，并为 `acp` profile 配置可用模型和凭据。
2. 在扩展市场搜索 **dsh-vscode-mini**，扩展 ID 为 `SivanLiu.dsh-vscode-sivan`。离线安装时，在命令面板运行 **从 VSIX 安装**，选择 `artifacts/dsh-vscode-sivan-<版本>.vsix`。
3. 扩展从工作区宿主的 PATH 和 macOS 常见安装位置查找 `dsh`。找不到时，点击侧栏的 **选择 dsh 可执行文件**，或在用户设置填写 `deepseekHarness.executablePath` 的绝对路径。macOS 应用安装的常见路径为 `/usr/local/bin/dsh`。

在 **Harness 设置 → 消息输入** 中，**按 Enter 发送消息** 默认开启，Shift+Enter 在光标处换行。关闭此项后，单按 Enter 也会换行。⌘Enter（Windows/Linux 为 Ctrl+Enter）仍可发送，Esc 可停止运行中的任务；这两个命令可以在 **配置快捷键** 中改绑。设置页也可选择 dsh、打开 ACP 配置和查看诊断。可执行文件在下次连接时生效。

在空输入框键入 `/` 查看命令，继续输入可筛选。用 ↑↓ 选择，Tab 或 Enter 补全，Esc 收起。点击发送或使用发送快捷键执行命令。`/new` 新建会话，`/clear` 确认后清除当前会话的本地记录，`/settings` 打开设置，`/diagnostics` 查看诊断。当前会话提供相应选项时，输入 `/model ` 或 `/reasoning ` 可选择模型或推理强度。

Harness 请求工具权限时，侧栏提供 **允许一次** 和 **拒绝**。需要中断任务时点击 **停止**。如果 Harness 在 10 秒内未完成取消，扩展会关闭连接并显示 **重新连接**。文件改动可在 VS Code 的源代码管理视图查看。模型和推理强度选项取决于当前会话返回的配置。

会话列表来自 Harness。扩展把已经显示的消息和工具详情保存在 VS Code 的工作区存储中，重载后可接着对话。**清除本地对话记录**删除扩展保存的副本，Harness 自己的历史依照其配置保存。来自其他客户端的会话可以继续对话，扩展只能显示自己收到的消息。

首版通过桌面 VS Code 的 Node.js 扩展宿主运行。已验收的环境与测试结果见验收记录。

## 选区快捷操作

选中一条聊天消息中的文字，点击选区旁的 **添加到对话** 或 **在侧边聊天中提问**。前者把引用加入草稿，后者还会聚焦当前输入框。选中编辑器代码后，可在右键菜单或快捷修复（macOS 为 ⌘.，Windows/Linux 为 Ctrl+.）使用相应操作。

## 语言与默认模型

设置页顶部的 **界面语言** 支持跟随 VS Code、简体中文和 English。选择后对话侧栏与设置页即时切换，重载后保留偏好。VS Code 原生命令名称和视图标题使用编辑器的显示语言。

点击侧栏齿轮进入扩展内的 **Harness 设置** 页面。在 **新会话默认供应商和模型** 中选择供应商和模型，然后点击 **保存默认值**。首次使用时先开始一次对话以读取目录。此偏好作用于以后创建的会话；恢复历史会话时沿用会话自己的模型。选择 **跟随 ACP 配置** 并保存即可恢复使用 profile 默认值。点击 **返回对话** 可继续编辑原草稿。

## 本地开发

`npm ci` 安装锁定的依赖。运行 `npm test` 验证协议和历史记录，运行 `npm run package` 生成 VSIX。打包后运行 `npm run test:ui`，在隔离的 macOS VS Code 用户目录里验证安装后的扩展。

## 发布

将 `package.json`、`package-lock.json` 和 `CHANGELOG.md` 更新到同一版本并推送到 `main`，再创建并推送对应的 `vX.Y.Z` tag。Release 工作流会检出 tag、运行测试、打包并验证 VSIX，然后通过 Trusted Publishing 将同一份包发送到 VS Code Marketplace 和 Open VSX。两边上传成功后，工作流会创建附带 VSIX 的 GitHub Release。

新扩展 ID 的首版使用 `v0.0.1-dsh-vscode-sivan`，其 VSIX 版本为正式版 `0.0.1`。一般版本使用 `vX.Y.Z`。

如需重试已有 tag，在 Actions 的 Release 工作流中选 `main`，在 `tag` 输入该 tag。Trusted Publishing 使用 `.github/workflows/release.yml` 和 `marketplaces` 环境。Open VSX 需要先上传新扩展 ID 的首个版本，再为该扩展注册 Trusted Publisher。

只检查微软市场授权时，在 Actions 手动运行 Release 并勾选 `verify-vscode`。这个检查只交换短期凭据。
