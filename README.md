# AI PDF/Word/PPT Reader (Tauri v2 架构重构版)

> **⚠️ 项目交接状态说明 (Handoff Status)**
>
> 本项目最初基于 Electron 开发，现已根据架构升级需求，整体迁移至 **Tauri v2 (Rust + React + Vite)** 架构。
> 当前包含极高保真度的本地 Office (Word/PPT) 转 PDF 渲染核心技术，但由于本地大模型集成与视觉模型集成部分尚未全部完成，特预留此说明文档，供下一位开发者接手。
>
> **本轮更新 (macOS + Google Cloud)**：
> - **跨平台转换**：Office→PDF 现已支持 macOS —— 后端按平台分支，macOS 依次尝试 LibreOffice(headless）→ Microsoft Word/PowerPoint（osascript）→ Pages/Keynote（osascript），运行时检测引擎，不强制安装。
> - **可用的多模型 AI Agent**：所有 LLM 调用改由 **Rust 后端 `llm_chat` 命令**（reqwest）发出，统一绕过 WebView 的 CORS/浏览器守卫，密钥不进前端包。已接入 **OpenAI / Gemini API / Vertex AI** 三家（Vertex 在 Rust 侧用服务账号 JSON 换取 OAuth token）。消息结构预留多模态图片入参，为后续 Gemini 视觉分析铺路。

## 🌟 核心愿景
打造一款纯本地化、极致轻量、高保真的全能文档阅读器。在左侧阅读文档的同时，右侧提供双开的 AI 智能体聊天窗口（全局摘要与选中文字深度分析）。

## 🛠️ 技术选型
- **前端 UI**: React 19 + TypeScript + Vite + Tailwind 风格 CSS
- **前端解析**: Mozilla `pdf.js` (负责将二进制 PDF 流精准绘制至 Canvas)
- **底层架构**: **Tauri v2** (利用底层的轻量级 WebView 替代了笨重的 Chromium)
- **系统接口 (Backend)**: **Rust** (接管系统级文件读取与子进程调用)

## 🔮 核心技术资产与黑科技揭秘 (接手必读)

本项目的核心难点在于：**如何在完全不依赖云端 API、且不使用昂贵的商业组件的情况下，实现 100% 格式还原的 Word 与 PPT 解析？**

开源界的纯 JS 解析器库（如 Mammoth）会丢失大量样式和排版。为此，本项目在后端直接调用了 Windows 原生的 **Office COM 组件** (Component Object Model)！

### 1. PowerShell 原生驱动 COM
我们编写了动态生成的 PowerShell 脚本，静默启动后端的 `Word.Application` 和 `PowerPoint.Application`，直接调用 `ExportAsFixedFormat` 或 `SaveAs` 接口，利用真正的 Office 引擎在临时文件夹中无损生成高保真 PDF，再将其二进制流回传给前端 `pdf.js` 渲染。

### 2. 致命的 Windows 编码陷阱 (The UTF-8 BOM Trap)
**（极度关键，请勿修改这部分 Rust 代码）**
在 Node.js 或 Rust 中直接把带有中文的路径通过参数传给 PowerShell，或者写入无 BOM 的 UTF-8 脚本文件时，由于 Windows 系统级 PowerShell (v5.1) 默认采用 ANSI (GBK) 编码读取，会导致中文字符瞬间乱码（比如将 `新建` 读取为 `鏂颁缓`），进而导致 Word COM 找不到文件而崩溃。

我们在 `src-tauri/src/lib.rs` 的转换逻辑中，手动向生成的 `.ps1` 文件头部注入了 **UTF-8 BOM (`\uFEFF` 即 `0xEF, 0xBB, 0xBF`)**。这强制 PowerShell 以标准 UTF-8 读取中文字符串，完美解决了 Windows 下臭名昭著的跨进程乱码崩溃问题。

## 🚀 未完成的任务 (TODOs)

- [x] **多模型云端 Agent（本轮完成）**: OpenAI 占位接口已替换为 Rust 后端 `llm_chat`，支持 OpenAI / Gemini / Vertex。
- [x] **跨平台适配（本轮完成）**: macOS 已支持 LibreOffice / Office / iWork 转换回退链；Windows COM 路径保留。
- [ ] **集成 Transformers.js (本地模型)**: 利用 `@xenova/transformers` 在端侧加载量化模型，作为纯离线 provider 接入 `agent.ts` 的 provider 抽象。
- [ ] **Vision API (视觉分析)**: 后端消息结构已预留 base64 图片入参（`ImagePart`），只需在前端把 PPT 图片/图表提取并随消息发出，即可用 Gemini 原生多模态识别。
- [ ] **打磨**: 密钥目前存于 `localStorage`（Vertex 服务账号 JSON 尤其敏感），建议迁移到更安全的存储；`DocumentViewer` 一次性渲染全部页，生产可改虚拟滚动。

## 📦 环境要求与运行指南

1. **安装 Rust 环境**: Tauri 依赖 Cargo 编译后端。请前往 [rust-lang.org](https://www.rust-lang.org/) 安装。
2. **安装 Node.js 环境**: 建议 v18+。
3. **初始化与运行**:
   ```bash
   # 1. 安装前端依赖
   npm install

   # 2. 启动开发服务器与 Tauri 调试窗口
   npm run tauri dev
   ```

4. **macOS 上的 Office 转换（可选依赖）**: 打开 `.docx/.pptx` 时后端会自动检测转换引擎。为获得最可靠的效果，建议安装 [LibreOffice](https://www.libreoffice.org/download/)（无需 Office 授权、可完全静默 headless 运行）；若未安装，则回退到 Microsoft Word/PowerPoint 或 Pages/Keynote 的 AppleScript 自动化（首次调用可能弹出 macOS「自动化」授权，需要放行一次）。纯 PDF 不需要任何转换引擎。

5. **AI 配置**: 顶部工具栏选择 provider（OpenAI / Gemini / Vertex）、填写模型 id 与密钥。Vertex 需填 GCP Project、Location 与服务账号 JSON。

祝你在本项目的基础上顺利推进！
