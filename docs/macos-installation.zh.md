# macOS 首次启动授权指南

## 为什么 macOS 会阻止打开 OpenCodex？

OpenCodex 的 macOS 安装包没有使用 Apple Developer ID 证书签名，也没有经过 Apple 公证。

因此，从浏览器下载并首次打开 OpenCodex 时，macOS 可能显示以下提示：

> Apple 无法验证“OpenCodex.app”是否包含可能危害 Mac 安全或泄漏隐私的恶意软件。

这是 macOS Gatekeeper 的安全保护机制，并不表示系统已经检测到 OpenCodex 包含恶意软件，而是表示 Apple 无法验证其开发者身份和公证状态。

请只从本项目的 [GitHub Releases](/releases) 页面下载安装包。

## 推荐方法：在系统设置中允许打开

### 1. 安装应用

1. 下载与你的 Mac 架构对应的 DMG：
   - Apple Silicon（M1、M2、M3、M4 等）：`macos-arm64.dmg`
   - Intel Mac：`macos-x64.dmg`
2. 打开 DMG。
3. 将 `OpenCodex.app` 拖入“应用程序”文件夹。
4. 在“应用程序”中尝试打开 OpenCodex。

### 2. 关闭安全提示

macOS 显示无法验证应用的提示时，点击“完成”。

不要点击“移到废纸篓”。

### 3. 手动允许应用运行

1. 打开苹果菜单 。
2. 进入“系统设置”。
3. 点击“隐私与安全性”。
4. 向下滚动到“安全性”区域。
5. 找到有关 `OpenCodex.app` 被阻止的提示。
6. 点击“仍要打开”。
7. 根据提示使用登录密码或 Touch ID 确认。
8. 在再次出现的确认窗口中点击“打开”。

完成后，macOS 会将 OpenCodex 保存为安全性例外。通常后续可以直接打开，不需要重复操作。

> “仍要打开”按钮通常只会在尝试打开应用后的一小时内显示。如果没有看到该按钮，请再次尝试打开 OpenCodex，然后返回“隐私与安全性”页面。

## 备用方法：使用终端移除隔离标记

如果“隐私与安全性”中没有出现“仍要打开”，并且你已经确认安装包来自本项目的官方 GitHub Releases，可以打开“终端”并执行：

```bash
xattr -dr com.apple.quarantine "/Applications/OpenCodex.app"
open "/Applications/OpenCodex.app"
```

第一条命令只会移除 OpenCodex 的下载隔离标记，不会关闭整个 macOS Gatekeeper。

## 下载安全检查

执行手动授权前，请确认：

- 安装包来自 `github.com/RyensX/OpenCodex`。
- 下载链接位于本项目的 GitHub Releases 页面。
- 文件名和 Mac 架构正确。
- 文件的 SHA-256 与 GitHub Release 页面显示的摘要一致。

可以使用以下方法计算文件的 SHA-256：

1. 打开“终端”。
2. 输入 `shasum -a 256 `，注意命令末尾保留一个空格。
3. 将下载的 DMG 文件拖入终端窗口。
4. 按下回车键执行命令。
5. 将输出结果与 GitHub Release 页面中该文件旁边显示的 SHA-256 比较。

## 参考资料

有关 macOS Gatekeeper 和手动授权应用的更多信息，请参阅：

- [Apple：在 Mac 上安全地打开 App](https://support.apple.com/zh-cn/102445)
- [Apple：通过覆盖安全性设置来打开 App](https://support.apple.com/zh-cn/guide/mac-help/mh40617/mac)
