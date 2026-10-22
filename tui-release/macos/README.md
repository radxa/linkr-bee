# macOS 产物

这里放 macOS 的两份产物，由仓库的 GitHub Actions 工作流
`.github/workflows/linkr-tui.yml` 在 macOS 运行器上构建（当前这批来自发布 tag `v0.1.2`，与 Releases 页同名附件同一工作流；具体提交以发布页说明为准），
每种芯片各给两种打包格式（内容相同）：

- `linkr-bee-0.1.2-aarch64-apple-darwin.dmg` / `…-aarch64-apple-darwin.tar.gz`（Apple Silicon）
- `linkr-bee-0.1.2-x86_64-apple-darwin.dmg` / `…-x86_64-apple-darwin.tar.gz`（Intel）

校验和见上一级的 `SHA256SUMS`。

## 使用

按芯片选一份（M 系列用 `aarch64`，Intel 用 `x86_64`）。习惯做法是双击 `.dmg`，
把窗口里的 `bee` 拖到 `~/bin` 或 `/usr/local/bin`；只想拿文件就解压 `.tar.gz`：

```sh
open linkr-bee-0.1.2-aarch64-apple-darwin.dmg          # 或：tar xzf …-aarch64-apple-darwin.tar.gz
./bee --version                                  # 应输出 bee 0.1.2
./bee                                             # 启动界面
```

首次运行若被 Gatekeeper 拦下（"无法验证开发者"），在「访达」里右击 → 打开，
允许一次就行；包是从网上下载来的话 `xattr -d com.apple.quarantine bee`
去掉隔离标记即可（`.dmg` 上执行同理）。本项目未做代码签名与公证，
这是本地分发产物的正常提示，不是损坏。

## 自己构建

任意一台 Mac（先 `xcode-select --install` 装好命令行工具）：

```sh
cd linkr-bee/tools/linkr-tui
cargo build --release --locked
```

产物在 `target/release/bee`，直接运行即可。

---

整理：Novice-PG · 2026-10-21
