# knx-agent（DSH 插件）

在 Mac 上完成 KNX 有线系统（TP1）的**现场调试、下载与验收**，不需要 ETS，也不需要 Windows 虚拟机。
本插件把 KNX 协议栈整套做成 Harness 原生模块：KNXnet/IP 隧道、cEMI 编解码、设备管理、下载配方、诊断规则，以及一个内置总线模拟器。

零第三方依赖：只用 `node:dgram` 与 `node:zlib`。装上即用，`node test/smoke.mjs` 可自检。

## 工作流

```text
1. knx_simulator {action:"start"}        没有硬件时先演练（起一个 3 设备的虚拟网关）
2. knx_search / knx_connect              找网关、开隧道（busmonitor 层才能看到下载报文）
3. knx_scan {line:"1.1"}                 流水线扫线，返回 IA + 掩码版本
4. knx_device_info / knx_property_read   认设备、读身份
5. knx_download {recipe, dryRun:true}     先校验计划，不碰设备
6. knx_download {recipe}                  真跑，逐步报告，失败即停
7. knx_ga_write / knx_ga_read            按 DPT 打点验收
8. knx_diagnose                          把观测变成结论与下一步探针
```

从 ETS 迁移：在一台 Windows（虚拟机即可）里让 ETS 走一次下载，`knx_capture` 录成 recipe，之后在 Mac 上 `knx_download` 无限次回放——协议公开，卡的只是"下载内容"。

## 面板（Client 半）

侧边栏多一个 **KNX** 图标，点开是整页调试面板：

- **连接栏**：状态胶囊（已连接/未连接/模拟器端口）、网关输入、连接/断开、模拟器启停；
- **扫线**：输入线路号 → 设备表（IA + 掩码），点击即用；
- **组值**：GA + DPT + 值，写入/读取，回读即时显示；
- **下载**：配方 JSON 编辑框 → validate / 预演 / 执行，逐步表格（op / 成败 / 耗时 / 细节）；
- **监听**：采集 N 秒总线报文（个体管理帧也能看到）；
- **诊断**：拿最近一次扫描和报文跑规则库，结论带"下一步探针"。

面板与 agent **共用同一套操作实现**（`lib/ops.js`）：UI 通过同源 `POST /knx/api/op` 调用，工具直接调用；两侧结果、失败原因、审计记录完全一致。审计里能看到 `panel:simulator` 与 `knx_simulator` 并列。

> 静态安装包没有 client→host RPC 通道，所以面板走同源 HTTP 路由 `/knx`（`kind: 'prefix'`），而不是任何形式的私有桥。

## 工具（24 个）

| 工具 | 作用 |
|---|---|
| `knx_search` | 组播/单播发现网关 |
| `knx_connect` | 建/复用隧道（`link` 或 `busmonitor`） |
| `knx_disconnect` | 断开并释放网关通道 |
| `knx_status` | 连接、计数器、只读策略、操作审计 |
| `knx_scan` | 流水线扫描一条线路 |
| `knx_device_info` | 描述符/掩码、串号（编程模式） |
| `knx_memory_read` / `knx_memory_write` | 设备内存读写（下载的原子操作） |
| `knx_property_read` | 接口对象属性（身份、表、应用 id） |
| `knx_ga_read` / `knx_ga_write` | 组值读写，按 DPT 编解码 |
| `knx_monitor` | 采集总线报文 |
| `knx_download` | 执行 recipe（`dryRun` 只校验） |
| `knx_capture` | 把一段下载录成 recipe（`install:true` 直接入库） |
| `knx_validate_recipe` | 不接设备校验 recipe |
| `knx_project` | 解析 `.knxproj` / `.knxprod`（即时、不入库） |
| `knx_import` | 把 `.knxprod` / `.knxproj` 导入本地库 |
| `knx_library` | 库操作：list / show / resolve / forget |
| `knx_build_download` | 按参数内存布局生成配方（位级参数用读改写） |
| `knx_proxy` | ETS 录制代理：启停、状态、捕获文件列表 |
| `knx_recipe_from_capture` | 把捕获文件转成某台设备的可复放配方 |
| `knx_catalog` | 配方库：入库/列表/查找/套用/版本/删除 |
| `knx_accept` | 批量验收：工程 vs 现场逐台比对 + Markdown 交接报告（只读） |
| `knx_group_table` | 组地址表/关联表：plan / build / infer（基址校准） |
| `knx_diagnose` | 诊断规则库 |
| `knx_simulator` | 内置网关启停 |

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `gateway` | `""` | `ip` 或 `ip:port`；留空则用模拟器 |
| `port` | `3671` | 默认端口 |
| `layer` | `link` | 默认隧道层 |
| `ackTimeoutMs` / `confirmTimeoutMs` / `responseTimeoutMs` | 1500 / 400 / 2000 | 传输超时 |
| `scanSettleMs` | 600 | 扫描收集窗口 |
| `allowWrites` | `true` | 设 `false` 则写内存/组值/下载/起模拟器全部拒绝（只读巡检模式），HTTP 侧返回 403 |
| `simulatorDevices` | 3 台 | 模拟器设备表 `[{ia,name,descriptor}]` |

## 模块布局（可单独复用）

| 文件 | 职责 |
|---|---|
| `lib/cemi.js` | cEMI/TPCI/APCI 编解码（含 10bit APCI 掩码陷阱与扩展帧阈值） |
| `lib/knxip.js` | KNXnet/IP：搜索、描述、隧道（序号/ACK/心跳）、路由、总线监视 |
| `lib/link.js` | 设备管理：分块内存、流水线扫描、属性、重启、串号、组值 |
| `lib/dpt.js` | DPT1/5/6/7/9/12/13/14/16 |
| `lib/recipe.js` | recipe 校验、占位符、执行器、录制转换 |
| `lib/project.js` | `.knxproj` 工程解析 + 自带 ZIP 读取 |
| `lib/knxprod.js` | 产品数据深解析：段地址、参数位宽/位偏移、通信对象、硬件↔应用映射 |
| `lib/library.js` | 本地库：导入/索引/设备→产品解析/配方生成（含位级读改写） |
| `lib/proxy.js` | KNXnet/IP 反向代理：把 ETS 挡在录制层后面，边转发边落盘 |
| `lib/catalog.js` | 配方库：按"产品 + 内容指纹"去重、版本化、套用到设备 |
| `lib/diagnose.js` | 诊断规则库 |
| `lib/simulator.js` | 回环网关 + 虚拟设备 |
| `lib/runtime.js` | 连接状态、审计、模拟器生命周期 |
| `lib/ops.js` | 应用操作：工具与面板的唯一实现 |
| `lib/tools.js` | 18 个工具的定义与参数校验（声明式绑定到 ops） |
| `lib/http.js` | 面板桥（经 Host 鉴权 / 回环兜底 / 可选 token） |
| `client.js` | 面板 UI（`main` 面板 + `sidebar.panellist` 图标） |

这些模块不依赖 Harness，可单独 `import` 到脚本、MCP server 或测试里。

## ETS 录制代理（拿首次下载）

```
knx_proxy {action:"start", port:3671, upstream:{host:"192.168.1.50", port:3671}}
   → ETS 里把接口改成「这台 Mac 的 IP:3671」，照常下载
knx_proxy {action:"stop"}            → 返回 capturePath（JSONL）
knx_recipe_from_capture {capturePath, ia:"1.1.10"}
   → 该设备的可复放配方（连续内存写自动合并）
knx_download {recipePath}            → 之后在 Mac 上直连网关复放，不再需要 ETS
```

代理只改 **通道号**，报文其余部分原样转发；`CONNECT_RESPONSE` 里的 HPAI 改指向自己（否则 ETS 会绕过录制器直连网关）；序号不动——代理是上游该通道的唯一客户端，双方 ACK 记账天然对齐。捕获按 `.jsonl` 逐行落盘，崩溃也不会丢已录部分。

## 从规范/社区核对过的细节（本轮据 [OpenKNX wiki](https://github-wiki-see.page/m/OpenKNX/OpenKNX/wiki/Information-about-KnxProd) 与 [knxprod 解析实践](https://github.com/NickoScope/nickol-knx-mcp/blob/main/nickol_knx_mcp/appprog_parser.py) 校正）

| 事实 | 落进代码的影响 |
|---|---|
| `.knxprod` 里应用在 `M-*/Hardware.xml` + `M-*/M-*_A-*.xml`，不是单一 knxprod.xml | 解析器始终遍历压缩包内全部 XML |
| `ApplicationVersion` 是字节，ETS 显示为 `高半字节.低半字节`（16 → 1.0） | 新增 `applicationVersionText` |
| 命名空间即 ETS 版本：project/11=ETS4、/13=5.5、/14=5.6、/20=5.7、/21=ETS6.0、/22=6.1 | 解析时记录 `schemaVersion`，兼容性诊断有据 |
| 产品库可带 `LoadProcedures`（MergeId 控制项 `LdCtrlRelSegment` / `LdCtrlWriteRelMem` / `LdCtrlCompareProp`），ETS 把它**合并**进 knx_master 的默认流程 | 新增 `procedures` 解析：能读出下载的**形状**（分段、相对写、属性校验），但不含镜像字节 |
| 产品 Id 里订单号被转义：`-` → `.2D` | 新增 `orderNumberFromProductId()`，工程里只有 Id 时也能反推型号 |
| 通信对象常把名称/DPT 放在 `ComObjectRef` 上，且 ref 是**参数相关变体** | 合并策略：只填空字段；DPT 仅在全部声明者一致时采用，不一致保留 `dptVariants` 不猜 |
| `ObjectSize="1 Bit"/"1 Byte"` | 解析为 `bits`，供参数宽度与验收判断 |

## 数据点与传输补全

- **DPT 2/3/4/10/11**：2 bit 受控位、4 bit 调光控制（方向+步进，`down/3` → `0b1011`）、字符、时间、日期；
- **KNXnet/IP 路由**：`knx_connect {layer:"routing"}` 走组播 224.0.23.12，不占隧道（ETS 常把 4 条隧道占满）；路由无本地确认，链路层已按传输能力区分——`write` 在路由上"发出即成功"，在隧道上仍等 `L_Data.con`。

## 配方库（第二次调试零录制）

```
knx_catalog {action:"install", recipePath:…, ia:"1.1.2"}
   → id: recipe:AKH-0401.02:9b59e9f499   （产品身份自动从工程解析出来）
knx_catalog {action:"install", …}          → reused:true（同内容不同设备/不同备注都归一条）
knx_download {catalogId:"recipe:…", ia:"1.1.10"}   → 直接跑，无需再录制
```

- **指纹只覆盖内容**：去掉设备地址与备注，同一产品的两台设备归并成一条；参数变了就是新版本（旧版本保留，可回滚）；
- 入库时可只给 `ia`，产品型号/应用/掩码由已导入的工程自动补全；
- 一条记录带 `versions[]`（每版指纹/时间/来源）与 `uses`，现场复用次数可查。

## 组地址表 / 关联表（换点位不必整包重下）

模型已按真实栈实现核对（thelsing/knx 的 `TableObject`/`AddressTableObject`/`AssociationTableObject`）：**表就是按 MemoryWrite 下发的 16 位数组**，地址表每槽一个 GA、TSAP 即索引；关联表是排序后的 (TSAP, ASAP) 对。

```
knx_group_table {action:"plan",  ia:"1.1.2"}          → 3 个 GA / 3 条关联，并告诉你基址未知
knx_group_table {action:"build", ia:"1.1.2",
                 addressBase:20480, associationBase:20736}
  → 0x5000: ffff 0903 0904 0905      (未用槽 + 三个组地址)
  → 0x5100: 0001 0001 | 0002 0001 | 0003 0002   ((TSAP, ASAP) 对)
knx_download {recipe}                                  → 写表 + 重启
```

**基址绝不猜**：表写到错地址比不写更糟（设备会响应错的组地址）。基址来源有两条：显式给，或——更可靠——`knx_group_table {action:"infer", capturePath, ia}` 从一次 ETS「下载组地址」的录制里**观测**出来，并按 `订单号 / 应用 id / 掩码` 三级键**存进产品库**（`~/.dsh/knx-library/grouptable-profiles.json`）。之后同型号只要一条命令：

```
knx_group_table {action:"infer", capturePath:…}     → 0x5000 / 0x5100，已存 3 个键
knx_group_table {action:"build", ia:"1.1.10"}       → profileSource: "library:order"，无需再校准
```

查找顺序 订单号 → 应用 id → 掩码，越具体越优先（同掩码不同产品可能表地址不同）；每次使用计 `uses`，可用 `action:"profiles"` 审计、`forget` 删除。

模拟器可预演后果：`knx_simulator {tables:{addressBase, associationBase}}` 后下载表，设备**只**响应表里列出的组地址（实测：`1/1/3` 有答、`1/1/9` 无答）。

## 从工程直接下发（能力边界，务必先读）

导入一个调试完成的 `.knxproj` 后，`knx_build_download {ia, useProjectValues:true}` 会用**工程里记录的参数值**生成该设备的下发配方并执行：

```
knx_import examples/site.knxproj
knx_build_download {ia:"1.1.2", useProjectValues:true}
  → device P-dim-time = 300 → memory_write 0x4700 = 012c
knx_download {recipe}
  → 写入 + 回读校验 + 重启
```

**能做的**：参数块下发、位级参数读改写、重启、组值验收、诊断、按产品复放已录制配方。
**不能做的**（当前实现）：应用镜像（程序代码）下发——它不在工程/产品库导出里，只能靠 `knx_proxy` 录一次。组地址表/关联表已实现（见上一节），但**表基址需按型号校准一次**。

## 产品数据与工程同步（导入即解析）

```
knx_import examples/acme-dimmer.knxprod   → 应用 M-0002_A-1234：4/5 个参数已定位地址
knx_import examples/site.knxproj          → 2 台设备、3 个组地址、2 个通信对象
knx_library resolve {ia:"1.1.2"}          → 设备 → 产品 AKH-0401.02 → 应用 → 参数地址表
knx_build_download {values:{...}}         → 配方：字节写 + 位级读改写
```

- 地址来自产品数据本身：`Static/ParameterSegment`（段基址）+ `Memory/@Offset`（位）+ `ParameterType/TypeNumber/@Size`（位宽），也支持 `Memory/@Address` 绝对地址；
- 解不出的参数**不给假地址**：标 `unresolved` 并写进 warnings；
- 位级参数（如 1 bit 使能、4 bit 档位）走 `memory_patch`：读原字节 → 只改该字段 → 写回，邻居参数不受影响；
- 数字进制：`0x…` 按十六进制、纯数字按十进制、含 a-f 按十六进制；`addressBase` 可按厂商导出习惯覆盖。读错进制会写错地址，所以生成配方时总带 `memory_expect`/回读——错误立刻可见，而不是静默损坏。

## 安全模型（审计后）

面板桥会写总线，所以它不是开放路由：

1. **经 Host 校验**：组合里有 `connection` 服务时，每个请求都走它的 Host/Origin + 浏览器凭证检查（与页面其它接口同权）；
2. **无 connection 时只认回环**：非回环 peer 直接 403，避免"局域网可达 = 谁都能写总线"；
3. **可选共享密钥**：配置 `bridgeToken` 后，每个请求必须带 `x-knx-token`；
4. **录制代理默认绑 `127.0.0.1`**：要跨网段使用必须显式改配置，且状态里会写入告警；
5. **一个总线一条队**：占用隧道/总线监视的操作串行执行（`BUS_OPS`），纯内存操作不排队。

完整发现清单与复测见 [docs/AUDIT.md](docs/AUDIT.md)。

## 边界（重要）

- **完整应用镜像只能录制回放**：ETS 的产品库编译结果不在公开格式里；编址、参数块、组地址表、验收、诊断可纯协议完成。
- **KNX Secure**：IP Secure 需要设备认证码，Data Secure 的工具密钥由工程密码派生；没有密钥只能照抄密文，换参数即失效。
- 协议层已在模拟器上端到端验证（`node test/smoke.mjs`，**103 项**，含录制代理、配方库、路由、组地址表语义、表 profile 持久化与桥鉴权）；真实网关/设备仍需逐型号校准：组地址表写入的掩码差异、`A_MemoryExtended_*` 支持度、属性实例编号约定。
- 仅用于自有或获授权站点。
