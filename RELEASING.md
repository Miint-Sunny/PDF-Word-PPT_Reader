# 发版流程 (Releasing)

每个版本的发布走同一条流水线,人只需要说一句"出 vX.Y.Z"。

## 流程

1. **版本号三处同步**:`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的 `version` 改为同一号(不带 `v` 前缀)。
2. **更新 release note**:重写 `.github/RELEASE_NOTES.md` 为本版内容(它就是 release 正文;历史版本的文案留在 GitHub Releases 里,此文件只保留当前版)。可从 `git log <上个tag>..HEAD --oneline` 汇总变更。
3. **提交并打标签**:
   ```bash
   git add -A && git commit -m "release: vX.Y.Z"
   git push origin main
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
4. **CI 自动构建**(`.github/workflows/release.yml`):
   - macOS 通用二进制(Apple Silicon + Intel):`dmg` + `.app.tar.gz`
   - Windows x64:NSIS `setup.exe`(自动装 WebView2)+ 免安装 `portable.zip`
   - 产物自动挂到**草稿 release**,正文取自 `RELEASE_NOTES.md`
5. **人工检查草稿 → 点 Publish** 才对外可见。

## 备注

- 手动测试构建:Actions → Release → Run workflow(只出产物、不建 release,产物版本号为 `dev-<sha>`)。
- 应用未做签名/公证;macOS 用户首次右键→打开,Windows SmartScreen 需点"仍要运行"。
- 打错标签回滚:`git push origin :refs/tags/vX.Y.Z` 删远端标签,删掉草稿 release 即可重来。
