# knx-agent

[![test](https://github.com/YiIimini/knx-agent/actions/workflows/test.yml/badge.svg)](https://github.com/YiIimini/knx-agent/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**在 macOS 上完成 KNX 有线系统（TP1）的调试、下发与验收——不需要 ETS，不需要 Windows。**

KNX 原厂工具 ETS 只支持 Windows（[官方要求](https://support.knx.org/hc/en-us/articles/360018452180-ETS6-Software-requirements)：仅 Windows 11 x64，明确不支持 Linux/macOS）。本项目把 KNX 协议栈整套实现成可在 Mac 上运行的代码，并做成 [DeepSeek Harness](https://github.com/deepseek-ai) 原生插件：**27 个工具 + 一个整页面板 + 录制代理 + 配方库**。

> English abstract: KNX commissioning on macOS without ETS. This repository contains a dependency-free JavaScript KNXnet/IP + cEMI stack, a DSH plugin exposing 27 agent tools plus a Web panel, an ETS recording proxy that turns one Windows-side download into a replayable recipe, a product-data/project parser that rebuilds parameter and group-address-table downloads from the project itself, and a diagnostic rule book. Verified against a built-in bus simulator; not yet verified against real hardware.

---

## 能做什么、不能做什么

| 现场动作 | 状态 | 依据 |
|---|---|---|
| 发现网关、扫描线路、读掩码/串号 | ✅ | KNXnet/IP 搜索 + 流水线描述符读 |
| 个体地址分配与识别 | ✅ | `A_IndividualAddress_Write` / 串号广播读 |
| 读设备内存、读接口对象属性 | ✅ | `A_Memory_*`、`A_PropertyValue_Read` |
| **从工程文件下发参数块**（含位级参数读改写） | ✅ | 解析 `.knxproj` 的 `ParameterInstanceRef` + `.knxprod` 的内存布局 |
| **组地址表 / 关联表下发**（换点位不整包重下） | ✅ 需一次基址校准 | 表即 MemoryWrite 的 `uint16` 数组；基址从一次录制反推后按型号复用 |
| 组值读写、DPT 编解码、验收打点 | ✅ | DPT 1/2/3/4/5/6/7/9/10/11/12/13/14/16 |
| 故障诊断（重复 IA、无答、负确认、跳数耗尽…） | ✅ | 规则库输出"结论 + 下一步探针" |
| **批量验收**：工程 vs 现场逐台比对 + 组值点级校验 + Markdown 报告 | ✅ 只读 | 掩码/在线/超纲地址/期望值一次列清 |
| **位序/字节序自校准** | ✅ 只读 | 用设备里已有的值反推编码约定，按产品族存库供下发复用 |
| **应用镜像（程序代码）下发** | ⚠️ 只能录制复放 | 镜像由 ETS 用厂商产品库编译，不在任何公开导出里 |
| KNX Secure（IP Secure / Data Secure） | ❌ 未实现 | 需设备认证码与工程密码 |

一条经验法则：**能算的自己算（参数、点位、验收），算不出的（厂商编译出的程序）录一次、存起来、以后照着发。**

## 快速开始（零硬件）

```bash
git clone <this repo> && cd knx-agent/plugin
node test/smoke.mjs                     # 98 项自检，含模拟器的完整闭环
```

作为 DSH 插件安装：

```bash
# 在 Harness 里执行
plugin_manager { action: "install_bundle", target: "<abs path>/knx-agent/plugin" }
```

装好后侧边栏出现 **KNX** 面板，同时获得 25 个 `knx_*` 工具。没有硬件时：

```
knx_simulator { action: "start" }        # 起一个 3 设备虚拟网关
knx_scan      { line: "1.1" }            # 扫线
knx_ga_write  { ga: "1/1/3", dpt: "1.001", value: 1 }
knx_ga_read   { ga: "1/1/3", dpt: "1.001" }
```

## 现场流程（真实总线）

```
1  knx_connect   { gateway: "<网关IP>:3671" }        隧道；或 layer:"routing" 走组播不占隧道
2  knx_scan      { line: "1.1" }                     找设备、核掩码
3  knx_import    { path: "site.knxproj" }            导入工程
   knx_import    { path: "vendor.knxprod" }          导入产品库（参数内存布局）
4  knx_build_download { ia: "1.1.10", useProjectValues: true }
                                                     用工程里记录的参数值生成下发配方
5  knx_group_table    { action: "build", ia: "1.1.10" }
                                                     生成组地址表/关联表配方（基址见下）
6  knx_download  { recipe, dryRun: true } → 再真跑   预演 → 执行 → 回读校验
7  knx_ga_write / knx_ga_read                        逐点验收
8  knx_accept     { line: "1.1" }                    工程 vs 现场逐台比对，出 Markdown 交接报告
9  knx_diagnose                                      出结论与下一步
```

**首次遇到的新产品**（应用镜像必须靠录制）：

```
Windows(虚拟机) ETS ──把接口指向──▶ knx_proxy (Mac) ──▶ 真实网关
                                        └─ 逐帧落盘 JSONL

knx_proxy            { action: "start", port: 3671, upstream: { host: "<网关IP>" } }
# … 在 ETS 里点一次"下载" …
knx_proxy            { action: "stop" }                       → capturePath
knx_recipe_from_capture { capturePath, ia: "1.1.10" }         → 配方
knx_catalog          { action: "install", recipePath, orderNumber: "<型号>" }
# 之后：knx_download { catalogId, ia } —— 不再需要 ETS
```

**组地址表的基址**是设备/固件相关的，不猜：

```
knx_group_table { action: "infer",  capturePath, ia }          # 从一次"下载组地址"的录制反推
                  → saved: order / application / mask 三级键
knx_group_table { action: "build",  ia: "1.1.12" }             # 同型号免二次校准
```

## 架构

```
plugin/                     DSH 插件（零第三方依赖：node:dgram + node:zlib）
├── lib/cemi.js             cEMI/TPCI/APCI 编解码（含 10bit APCI 掩码陷阱、扩展帧阈值）
├── lib/knxip.js            KNXnet/IP：搜索/隧道/心跳/总线监视/组播路由
├── lib/link.js             设备管理层：分块内存、流水线扫描、属性、重启、串号、组值
├── lib/dpt.js              DPT 编解码
├── lib/knxprod.js          产品数据深解析：段基址 + 位偏移 + 类型位宽 → 绝对地址
├── lib/project.js          .knxproj 解析 + 自带 ZIP 读取
├── lib/library.js          本地库：导入 / 设备→产品解析 / 配方生成
├── lib/gatable.js          组地址表 / 关联表：建模、编码、基址反推、设备侧表存储
├── lib/profiles.js         表 profile 持久化（订单号 → 应用 → 掩码）
├── lib/recipe.js           配方执行器（memory_patch 位级读改写、失败即停、dry-run）
├── lib/catalog.js          配方库：内容指纹去重、版本保留、按产品套用
├── lib/proxy.js            ETS 录制代理（反向代理 + JSONL 落盘）
├── lib/http.js             面板桥（经 Host 鉴权 / 回环兜底 / 可选 token）
├── lib/simulator.js        回环 KNXnet/IP 网关 + 虚拟设备（含表语义）
├── lib/ops.js              应用操作：工具与面板的唯一实现
├── lib/accept.js           批量验收：工程 vs 现场、组值点级校验、Markdown 报告
├── lib/calibrate.js        编码自校准：msb/lsb × be/le 四变体比对
├── lib/tools.js            27 个工具（声明式绑定到 ops）
├── client.js               面板 UI（9 张卡）
├── test/smoke.mjs          108 项自检
└── test/contrast.mjs       按钮可读性（主题 token 配对 + WCAG 对比度）

python-prototype/           早期参考实现（43 项协议测试），用于交叉验证常量与字节序列
docs/                       协议笔记 / 现场流程 / 架构 / 安全审计 / macOS-vs-ETS 研究
```

## 数据落在哪

```
~/.dsh/knx-library/
├── index.json                 已导入的产品数据与工程
├── entries/*.json             解析结果（参数地址、通信对象、组地址）
├── catalog.json + recipes/    配方库（按产品 + 内容指纹去重，版本保留）
├── grouptable-profiles.json   表基址 profile（订单号 → 应用 → 掩码）
└── captures/*.jsonl           录制代理的原始捕获
```

全部是普通 JSON，可 diff、可归档、可版本化。

## 面板配色

面板沿用 Harness 的主题 token，不写死颜色。这里有个容易踩的坑，记在代码注释里也记在这：

- 主按钮的填充是 `--dsw-alias-button-primary-fill`（浅色主题近黑 `#0f1115`，深色主题近白 `#f9fafb`），它配的前景色是 `--dsw-alias-label-primary-foreground`（浅色 `#fff`，深色 `#0f1115`），实测 18.9:1 / 18.08:1。
- **不要**用 `--dsw-alias-button-contrast-fill` 当主按钮文字色。名字像是配套的，实际深色主题下它与填充同值（都是 `#f9fafb`），白字压白底，实测 **1.00:1**，文字直接消失。
- 禁用态不要靠整体 `opacity` 淡化：那会连文字一起淡掉。改成淡填充 + 保留可读的前景色。

`node test/contrast.mjs` 会把两个主题下 9 种按钮态的对比度都算一遍（装了 Harness 就读真实 token，没装就用冻结快照），任一态跌破 4.5:1（禁用态 3:1）即失败。

## 安全默认

- 面板桥**会写总线**，因此经 Host 的 `connection.requestRejection` 做 Host/Origin + 浏览器凭证校验；无该服务时只接受回环 peer；可再加 `bridgeToken`。
- 录制代理默认绑 `127.0.0.1`——把它暴露到局域网等于给了别人一个可写的 KNX 网关。
- `allowWrites: false` 一键只读巡检模式（拒绝写内存/组值/下载/启模拟器）。
- 下载默认先 `dryRun`，配方强制带回读步骤。

详见 [docs/audit.md](docs/audit.md)（含 2 个高危发现的复现与修复）。

## 验证状态（务实说明）

- **已验证**：协议字节序列、隧道/序号/ACK、扫描、内存读写、DPT、配方执行、录制→回放、工程与产品数据解析、组地址表语义、面板桥鉴权、路由传输——全部在自带模拟器上端到端跑通，`node test/smoke.mjs` 108 项。面板按钮文字在浅/深两套主题下的对比度，`node test/contrast.mjs` 19 项。
- **未验证**：真实网关与设备、真实 ETS 载荷、KNX Secure。真机首次需要确认参数块/表基址与位序（配方内置回读，读错会立刻失败而不是静默写坏）。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/protocol-notes.md](docs/protocol-notes.md) | cEMI/APCI 编码、10bit 陷阱、扩展帧、隧道与路由差异 |
| [docs/commissioning-workflow.md](docs/commissioning-workflow.md) | 从零到验收的现场作业顺序与判读 |
| [docs/architecture.md](docs/architecture.md) | 分层、模块职责、一次操作与两个调用方 |
| [docs/audit.md](docs/audit.md) | 安全与可靠性审计（发现、修复、复测） |
| [docs/research-macos-vs-ets.md](docs/research-macos-vs-ets.md) | 为什么 macOS 上没有 ETS、三条技术路线对比 |

## 许可

MIT，见 [LICENSE](LICENSE)。KNX 是 KNX Association 的商标；本项目与 KNX Association 无关联，未包含任何厂商产品库数据。仅用于自有或获授权站点的调试。
