# Image Caption Gallery

[English](README.md) | [简体中文](README.zh-CN.md)

一个快速、本地优先的 VS Code 图文数据工具，让你无需离开编辑器就能浏览图片数据集并编辑配套 Caption。

你可以把一个目录打开为可调节缩略图大小的 Gallery，点击任意图片后，在左侧查看图片、右侧阅读或编辑同名 `.txt` 文本。Caption 默认保持只读，并支持 Markdown、原始文本和格式化 JSON 三种显示方式。

## 界面预览

### Gallery 总览

<p align="center">
  <img src="https://raw.githubusercontent.com/Xingfu-Yi/vscode-image-caption-gallery/main/docs/images/gallery-overview.jpg" alt="Image Caption Gallery 可调节图片数据集 Gallery 总览" width="100%">
</p>

### 图片与 Markdown Caption

<p align="center">
  <img src="https://raw.githubusercontent.com/Xingfu-Yi/vscode-image-caption-gallery/main/docs/images/gallery-detail-zh.jpg" alt="Image Caption Gallery 中文 Markdown Caption 预览" width="100%">
</p>

### Caption 编辑状态

<p align="center">
  <img src="https://raw.githubusercontent.com/Xingfu-Yi/vscode-image-caption-gallery/main/docs/images/gallery-detail-en.jpg" alt="Image Caption Gallery 同名 TXT Caption 编辑与保存界面" width="100%">
</p>

## 主要功能

- 从 VS Code 资源管理器右键打开图片目录或当前选中的图片。
- macOS 使用 `Command+Option+G`（`⌘⌥G`），Windows/Linux 使用 `Ctrl+Alt+G` 快速启动。
- 递归发现 `.jpg`、`.jpeg`、`.png`、`.webp`、`.gif`、`.bmp` 和 `.avif` 图片。
- 将 Gallery 缩略图大小从 96 px 连续调整到 480 px。
- 按文件名或相对路径搜索图片。
- 显式进入 Edit 模式后，可编辑已有的同名 `.txt` Caption，也可新建缺失的 Caption。
- 默认使用 Markdown 渲染，也可切换为 Raw 原始文本或格式化 JSON。
- 使用 `Command+S` / `Ctrl+S` 保存，使用 `Escape` 取消编辑。
- 草稿未保存时，切图、返回 Gallery 或隐藏 Text 都会先询问保存、放弃还是继续编辑。
- 保存前检查文件是否被外部程序修改，可选择覆盖、重新载入或继续编辑。
- 更新已有文件时尽量保留 UTF-8 BOM 与 LF/CRLF 换行格式。
- 拖动中间分隔线，自由调整 Image 与 Text 两栏宽度。
- 一键隐藏 Text 栏，进入全宽纯图片模式；使用紧凑的 **Text ‹** 按钮恢复。
- 图片默认按当前可用宽度或高度完整显示，调整窗口或分隔线后会自动重新计算。
- 使用触控板捏合或 `Ctrl/Command + 滚轮` 将图片缩放到 25%–400%。
- 放大后可用鼠标拖动或双指滑动查看细节，双击图片恢复默认完整视图。
- 在顶栏以“宽 × 高”显示原图分辨率，两个数字右对齐并各自预留四位宽度。
- 使用紧凑下拉框将 Caption 字体缩放到 70%–180%。
- 使用 `←` / `→` 键或图片两侧的半透明按钮切换图片。
- 使用 `Escape` 返回 Gallery，并保留搜索条件和缩略图状态。
- 支持本地工作区和 VS Code Remote SSH。

## 安装

直接从 VS Code Marketplace 安装：

```bash
code --install-extension xingfu-yi.image-caption-gallery --force
```

也可以从 [GitHub Releases](https://github.com/Xingfu-Yi/vscode-image-caption-gallery/releases) 下载最新的 `.vsix` 文件，然后在 VS Code 命令面板中运行 **Extensions: Install from VSIX...**。

使用 Remote SSH 时，需要把插件安装到远程扩展主机。如果在远程终端运行安装命令，请先把 `.vsix` 复制到服务器，并使用服务器上的文件路径。

## 使用方法

1. 在 VS Code 中打开包含图片和 Caption 的目录。
2. 在资源管理器中右键点击图片或目录，选择 **Image Caption Gallery**；也可以选中图片后直接按启动快捷键。
3. 在 Gallery 中调整缩略图大小或搜索图片。
4. 点击图片，进入左侧 Image、右侧 Text 的并排预览界面。
5. 点击 **Edit** 编辑 Caption；用 `Command+S` / `Ctrl+S` 或勾号保存，用 `Escape` 或叉号取消。

如果同名 `.txt` 不存在，Edit 会打开一个空白草稿，保存时自动创建 UTF-8 文件。如果编辑期间文件被其他程序修改，插件会询问是覆盖、重新载入外部版本，还是继续保留当前草稿。

### 快捷键

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 打开 Image Caption Gallery | `Command+Option+G`（`⌘⌥G`） | `Ctrl+Alt+G` |
| 编辑时保存 Caption | `Command+S` | `Ctrl+S` |
| 取消 Caption 编辑 | `Escape` | `Escape` |
| 上一张 / 下一张图片 | `←` / `→` | `←` / `→` |
| 缩放图片 | 触控板捏合或 `Command + 滚轮` | 触控板捏合或 `Ctrl + 滚轮` |
| 平移放大后的图片 | 拖动或双指滑动 | 拖动或双指滑动 |
| 恢复图片视图 | 双击图片 | 双击图片 |
| 返回 Gallery | `Escape` | `Escape` |

## 数据集目录格式

Caption 文件需要与图片使用相同的主文件名：

```text
dataset/
├── image-001.jpg
├── image-001.txt
├── image-002.png
└── image-002.txt
```

## 兼容性

- Visual Studio Code 1.85.0 及以上版本。
- 支持本地工作区和 VS Code Remote SSH。
- 无原生运行时依赖，VSIX 安装包不区分操作系统平台。

## 隐私

Image Caption Gallery 只在你明确保存时直接读写当前工作区中的 Caption，不会上传数据集文件，也不包含遥测功能。

## 本地开发

```bash
npm install
npm run compile
```

使用 VS Code 打开本仓库并按 `F5`，即可启动 Extension Development Host。

## 后续计划

- 为超大型数据集提供虚拟化渲染。
- 支持更多可配置的 Caption 与元数据文件命名方式。
- 提供更丰富的排序和筛选能力。
- 增加图片元数据和数据集质量检查工具。

## 参与贡献

欢迎提交 Issue 和 Pull Request。请尽量保持改动范围清晰，并说明在本地与 Remote SSH 环境中的测试方式。

## 开源协议

[MIT](LICENSE)
