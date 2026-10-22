# Linkr Bee 文档

[项目介绍](../README.zh-CN.md) | [English documentation](README.md)

## 从这里开始

| 文档 | 内容 |
| --- | --- |
| [项目 README](../README.zh-CN.md) | 产品介绍、客户端选择、接线、首次连接与常见问题 |
| [使用指南](USAGE.zh-CN.md) | 中文界面截图、终端操作、手机和平板布局、助手、局域网与日志 |
| [Rust CLI / TUI](../tools/linkr-tui/README.md) | 桌面终端、脚本请求、常驻会话与主机实现（英文） |
| [Android / iOS](../mobile/README.md) | 原生 BLE 封装、平台配置与共享助手实现（英文） |
| [HarmonyOS NEXT](../harmonyos/README.md) | DevEco 构建、签名、模拟器覆盖与真机待验项（英文） |

中文 README 和使用指南使用中文界面截图；英文版本使用独立的英文截图。截图中的串口
输出是用于展示布局的示例，不作为固件或真机测试通过的证据。

## 开发与集成

| 文档 | 内容 |
| --- | --- |
| [开发指南](DEVELOPMENT.zh-CN.md) · [English](DEVELOPMENT.md) | 固件构建和刷写、Kconfig、终端工具、协议与测试模式 |
| [硬件需求](HARDWARE.md) | 引脚、电气要求、测试点与量产注意事项 |
| [BLE 配件 API v1](LINKR_BLE_API.zh-CN.md) | GATT 服务、分帧请求、Reliable UART 与事件 |
| [蓝牙配对与恢复](BLE_PAIRING.md) | 配对 GPIO 授权（C3/C5 为 GPIO1；WROOM 可选 GPIO4，默认关闭）、绑定保留、各端步骤与故障恢复 |
| [鸿蒙桥接协议](../harmonyos/BRIDGE_PROTOCOL.md) | ArkWeb 与 ArkTS 之间的 JSON 桥接约定（英文） |
| [视觉资源](../assets/README.md) | Logo、截图语言分组与重新截图的方法（英文） |

## 设计与验证记录

以下文档记录设计决策、排查过程和验证边界，不替代当前硬件与固件上的复核。

| 文档 | 内容 |
| --- | --- |
| [产品范围](../PRODUCT.md) | 产品需求和边界 |
| [设计说明](../DESIGN.md) | 界面与交互设计 |
| [WiFi / BLE 共存排查](WIFI_DEBUG_FINDINGS.md) | 复现证据与无线回归检查 |
| [桥接队列排查](BRIDGE_QUEUE_FINDINGS.md) | 缓冲与转发行为 |
| [Agent 验证记录](AGENT_VALIDATION.zh-CN.md) | 已验证行为与真机待验项 |
| [Agent 能力与路线图](AGENT_ROADMAP.zh-CN.md) | 工具能力、缺口与后续阶段 |
| [Agent Skills](AGENT_SKILLS.zh-CN.md) | 技能发现、使用与限制 |
| [Agent 任务记录](AGENT_TASKS.zh-CN.md) | 任务保存与恢复行为 |
