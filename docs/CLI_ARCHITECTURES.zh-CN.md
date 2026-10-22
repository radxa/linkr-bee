# CLI / TUI：RISC-V 与 LoongArch64 支持评估

[项目介绍](../README.zh-CN.md) | [主机终端](../tools/linkr-tui/README.md)

评估日期：2026-10-20。代码基线：`ad254e8`（v0.1），依赖以
[`Cargo.lock`](../tools/linkr-tui/Cargo.lock) 为准。

结论：两个平台都具备移植基础，建议先完成 RISC-V，再验证 LoongArch64。
当前尚未完成这两个目标的完整编译、链接、运行或 BLE 真机测试，v0.1 也没有对应安装包。
这里的架构指运行 `bee` 的 Linux 主机；ESP32-C3 的固件是另一个构建目标。
`loong64` 指 LoongArch64，不涵盖早期采用 MIPS 指令集的龙芯平台。

## 平台与依赖

| 项目 | RISC-V 64 位 Linux | LoongArch64 Linux |
| --- | --- | --- |
| Rust target | `riscv64gc-unknown-linux-gnu` | `loongarch64-unknown-linux-gnu` |
| Rust 上游级别 | Tier 2 with Host Tools，提供标准库和本机构建工具 | Tier 2 with Host Tools，提供标准库和本机构建工具 |
| CPU / ABI | RV64GC，Linux GNU ABI | LP64D；当前 Rust 目标要求双精度浮点和 LSX |
| TLS 依赖 | AWS-LC 上游列有该目标的构建和测试 | 锁定版本的 AWS-LC 源码包含 LoongArch64 CPU 和随机数系统调用适配；上游测试表未列出该目标 |
| Linux 蓝牙 | BlueZ、D-Bus、可用的 BLE 控制器与权限 | 同左 |
| 项目发布状态 | 未进入 CI / 安装包矩阵 | 未进入 CI / 安装包矩阵 |

Rust 平台说明见 [RISC-V](https://doc.rust-lang.org/rustc/platform-support/riscv64gc-unknown-linux-gnu.html)
和 [LoongArch](https://doc.rust-lang.org/rustc/platform-support/loongarch-linux.html)。
LoongArch 官方 GNU 目标目前以 Linux 5.19、glibc 2.36 为基线；发行版兼容内核需按其实际
UAPI 判断。最终安装包的 glibc 下限还取决于构建 sysroot，应从生成的 ELF 中读取。

项目的 CLI 和 TUI 共用同一组依赖；`--features cli` 并不会移除蓝牙或 TLS 依赖。
审查未发现项目自身的 CPU 专用汇编或仅允许 x86/ARM 的源码分支。关键依赖如下：

- **终端界面**：Ratatui / Crossterm 使用 Rust 和操作系统终端接口，没有发现必须重写界面的架构障碍。
- **蓝牙**：`btleplug 0.13.5` 在 Linux 经 BlueZ / D-Bus 工作。
  `libdbus-sys 0.2.7` 的当前配置使用系统库，需要目标架构的 `dbus-1.pc` 和 `libdbus-1`。
  交叉编译时不能把宿主机的库拿来链接。运行时仍需 BlueZ 服务与蓝牙硬件。
  参见 [btleplug Linux 说明](https://github.com/deviceplug/btleplug#linux)。
- **HTTPS / AI**：当前解析链为
  `reqwest 0.13.5 → rustls 0.23.46 → aws-lc-rs 1.18.2 → aws-lc-sys 0.46.0`。
  两个 Linux 目标都使用 AWS-LC；锁文件里出现 `ring` 不代表这里使用它。
  已核对锁定源码中的通用绑定、C 构建分支和 LoongArch64 适配，尚无证据要求更换 TLS 后端。
  [AWS-LC 平台表](https://aws.github.io/aws-lc-rs/platform_support.html)明确列有 RISC-V 构建/测试；
  LoongArch 仍需完整构建和 HTTPS 运行验证。

## 项目需要补齐的部分

| 位置 | 当前行为 | 移植时需要做的事 |
| --- | --- | --- |
| [`rust-toolchain.toml`](../tools/linkr-tui/rust-toolchain.toml) | 声明现有 10 个目标 | 验证后补入两个 Linux target，固定可复现的工具链与 sysroot |
| [`stage-cross-dbus.sh`](../tools/linkr-tui/dev/stage-cross-dbus.sh) | 只处理 amd64、arm64、armhf、i386 | 增加对应架构库的准备流程；确认发行版、ABI、来源和版本，不能只新增 target 名称 |
| [`package.sh`](../tools/linkr-tui/dev/package.sh) | Linux tar.gz 打包路径可接受任意 target | 完成实际链接后复用，检查可执行文件架构、依赖和归档内容 |
| [`package-deb.sh`](../tools/linkr-tui/dev/package-deb.sh) | 只识别现有四种 Debian 架构 | 增加 `riscv64` / `loong64` 映射、交叉工具链和 ELF 检查 |
| [`linkr-tui.yml`](../.github/workflows/linkr-tui.yml) | 没有这两个架构的检查或产物 | 加入完整构建、CLI/TUI 变体、运行冒烟和包校验 |

建议先使用目标发行版的 GNU 工具链与 glibc。LoongArch 尤其需要匹配 LP64D、LSX 与发行版
ABI；Rust 标准库、C 编译器、链接器和 D-Bus 库应采用兼容的工具链组合。
切换为 musl 不会自动解决 BlueZ / D-Bus 依赖。

## 验证顺序

1. 在对应架构的 Linux 环境准备 Rust stable、C/C++ 编译器、`pkg-config` 和 D-Bus 开发库。
   先做本机构建以确认依赖，再固化交叉构建流程。使用 `cargo +stable` 可显式选择工具链，
   避免试编译时自动安装仓库配置中的全部现有目标。
2. 使用 `--locked` 完成默认、CLI-only 和 TUI-only 的构建与测试；发布验证必须包含
   `cargo build --release` 的实际链接，不能止于 `cargo check`。
3. 用目标机或 QEMU 执行 `--version`、`--help`、`--print-frame`（TUI）、stdio loopback、
   `--exec` 和 `--serve`。确认中文宽字符、终端缩放和退出后终端状态恢复。
4. 验证 LAN WebSocket、HTTPS 证书校验和 AI 请求；在真机上验证 BLE 扫描、配对、收发和重连。
   QEMU 冒烟不等于蓝牙硬件验证。
5. 检查包安装、动态库依赖和 glibc 下限，再将该架构标为支持并加入后续 release。

本次已完成两目标的 Cargo 依赖解析、锁定依赖源码检查、Rust 目标配置与打包脚本检查。
评估主机为 macOS ARM64，未配备这两个 Linux 目标的完整工具链和运行环境，因此没有将
源码层面的可行性标为编译或真机测试通过。
