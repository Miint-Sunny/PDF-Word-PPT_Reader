# AI Document Reader v0.1.1 — 首个公开版本 🎉

本地优先的 AI 文档阅读器:左侧读 **PDF / Word / PPT**,右侧**双 AI 聊天**——Chat 1 管全局摘要,Chat 2 管细节追问(自动携带你选中的原文和 Chat 1 的上下文)。基于 **Tauri v2(Rust + React)**,轻量、快、不臃肿。

## ✨ 亮点

**📄 阅读**
- 高保真 Office→PDF:Windows 直接驱动原生 Office;macOS 依次调用 LibreOffice → Word/PowerPoint → Pages/Keynote(运行时自动检测,装哪个用哪个)
- 大文档虚拟渲染不卡顿;缩放/适配宽度/页码跳转/文档内搜索高亮
- 拖一个文件进窗口就能打开

**🤖 AI 双聊天**
- 多模型任选:**OpenAI / Gemini / Vertex AI / 本地离线模型**(Transformers.js,免 Key 可用)
- 流式逐字回复、Markdown 渲染、中途停止、逐条复制、一键导出 Markdown
- 对话按文档记忆,重开不丢
- 🖼 **视觉模式**:把当前页截图发给多模态模型,图表也能问
- **长文档本地 RAG**(设置中开启):本地向量检索相关片段,不再粗暴截断,且**不消耗云端额度**
- **打开自动摘要**(设置中开启):所有会自动消耗 AI 额度的功能**默认关闭**,不会背着你花钱

**🔒 安全与体验**
- API Key 与 GCP 服务账号凭据存**系统钥匙串**,绝不落明文
- 所有网络请求走 Rust 后端,密钥不进前端
- 亮/暗双主题、三栏可拖拽、macOS 26 风格图标

## 📦 下载

| 平台 | 文件 | 说明 |
|---|---|---|
| macOS(Apple Silicon + Intel 通用) | `*_macos-universal.dmg` | 打开后拖入「应用程序」 |
| macOS 免安装 | `*_macos-universal.app.tar.gz` | 解压即用 |
| Windows 10/11(x64)**推荐** | `*_windows-x64-setup.exe` | 安装器,会自动安装缺失的 WebView2 |
| Windows 免安装 | `*_windows-x64-portable.zip` | 解压直接运行 exe(需系统已有 WebView2) |

## ⚠️ 安装提示

- **macOS**:应用暂未签名/公证,首次启动请**右键 → 打开**;若被隔离可执行
  `xattr -dr com.apple.quarantine "/Applications/AI Document Reader.app"`
- **Windows**:推荐用 setup 安装器(缺 WebView2 时会自动装);便携版需系统已有 WebView2 Runtime(Win11 与新版 Win10 自带,缺失可装 [Microsoft Edge WebView2](https://developer.microsoft.com/microsoft-edge/webview2/))
- **Office 转换**:打开 Word/PPT 需要本机有转换引擎 — macOS 推荐装 [LibreOffice](https://www.libreoffice.org/download/)(有 MS Office 或 Pages/Keynote 也行,首次会弹一次自动化授权);Windows 需装有 Microsoft Office。纯 PDF 无需任何引擎
- **AI 使用**:云端模型请在右上角设置里选择提供方并填入自己的 API Key;本地模型免 Key,首次使用需联网下载模型权重

## 🔬 已知限制

- Gemini / Vertex 通道已接通但尚未大规模实测,遇到问题欢迎提 Issue
- 文档内搜索高亮暂限单文本段内匹配
- 本地模型上下文窗口小,适合离线/隐私场景,复杂问题请用云端模型
