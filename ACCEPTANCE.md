# 本机验收

## 0.7.0

在真实 Harness 会话中验证了已打包的 VSIX。选中未保存的编辑器代码后，可从 VS Code 快捷修复添加选区，再从编辑器右键菜单提问并聚焦输入框。选中回复里的文字后，浮动工具条的两个按钮均可用。依次点击两个操作后，引用仅出现一次，草稿保持完整，按发送后才在原会话产生新的用户消息。

## 0.6.0

本机 VS Code 安装版本与发布包均为 0.6.0，已核对扩展宿主和 Webview 脚本。安装包界面测试在输入框按 Shift+Enter 生成两行文本，再按 Enter 发送；真实 Harness 收到完整消息并回复。模拟 IME 组词期间按 Enter 未提交消息。

设置页以中英文展示发送开关和换行组合键。关闭回车发送并重载窗口后，Enter 在输入框换行，⌘Enter 仍可发送。八项自动化测试、测试 Agent 界面流程、真实模型会话恢复和 VSIX 完整性检查通过。

## 0.5.0

本机 VS Code 已安装开发构建 `0.5.0`。从 VSIX 启动的隔离 VS Code 完成了以下检查：

- 齿轮在侧栏内打开设置；选择简体中文、English 和跟随 VS Code 后，设置控件与对话界面即时切换。
- 在英文 VS Code 中选择简体中文，重载窗口后仍显示中文；切回跟随模式后恢复英文。切换期间保留未发送草稿、选区附件及待保存的模型选择。
- 实点 dsh 选择、自动查找、ACP 配置、快捷键和诊断入口。真实 Harness 会话验证了模型回复、默认模型保存以及历史会话恢复。
- 八项自动化测试与 VSIX ZIP 完整性检查通过。

## 0.3.0

在本机 VS Code 1.147.0 安装并确认开发构建 `0.3.0`。相同 VSIX 在隔离的 VS Code 用户目录和临时工作区连接本机真实 dsh 0.2.2-rc.5。测试使用 DeepSeek 账号模型，插件偏好保存在测试用户目录。

- 从齿轮菜单选择 **DeepSeek Account → DeepSeek-V4-Pro**。当前会话继续使用原模型，重载后恢复同一会话仍保留原模型。
- 新建会话得到已保存的 Pro 选项，发送消息后收到真实回复 `DEFAULT_OK`。
- 切回 **跟随 ACP 配置**，已打开的 Pro 会话继续使用 Pro。下一次新建会话采用 profile 的 `deepseek-account / deepseek-flash`。从会话列表再次恢复 Pro 会话时仍选中 Pro，并显示原回复。
- 七项测试通过，包括同名模型的供应商区分、跟随 ACP 配置，以及对下架选项和服务端未确认切换的处理。VSIX ZIP 校验通过。

## 0.2.0

macOS arm64、VS Code 1.147.0、dsh 0.2.2-rc.5。本机扩展列表已确认安装开发构建 `0.2.0`。

- 使用已打包的 VSIX 实点标题栏齿轮，验证了选择 dsh、恢复自动查找、打开 ACP 配置、打开诊断及进入扩展快捷键列表。
- 输入框内用默认 ⌘Enter 发送，并在测试用户配置中绑定 F7 后再次成功发送。运行中的测试任务通过 Esc 停止。
- 测试 Agent 返回模型认证 401 后，从错误提示打开 ACP 配置，并验证重新连接会创建新会话。
- 使用本机 ACP profile 与真实模型验证未保存选区发送，以及窗口重载后恢复原会话继续对话。
- `DSH_TEST_REAL=1 npm test` 四项通过，VSIX 压缩包完整性检查通过。

## 0.1.0

在 macOS arm64 上使用 VS Code 1.147.0 和 DeepSeek Harness 0.2.2-rc.5。安装测试使用独立的 VS Code 用户数据和扩展目录。真实 Harness 测试使用临时工作区和独立的 `DSH_HOME`。

| 项目 | 结果 |
|---|---|
| `npm run package` 与 VSIX ZIP 校验 | 通过。产物包含 manifest 声明的入口、侧栏资源、中英文文案和第三方许可证声明。 |
| `DSH_TEST_REAL=1 npm test` | 4 项通过。覆盖 ACP 握手、跨进程会话恢复、审批与取消、意外退出、本地历史和 Webview 消息校验。 |
| `npm run test:ui` | 已安装的 VSIX 通过测试 Agent 验证可执行文件错误恢复、未保存选区发送、模型切换、允许与拒绝审批、停止及重载后的继续对话。 |
| `DSH_UI_REAL=1 npm run test:ui` | 已安装的 VSIX 连接真实 Harness，创建会话，读取模型选项，并在重载窗口后恢复同一个会话。 |
| 初次真实模型验证 | ACP 默认的 `deepseek-official` 路由收到 API Key 认证拒绝。 |
| 本机 ACP profile 重测 | 将 ACP 默认路由设为 `deepseek-account / deepseek-flash`，复用本机 DeepSeek 登录态。真实 ACP 调用返回 `READY`。 |
| VSIX 真实模型回归 | 在隔离 VS Code 和临时工作区中，模型复述了尚未保存的编辑器选区，重载窗口后在原会话中回复了 `RESUMED`。 |
| VSIX 真实工具审批 | 在只读沙箱中，两个 Bash 写入请求均在审批前保持目标文件不存在。点击 **拒绝** 后文件仍不存在。点击 **允许一次** 后，另一个文件写入了精确内容 `ACP_APPROVAL_OK`。 |

复测时，使用 `DSH_UI_HARNESS_HOME` 指定已有可用认证的临时 Harness 配置目录，并设置 `DSH_UI_REAL=1 DSH_TEST_MODEL=1 DSH_TEST_APPROVAL=1` 后运行 `npm run test:ui`。审批用例在测试进程中启用只读沙箱，写入目标位于临时工作区。
