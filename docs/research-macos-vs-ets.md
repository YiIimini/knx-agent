# 用 Agent 替代 ETS 调试 KNX 有线系统 —— macOS 落地研究报告

> 目标：在没有 Windows、装不了 ETS 的 Mac 上，完成 KNX 有线系统（TP1）的**现场调试、下载、验收**。
> 本报告 + 同目录 `knxagent/` 原型一起构成交付物：报告给路线与判断，原型给可运行的代码。
> 版本：2026-10，对应原型 `knxagent`（Python 3.9+，零第三方依赖，43 个测试全绿）。

---

## 0. 结论先行

1. **ETS 在 macOS 上无解，这是厂商策略不是技术问题。** ETS6 官方只支持 Windows 11 x64，明确指出 Linux/macOS 不支持，且虚拟机环境"不在支持范围"（仍可用，只是无保修）。硬扛 Windows 虚拟机不是最优解。
2. **真正卡住 Mac 的不是"协议"，而是"下载内容"**：ETS 的下载 = 把产品库里的应用镜像 + 你填的参数编译成一组内存写电报。协议部分（KNXnet/IP + cEMI）完全公开、macOS 原生可跑；产品库内容是 ETS 私有资产。
3. 因此有三条路，正确做法是**组合**，而不是"完全替代 ETS"：

| 路线 | 做法 | 能覆盖 | 结论 |
|---|---|---|---|
| **A. 录制 / 回放** | 在一台 Windows（虚拟机即可）里用 ETS 对**每个产品 + 每种参数组合**下载一次，用 KNXnet/IP 代理把电报录下来，转成参数化 recipe，之后在 Mac 上无限次回放 | 首次下载、批量同型号设备、售后重刷 | **首选**。一次性成本，之后 100% 脱离 Windows |
| **B. 规格重建** | 直接解析 `.knxproj`（工程）+ `.knxprod`（产品库导出）+ KNX 规范，自己合成下载电报 | 参数微调、组地址表/关联表重写、IA 重编、验收 | 部分可行：组地址表、关联表、参数块、IA 完全可做；**完整应用镜像不保证**（厂商 load image 不一定在导出里） |
| **C. 虚拟机 + UI 自动化** | UTM/Parallels 跑 Win11 ARM（x64 模拟）+ ETS6，用脚本点 UI | 兜底，任何冷门产品 | 最后手段。慢、脆、授权与保修风险都在 |

4. 日常现场调试里 80% 的工作量（找设备、编址、读参数、写组地址、验收打点、诊断）**不需要 ETS**，这些能力已经在原型里实现并跑通：KNXnet/IP 隧道、cEMI 编解码、内存读写、属性读写、IA 写入、串号识别、总线监视、DPT 编解码、recipe 下载执行、诊断规则库、MCP 风格工具面。
5. **KNX Secure 是硬门槛**：IP Secure 需要设备认证码/隧道密钥，Data Secure 的组密钥/工具密钥来自工程密码。拿不到密钥就只能继续让 ETS 做密钥分发；录制回放在 Secure 站点上只能照抄密文（换参数就失效）。

---

## 1. 痛点解剖：Mac 用户的真实处境

### 1.1 ETS 的边界
- ETS6 软件要求：**仅 Windows 11 x64**；Windows 10 已于 2025-10-15 停止支持；Linux / macOS 明确不支持；虚拟机 / 远程桌面"不建议、不保修"（[KNX 官方支持文档](https://support.knx.org/hc/en-us/articles/360018452180-ETS6-Software-requirements)）。
- ETS 需要管理员权限安装，插件（厂商 Plug-in）常注册 COM 组件、跑 MSI——在 Wine/CrossOver 下成功率不稳定。
- 许可证 + 加密狗 + 产品库（每家厂商的 `.knxprod`）与 ETS 版本强绑定。

### 1.2 Mac 上跑 ETS 的三条现实路径及其坑

| 方式 | 可行性 | 主要坑 |
|---|---|---|
| UTM/Parallels + Windows 11 ARM | 可跑（x64 应用靠 Prism 模拟） | 慢；**USB KNX 接口在 ARM Windows 上几乎没有驱动**，只能走 KNXnet/IP；虚拟机 USB 直通经常掉 |
| CrossOver / Wine | ETS5 部分可用，ETS6 不稳 | .NET 4.8 / WPF 渲染、加密狗、COM 插件 |
| 远程 Windows 主机 / 云桌面 | 稳定 | 现场没网就废；延迟影响下载成功率 |

**共同结论**：只要还依赖 ETS，Mac 就永远需要第二台机器。要做到"Mac 单机完成调试"，必须绕开 ETS 的**运行时**——而不是绕开它的**一次编译**。

### 1.3 真正被需要的能力清单
按现场频次排序（这也是原型的功能边界）：

1. 找设备（线扫描、编程模式下按串号认设备）
2. 分配 / 修改个体地址（IA）
3. 组地址（GA）读写与验收打点（DPT 编解码）
4. 读设备参数、改单个参数（不想整包重下）
5. 写组地址表 / 关联表（换房间、改点位时最高频）
6. 完整应用下载（首次调试、换固件）
7. 诊断：谁不应答、谁地址冲突、谁跳数耗尽、谁负确认

第 1–5、7 项纯协议即可；只有第 6 项依赖产品库编译。

---

## 2. 技术底图：两层协议

### 2.1 TP1 上的 cEMI（一层报文，所有服务都在里面）

```
L_Data: [cEMI码][附加信息长度][Ctrl1][Ctrl2][源IA×2][目标×2][NPDU长度][TPDU...]
        0x11=req 0x29=ind 0x2E=con
Ctrl1:  FT(1=标准帧) | 重复 | 系统广播 | 优先级2bit | ACK请求 | 确认错误
Ctrl2:  AT(1=组地址) | 跳数3bit | 扩展帧格式
APDU:   第一字节 = TPCI(6bit)<<2 | APCI[9:8]
        第二字节 = APCI[7:0]（带4bit参数的服务：低半字节是参数）
```

**关键细节（原型里已用字节向量钉死，见 `tests/test_codec.py`）**：
- ETS 发出的标准组帧控制字节是 `0xBC / 0xE0`，个体寻址帧是 `0xBC / 0x60`；
- NPDU ≤ 15 用标准帧，> 15 自动切扩展帧（`0x3C`），下载大块时必然遇到；
- `A_Memory_Read(0x1234, 11)` = `02 0B 12 34`；`A_Memory_Write(0x1234, AA BB CC)` = `02 83 12 34 AA BB CC`；
- **APCI 的 10bit 特性是个陷阱**：内存服务的低半字节是"元素个数"，必须按掩码匹配；而属性服务（`0x03D5/0x03D6/0x03D7`）的低半字节是服务本体，按掩码会把 `A_PropertyValue_Write` 误判成 `A_MemoryBit_Write`。原型第一版就踩了这个坑，测试里专门保留了这个回归用例。

### 2.2 KNXnet/IP（让 Mac 用一根网线接入总线）

| 服务 | ID | 用途 |
|---|---|---|
| SEARCH / DESCRIPTION | 0x0201–0x0204 | 发现网关、读设备名/串号/服务族 |
| CONNECT / CONNECTIONSTATE / DISCONNECT | 0x0205–0x020A | 建隧道（普通网关默认只给 4 条，ETS 常占满） |
| TUNNELLING_REQUEST / ACK | 0x0420 / 0x0421 | 承载 cEMI，带序号 + 逐帧 ACK |
| DEVICE_CONFIGURATION | 0x0310 / 0x0311 | 直接配置 KNXnet/IP 设备自身 |
| ROUTING_INDICATION | 0x0530 | 组播 224.0.23.12，无需隧道，但只有路由器才转发个体管理帧 |
| 总线监视器 | 隧道层 0x80 | 抓全总线（录制回放的前提） |

工程要点：隧道序号必须严格递增并等 ACK；不 ACK 对端发来的帧，网关会 1s 后重发并最终断链；心跳（CONNECTIONSTATE）120s 内必须发一次。

**已实现的字节级验证**（`python3 -m unittest`）：连接/搜索/心跳/确认/序号、内存读写分块、扫描、属性读写、组值、DPT、失败路径全部靠一个 loopback 网关模拟器跑通，不 mock 客户端 API。

---

## 3. ETS 的"下载"到底做了什么

ETS 的 Download 不是一次动作，而是四类可独立执行的操作：

| 下载类型 | 内容 | 用到的服务 | 我方可行性 |
|---|---|---|---|
| 个体地址 | 编程模式下写 IA | `A_IndividualAddress_Write` / 串号写 | ✅ 完全可做 |
| 应用 + 参数 | 应用镜像写入 Flash/EEPROM + 参数块 | `A_Memory_Write`（大量）、`A_MemoryExtended_Write` | ⚠️ 内容依赖产品库，需录制 |
| 组地址表 + 关联表 | 设备的组地址表与通信对象关联 | 属性写（PID 组地址表/关联表）或内存写 | ✅ 规范定义清晰，但**不同 mask 版本差异大**，必须逐型号验证 |
| 局部参数 | 单参数改动（如调光时间） | 内存/属性写 | ✅ 知道偏移即可 |

三个必须知道的现场事实：

1. **地址映射来自产品库**。`0x4000` 是代码段、`0x4700` 是参数块——这些偏移是厂商在 `.knxprod` 里声明的，不是协议常量。所以"重建路线"必须先解析产品库。
2. **下载失败会留下半成品**。设备处于"应用未加载"状态，表现为：能应答描述符、组通信全无。诊断规则库把这种状态识别为"下载中断"而不是"设备坏"。
3. **组地址表写入是最高频也最容易被低估的一步**。改点位不改参数时，只需重写表，不需要整包下载——这是 agent 相对 ETS 的天然优势（ETS 走 UI，agent 走脚本，一次可以刷一整层楼）。

---

## 4. 三条路线的工程判断

### 路线 A：录制 / 回放（推荐主路径）

```
Windows(VM) ETS ──KNXnet/IP──> 录制代理 ──> 真实网关 ──> 总线
                                 │
                                 └─> capture -> recipe.json（参数化） -> Mac 回放
```

- 成本：每"产品 × 参数形态"录制一次，之后零 Windows。
- 原型已实现：`capture_to_recipe()`（把抓到的 `A_Memory_Write` 合并成连续块、保留重启与验收写）、`DownloadRunner`（逐步执行 + 失败即停 + 报告）、占位符 `{{ia}}` 参数化。
- 局限：Secure 站点只能照抄密文；换参数要重新录。

### 路线 B：规格重建（增量覆盖）

- 已实现：`.knxproj` / `.knxprod` 解析（命名空间无关、容忍 ETS4/5/6 schema 差异），能拿到设备表、IA、组地址、通信对象与 GA 关联、产品库的应用/参数/段布局。
- 能做：IA 重编、组地址表与关联表重写、参数块按偏移改、验收。
- **不承诺**：完整应用镜像重建。厂商的 load image 是否完整出现在导出里，逐厂商不同；这条必须真机验证后再下结论——报告里不装作能做到。

### 路线 C：虚拟机 + UI 自动化（兜底）

- 只在前两条都失效（冷门产品、需要厂商 Plug-in 授权、Secure 密钥分发）时使用。
- 价值：保留一条"人类可介入"的退路，而不是把项目卡死。

**推荐组合**：C 用于**一次性录制/密钥分发**，A 用于**日常批量下载**，B 用于**改动与验收**。这样 Mac 成为主力工作站，Windows 退化成"每月开机一次的编译器"。

---

## 5. 交付的原型（`knxagent/`）

```
knxagent/
├── cemi.py        cEMI + TPCI/APCI 编解码（内存/属性/IA/描述符/重启/串号/组值）
├── knxip.py       KNXnet/IP：搜索、描述、隧道、心跳、总线监视、路由
├── dpt.py         DPT1/5/6/7/9/12/13/14/16 编解码
├── link.py        设备管理 API（分块内存读写、扫描流水线、属性、重启、串号）
├── simulate.py    回环 KNXnet/IP 网关 + 虚拟设备（测试与演练）
├── project.py     .knxproj / .knxprod 解析（设备、GA、通信对象、产品库布局）
├── download.py    recipe 模型、录制转 recipe、执行器（dry-run / 逐步报告）
├── agent.py       13 个工具（MCP 兼容 schema）、运行时、诊断规则库、意图→计划
├── cli.py         命令行：search / scan / info / read / write / monitor / ga /
│                  project / capture / run / serve / plan / selftest
└── tests/         43 个测试：协议向量、端到端、工程解析、recipe、agent
```

**已跑通的证据**（`serve` 起模拟网关，CLI 直连）：

```
$ knxagent scan --gateway 127.0.0.1:61760 --line 1.1 --end 5
{"line": "1.1", "count": 2, "devices": [{"ia_text": "1.1.1", "descriptor": 1968}, ...]}

$ knxagent write --gateway ... --ia 1.1.1 --address 0x4000 --data 0a0b0c0d
{"ok": true, "octets": 4}
$ knxagent read  --gateway ... --ia 1.1.1 --address 0x4000 --count 4
{"ok": true, "data": "0a0b0c0d"}

$ knxagent ga --gateway ... --ga 3/1/5 --dpt 9.001 --value 21.5
{"written": true, "raw": "0c33"}
{"ga": "3/1/5", "dpt": "9.001", "value": 21.5, "source": "1.1.1"}
```

（`0x07B0` = 1968，System B 掩码；`0c33` 是 DPT9 的 21.5 ℃ 编码，回读一致。）

**诚实的边界**：以上全部在**协议级模拟器**上验证。真实网关/设备必须再过一遍——差异通常出现在：组地址表写入的 mask 版本细节、`A_MemoryExtended_*` 的支持情况、属性服务的实例编号约定、以及 Secure 站点。原型把这些都做成了可替换点，而不是假装已经验证。

---

## 6. Agent 设计：把"调试"变成可执行、可审计的计划

### 6.1 循环

```
意图(YAML/JSON) → 计划(tool 调用序列) → 执行(每步留证据) → 验证(回读/打点) → 诊断规则库 → 修复(重试/换路) → 报告
```

`agent.plan_for_site()` 已实现意图到计划的编译，`run_plan()` 逐步执行并在失败步骤停下——**下载是不可逆的现场操作，任何"猜"都要被禁止**：默认先 `dry_run`，再真跑，跑完必须回读。

### 6.2 工具面（MCP 兼容，13 个）

`knx_search / knx_connect / knx_scan / knx_device_info / knx_memory_read / knx_memory_write / knx_ga_read / knx_ga_write / knx_monitor / knx_download / knx_capture / knx_project / knx_diagnose`

模型只填 JSON 参数，不生成电报字节——这是可靠性设计的关键：模型的错误被限制在"选错工具/填错地址"，而不是"发错帧把设备写坏"。

### 6.3 诊断规则库（现场价值最高）

| 代码 | 触发证据 | 下一步探针 |
|---|---|---|
| `GATEWAY_NO_ACK` | 网关不回隧道 ACK | 检查 IP/防火墙/隧道数（默认 4，ETS 常占满）→ 改用路由 |
| `NO_DEVICES` | 扫线无应答 | 29V 总线供电、终端电阻、接口是否同一线段 |
| `DUPLICATE_INDIVIDUAL_ADDRESS` | 同一 IA 多次应答 | 编程模式读串号，重编其中一个（重复 IA 会让下载静默失败） |
| `NO_DESCRIPTOR` | 应答但无描述符 | 设备异常态 / 半下载态 |
| `NEGATIVE_CONFIRMATION` | L_Data.con 错误位 | 冲突、帧过长、总线电平 |
| `HOP_COUNT_EXHAUSTED` | 跳数=0 | 耦合器层级（>3 级）或重复器配置 |
| `STEP_TIMEOUT` | 下载某步超时 | 断电重启、回读确认"下到哪了"再续 |

---

## 7. macOS 落地清单

**硬件**：任何 ETS 兼容的 KNXnet/IP 接口（MDT SCN-IP000.03、Weinzierl 730/732、Gira X1、Zennio ZSYIP、Theben IP）。**不要**指望 USB 调试棒——Apple Silicon + Windows ARM 的驱动是坑；Mac 侧更是无驱动。
**网络**：UDP 3671 放行；组播 224.0.23.12 需要交换机 IGMP snooping 正常，否则路由模式不可用（隧道模式不受影响）。
**软件**：
- 原型：`python3 -m knxagent.cli ...`，零依赖，Python 3.9+（Mac 自带 3.9 就能跑）。
- 生产化建议：Python 3.12 + `uv`，或用 Go（`knx-go`）/ Java（`calimero-core` + `calimeroserver`）打成单二进制，避免解释器运维。Calimero 是现成的 KNX 管理栈（隧道、路由、总线监视、设备管理、Secure），适合做长期底座。
**虚拟机**：UTM + Windows 11 ARM 仅用于录制/密钥分发，虚拟机里把 ETS 的接口设成"我方的录制代理"，这样一次配置永久受益。

---

## 8. KNX Secure 的硬门槛（必须提前和业主确认）

- **KNX IP Secure**：隧道建立需要设备认证码，会话用 Curve25519 交换 + AES-128-CCM；没有密钥连不上。
- **KNX Data Secure**：组通信加密，密钥在工程里（组密钥 + 工具密钥），工具密钥由工程密码派生。拿不到工程密码 = 改不了参数，但**录制回放仍可照抄密文**。
- 建议：把"密钥/密码移交"写进调试合同；否则 Secure 站点只能回退到 ETS。

---

## 9. 风险与合规边界

1. **保修**：ETS 是 KNX 官方唯一工具，第三方工具下载出问题厂商可拒保——商用项目需在合同里约定。
2. **不可逆操作**：`A_Restart(master)` 会清用户数据；原型把它单独成 op 并要求 recipe 显式声明。
3. **多厂商差异**：组地址表/关联表的写入方式随 mask 版本变化，必须**逐型号**验证后入库（这正是 recipe 库的价值：验过的型号永久复用）。
4. **仅用于自有或获授权站点**——本报告与原型面向自有工程、集成商自有客户、以及实验环境。

---

## 10. 路线图

| 阶段 | 内容 | 产出 |
|---|---|---|
| 第 1 周 | 真机联调：拿 2–3 个常见型号（MDT 执行器/调光器、Gira 面板）跑通扫描、编址、组值验收；校准属性服务与扩展内存 | 真机验证报告 + 修正后的常量表 |
| 第 2–3 周 | ~~录制代理~~（已完成）；接真实 ETS 跑一次完整下载，产出首批 recipe | 5 个产品的 recipe 库 |
| 第 1 月 | 组地址表/关联表写入按 mask 版本分档实现 + 回归 | 换点位"只刷表"能力 |
| 第 2 月 | 接入 MCP Server 暴露 13 个工具，接现场工单系统；审计日志与 dry-run 门禁 | Agent 上线 |
| 第 3 月 | Secure：IP Secure 隧道 + Data Secure 组密钥（有密码的前提下）；补 `calimero` 作为备选底座 | Secure 站点可用 |

---

## 11. DSH 插件化落地（2026-10 现状）

原型已从"独立 Python 库"演进为 **Harness 原生插件**，同一套协议实现同时服务 agent 与界面：

| 产物 | 位置 | 说明 |
|---|---|---|
| DSH 插件包 | `plugins/knx-agent/` | 零依赖（`node:dgram`、`node:zlib`），18 个工具 + 整页面板 |
| Python 原型 | `knxagent/` | 参考实现与 43 项协议测试，作为交叉验证基线 |
| 面板（Client 半） | `plugins/knx-agent/client.js` | `main` 面板 + `sidebar.panellist` 图标 |

**架构上的关键决定**：应用操作只有一份实现（`lib/ops.js`），agent 工具与面板 HTTP 桥（同源 `POST /knx/api/op`）都调用它。因此 UI 不可能与模型"各做一套"：一次面板点击与一次工具调用在审计里并列（`panel:simulator` / `knx_simulator`），失败原因也同源。静态安装包没有 client→host RPC 通道，这条同源路由就是桥。

**只读巡检模式**：配置 `allowWrites: false` 时，写内存、写组值、下载、启动模拟器全部拒绝，HTTP 侧回 403——拿去客户机房只读取证是安全的。

**产品数据同步**：`.knxprod` 深解析（段基址 + 位偏移 + 类型位宽 → 绝对地址；通信对象表；硬件↔应用映射），导入后与工程里的设备按 `ProductRefId` / `Hardware2ProgramRefId` 自动对链，`knx_build_download` 直接由参数值生成"字节写 + 位级读改写"配方。解不出的参数标 `unresolved`，绝不编造地址。

**ETS 录制代理**：`lib/proxy.js` 是真正的 KNXnet/IP 反向代理——ETS 连代理、代理连网关，只改通道号、改写 CONNECT_RESPONSE 的 HPAI、序号不动，逐帧落 JSONL；`knx_recipe_from_capture` 离线把某台设备的下载转成配方。闭环已在模拟器上跑通：走代理下载 → 捕获 → 生成配方 → 直连复放 → 回读一致。

**按规范校正的细节**（来源：[OpenKNX wiki](https://github-wiki-see.page/m/OpenKNX/OpenKNX/wiki/Information-about-KnxProd)、[knxprod 解析实践](https://github.com/NickoScope/nickol-knx-mcp/blob/main/nickol_knx_mcp/appprog_parser.py)）：`LoadProcedures`（MergeId + `LdCtrlRelSegment`/`LdCtrlWriteRelMem`/`LdCtrlCompareProp`）描述下载的**形状**，与 knx_master 默认流程合并执行——这解释了为什么"重建路线"能拿到分段与顺序、却拿不到镜像字节；`ApplicationVersion` 是字节按 `高半字节.低半字节` 显示（16→1.0）；工程命名空间即 ETS 版本（/11 ETS4 … /21 ETS6.0、/22 ETS6.1）；产品 Id 中订单号被转义（`-`→`.2D`），可反推型号；通信对象元数据常挂在 `ComObjectRef` 且随参数变化，DPT 仅在全部声明一致时采用。

**传输补全**：新增 KNXnet/IP 组播路由（不占隧道），并按传输能力区分本地确认语义。

**组地址表/关联表**：按真实栈的实现核对（[thelsing/knx](https://github.com/thelsing/knx/blob/master/src/knx/address_table_object.h)：表即 MemoryWrite 的 `uint16` 数组，TSAP 为索引，关联表为排序的 (TSAP, ASAP) 对），已实现建模 + 编码 + 下载配方；基址不猜，用一次 ETS「下载组地址」的录制反推（`action:"infer"`）并按型号复用。模拟器可预演"设备只响应表内组地址"的后果。

**表 profile 持久化**：表基址按 `订单号 → 应用 id → 掩码` 三级键入库，`infer` 一次即固化，之后同型号 `build` 无需再校准（实测：录制 → infer → 无参 build，`profileSource: library:order`）。这把"换点位"从"每次录一段"降为"一条命令"。

**配方库**：录制/重建出的配方按"产品身份 + 内容指纹"入库——指纹去掉设备地址与备注，同产品多台设备归并一条，参数变化生成新版本并保留旧版本；入库时产品型号可从已导入工程自动补全，出场即 `knx_download {catalogId}`。

**安全审计**：发现并修复 2 个高危（面板桥未鉴权、录制代理默认绑 0.0.0.0）、2 个中危（代理通道泄漏/撞号、总线操作无串行化），详情见插件内 `docs/AUDIT.md`；面板桥现在走 Host 的 `connection.requestRejection`，无该服务时只接受回环 peer，并支持 `bridgeToken`。

**已验证**（`node test/smoke.mjs`，98 项全过）：协议字节向量、隧道/ACK/序号、分块内存读写、流水线扫描、组值 + DPT、recipe 预演/执行/回读、录制→回放、`.knxproj` 解析、面板桥（health / state / op / 未知操作拒绝 / 写入）、审计贯通。

**仍未验证**：真实网关与真实设备（组地址表掩码差异、`A_MemoryExtended_*` 支持度、属性实例编号），以及 KNX Secure 站点。这些是第 1 周真机联调的内容，插件在设计上把它们留成了可替换点。

## 11. 参考与已核实来源

- KNX 官方：ETS6 仅支持 Windows 11 x64、Linux/macOS 不支持 — [ETS6: Software requirements](https://support.knx.org/hc/en-us/articles/360018452180-ETS6-Software-requirements)；[ETS6 FAQ](https://www.knx.org/news/ets6-frequently-asked-questions)
- 协议实现参考（cEMI/APCI 常量与字节向量）：[XKNX (python-xknx)](https://xknx.io/)、[calimero-core](https://github.com/calimero-project/calimero-core)、[knx-go](https://github.com/mxcu/knx-go)
- 工程文件结构：[KNX Project Schema Documentation](https://support.knx.org/hc/fi/article_attachments/17389755651474)
- 设备侧 cEMI/对象服务器示例：[Weinzierl BAOS 用户指南](https://weinzierl.de/images/download/documents/baos/weinzierl_knx_baos_users_guide.pdf)

---

## 附录 A. recipe 示例

```json
{
  "schema": "knxagent.download/1",
  "device": { "ia": "1.1.10", "order": "AKH-0401.02", "app": "Dimmer 4f" },
  "options": { "chunk": 11 },
  "steps": [
    { "op": "ia_write", "ia": "1.1.10" },
    { "op": "memory_write", "address": "0x4000", "data": "<录制得到的应用镜像块>" },
    { "op": "memory_write", "address": "0x4700", "data": "0a00ff10" },
    { "op": "memory_expect", "address": "0x4700", "data": "0a00ff10" },
    { "op": "restart", "master": false },
    { "op": "group_expect", "ga": "3/1/5", "dpt": "9.001", "value": 21.5 }
  ]
}
```

## 附录 B. 自测

```
$ python3 -m unittest discover -s knxagent/tests -t .
Ran 43 tests ... OK
```

覆盖：APCI/控制字节向量、扩展帧阈值、确认帧镜像、隧道连接/心跳/序号/失败路径、分块内存读写、流水线扫描、属性读写、IA 写入、重启、组值 + DPT、工程与产品库解析、录制转 recipe、recipe 执行与失败中止、dry-run 无副作用、agent 工具分发与诊断。
