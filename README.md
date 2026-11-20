# DeepSeek Harness for VS Code

Run an installed DeepSeek Harness from a dedicated VS Code chat view using ACP v1. Open a trusted project folder and select **DeepSeek Harness** in the Activity Bar. Use **Start a conversation**, or right-click selected editor text and choose **Add Selection to Harness Chat**. The attachment captures the current buffer, including edits you have yet to save. Review it and press **Send**.

## Install

Paste a copied image or screenshot into the message input with Cmd+V (Ctrl+V on Windows/Linux). A paste can contain up to 32 images totaling 8 MiB. Clipboard images sent as local file links stay in extension storage for the conversation.

Use **Attach files** below the message input to select one or more files. Each attachment shows its size and delivery mode. Click its name to open the source file, or × to remove it. Send files on their own or with a message.

The extension captures UTF-8 text up to 256 KiB per file and can send PNG, JPEG, GIF and WebP images when the ACP connection supports them. A draft can include up to 8 MiB of inline files. Other files, including PDFs, larger files and images on text-only connections, appear as **Local file link**. Keep the source available so Harness can read it.

Type `/` in an empty message to list commands. Filter by typing, move with the arrow keys, complete with Tab or Enter, and dismiss with Escape. Submit the completed command with Send or your send shortcut. Use `/new`, `/clear`, `/settings` or `/diagnostics` for sidebar actions. When the session offers these options, `/model ` and `/reasoning ` suggest their available values.

Select text in a chat message to add a quotation to the current draft or focus the composer to ask about it. In source files, both actions are available from the context menu and Quick Fix. Send the draft when ready.

**Interface language** at the top of Harness Settings switches the chat and settings pages immediately between English and Simplified Chinese, or follows VS Code. VS Code controls the language of native command and view titles.

The gear opens a settings page inside the sidebar. Choose the default provider and model, or select **Follow ACP configuration**, then click **Save default**. Start one conversation to populate the catalog on first use. This preference applies across projects to new conversations in this extension. **Back to chat** returns to the current conversation and draft.

Under **Harness Settings → Message input**, **Send with Enter** is enabled by default. Shift+Enter inserts a new line. Turn the option off to use Enter for new lines too. Cmd+Enter (Ctrl+Enter on Windows/Linux) is the existing configurable send command; Escape stops a running task. The settings page also provides runtime selection, the ACP profile and diagnostics. A path change applies on the next connection.

Install DeepSeek Harness and configure a working model in its `acp` profile. Search for `SivanLiu.deepseek-harness-acp` in your extension marketplace. For offline installation, run **Extensions: Install from VSIX…** and select the packaged artifact. The extension discovers `dsh` on the workspace host's PATH and checks the common macOS install locations. Set `deepseekHarness.executablePath` to an absolute executable path if discovery fails.

Tool cards display the information sent by Harness. When its permission policy requests a decision, choose **Allow once** or **Reject**. Review changed files in VS Code Source Control. The conversation selector lists resumable Harness sessions for the chosen folder. VS Code keeps its own displayed message history in workspace storage. Use **Clear local chat history** to remove this copy. Harness retains its own session.

VS Code desktop and a trusted filesystem workspace are required. The verified runtime versions are listed in the acceptance record.

## Develop

`npm ci` installs the pinned dependencies. Run `npm test` for protocol and history checks. Run `npm run package` to build the extension and produce the VSIX under `artifacts/`. Run `npm run test:ui` after packaging to install and test the artifact in an isolated copy of the macOS VS Code profile.

The VSIX also includes the Simplified Chinese guide in `README.zh-CN.md`.
