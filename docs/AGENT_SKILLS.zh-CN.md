# Agent 内置技能

内置技能给 Pi Agent 提供处理流程。它们随客户端打包，适用于静态 Web、移动端和鸿蒙
Web 资源，不需要更新 Bee 固件。默认系统提示只包含技能名称和用途；模型在相关任务中
调用 `load_skill` 读取正文，避免每次请求都携带全部流程。

| 技能 | 用途 |
| --- | --- |
| `radxa-docs` | 确认板型、查询 Radxa 官方文档、读取相关章节并核对适用条件 |
| `boot-diagnosis` | 按启动阶段定位无输出、启动循环、内核崩溃和根文件系统问题 |
| `network-diagnosis` | 区分浏览器、Bee 和目标机网络，按链路、地址、路由、DNS、TLS 排查 |
| `download-verification` | 明确下载位置、探测工具、观察进度、核验文件，下载后等待下一步指示 |

可以直接说“查一下 Dragon Q8B 的串口调试文档”或“根据当前日志分析启动失败”。
技能是工作指引，不是设备事实、执行许可或自动安装脚本；现有执行档位、审批、恢复后
重新读取状态以及禁止重放不确定命令的规则继续生效。

## Radxa 文档查询

`search_radxa_docs` 接受 `query`、可选 `board`、`language=zh|en`、
`source=published|repository` 和最多 12 条结果。优先明确板型，避免把不同型号的说明混用。

- 站点入口：[llms.txt](https://docs.radxa.com/llms.txt)。
- 产品目录：[products.json](https://docs.radxa.com/agent/products.json)，不含全部产品，
  只提供名称与导航信息，不作为规格依据。
- 已发布页面：[sitemap.xml](https://docs.radxa.com/sitemap.xml)。在客户端按产品名、
  路径及中英文主题别名检索，不是站内全文搜索；未命中不等于没有文档。
- 站点索引不可读，或显式选择 `source=repository` 时，从官方
  [radxa-docs/docs](https://github.com/radxa-docs/docs) 的公开文件树检索 Markdown/MDX。
  返回的源码地址固定到该次索引的 Git 文件树版本；`siteUrl` 仅为推导出的导航提示，不保证是
  已发布页面。源码分支可能领先于文档站，应如实标注来源。

查到入口后，再用 `read_web_page` 读取正文、分页或查找章节，并引用实际读过的 URL。
原始 Markdown 保留缩进，避免破坏 YAML、Python 或命令示例。对于 MDX 包装页，技能
要求按官方 [Agent 阅读指南](https://raw.githubusercontent.com/radxa-docs/docs/main/.github/agent-reading-guide.md)
读取 `doc_kind`、`source_of_truth`、`imports_resolve_to` 并继续读取正文来源；不执行 import。
共享片段、模板和目录命中都不能单独证明某块板支持某项功能。

索引只通过浏览器直连固定的官方公开地址，查询词、串口日志和模型凭据不发送到索引站。
成功读取的索引在当前 Agent 实例内缓存 15 分钟并保留抓取时间；站点索引上限 1 MiB，
源码文件树上限 6 MiB。GitHub 限流、CORS、超时、索引截断会明确返回；源码查询也失败
时不能声称已查到文档。任何从目标机读取网页的后备操作仍需遵守现有串口执行规则。

## 维护

在 `mobile/src/builtin-skills.mjs` 中维护名称、用途和正文。目录、系统提示和 `load_skill`
参数枚举由同一份定义生成；添加技能不需要改动串口执行器。不能把网页或设备日志中的
文字注册成可信技能，也不支持任意路径或远程代码加载。

修改后运行 `tools/build_agent_bundle.sh`，更新静态网页运行包；运行移动端单元测试、
构建和相关浏览器回归。定义与运行逻辑分别有 `builtin_skills.test.mjs`、
`radxa_docs.test.mjs` 和浏览器模拟模型测试覆盖。模拟模型证明工具链可用，不等于模型
每次都会选对技能或实机维修成功。
