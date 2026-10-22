# Linkr Bee documentation

[Project overview](../README.md) | [Chinese documentation](README.zh-CN.md)

## Start here

| Document | What you will find |
| --- | --- |
| [Project README](../README.md) | Product overview, client choices, wiring, first connection, and troubleshooting |
| [User guide](USAGE.md) | English interface screenshots, terminal controls, phone/tablet behavior, assistant, LAN, and logs |
| [Rust CLI / TUI](../tools/linkr-tui/README.md) | Desktop terminal, scripted requests, resident sessions, and host implementation |
| [Android / iOS](../mobile/README.md) | Native BLE packaging, platform setup, and shared assistant implementation |
| [HarmonyOS NEXT](../harmonyos/README.md) | DevEco build, signing, emulator coverage, and remaining real-device checks |

The English README and user guide use English-language interface captures.
Chinese interface captures are kept in the [Chinese user guide](USAGE.zh-CN.md).
Screenshots are UI previews with sample output, not hardware acceptance evidence.

## Build and integrate

| Document | Language | What you will find |
| --- | --- | --- |
| [Development guide](DEVELOPMENT.md) | English | Firmware build/flash, Kconfig, terminal tools, protocols, and test modes |
| [Development guide](DEVELOPMENT.zh-CN.md) | Chinese | Chinese edition of the development guide |
| [Hardware requirements](HARDWARE.md) | Chinese | Pinout, electrical requirements, test points, and production notes |
| [BLE accessory API v1](LINKR_BLE_API.zh-CN.md) | Chinese | GATT services, framed requests, Reliable UART, and events |
| [BLE pairing and recovery](BLE_PAIRING.md) | Chinese | Pairing GPIO authorization (GPIO1 on C3/C5; WROOM optional GPIO4, off by default), persistent bonds, client steps, and recovery |
| [HarmonyOS bridge protocol](../harmonyos/BRIDGE_PROTOCOL.md) | English | ArkWeb-to-ArkTS JSON bridge contract |
| [Visual assets](../assets/README.md) | English | Logos, screenshot languages, and reproducible capture instructions |

## Design and validation records

These records describe design decisions, investigations, and validation limits;
they are not substitutes for checking the current hardware and firmware.

| Document | Language | Topic |
| --- | --- | --- |
| [Product scope](../PRODUCT.md) | Chinese | Product requirements and scope |
| [Design notes](../DESIGN.md) | Chinese | Interface and interaction design |
| [WiFi/BLE coexistence findings](WIFI_DEBUG_FINDINGS.md) | Chinese | Reproduction evidence and radio regression checks |
| [Bridge queue findings](BRIDGE_QUEUE_FINDINGS.md) | Chinese | Buffering and bridge behavior |
| [Agent validation](AGENT_VALIDATION.zh-CN.md) | Chinese | Verified behavior and remaining hardware acceptance |
| [Agent capability and roadmap](AGENT_ROADMAP.zh-CN.md) | Chinese | Current tool surface and planned phases |
| [Agent skills](AGENT_SKILLS.zh-CN.md) | Chinese | Skill discovery, use, and boundaries |
| [Agent tasks](AGENT_TASKS.zh-CN.md) | Chinese | Task records and recovery behavior |
