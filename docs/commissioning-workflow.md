# 现场作业流程

从"手里有一份调试好的工程"到"设备按新点位工作"，按这个顺序做，每一步都有明确的判读标准。

## 0. 开工前

- 知道网关 IP，确认 UDP 3671 可达、交换机没有隔离组播（走路由时需要）；
- 确认站点是否启用 **KNX Secure**：启用了就需要设备认证码/工程密码，否则只能继续用 ETS 做密钥分发；
- 拿到 `.knxproj`（工程）与厂商 `.knxprod`（产品库）。

## 1. 接入

```
knx_search                                  # 组播 + 单播找网关
knx_connect { gateway: "<ip>:3671" }        # 隧道；隧道被占满时用 layer:"routing"
knx_status                                  # 看 channel / rx / ackTimeouts
```

判读：`ackTimeouts > 0` 说明网关没应答——先查隧道数（ETS 常占满 4 条）与 IP 路由。

## 2. 找设备

```
knx_scan { line: "1.1", start: 0, end: 256 }
```

流水线扫描（每帧只在 IP 层等 ACK，响应后收集），理论 255 台在秒级。判读：

- **同一 IA 多次应答** → 重复地址，必须先用编程模式读串号重编，否则下载会静默失败；
- **有应答但无描述符** → 设备处于半下载/异常态。

## 3. 体检（推荐先跑一遍，只读）

```
knx_accept { line: "1.1" }
```

逐台比对工程与现场：是否在线、掩码是否一致（`MV-0705` ↔ `0x0705`）、工程里没有的地址、每台的组地址链接数，并生成可直接附到交接单的 Markdown 报告。它只读不写，可以随时跑。

判读：`mask-mismatch` 通常是装错型号或工程版本不符；`unexpected` 里出现的地址要么是遗留设备，要么是工程没同步。

想连**值**一起验，加期望值（会顺带读取工程里该线路的每个组地址）：

```
knx_accept { line: "1.1", readValues: true,
             expect: [{ ga: "1/1/3", dpt: "1.001", value: true }] }
```

`no-answer` 表示设备没有应答（表里没这个地址，或还没下过应用）；`value-mismatch` 表示答了但值不对（参数错）。

## 4. 认设备、比工程

```
knx_device_info { ia: "1.1.10", serial: true }   # 编程模式下才回串号
knx_import      { path: "site.knxproj" }
knx_import      { path: "vendor.knxprod" }
knx_library     { action: "resolve", ia: "1.1.10" }
```

`resolve` 会给出：产品型号、应用程序与掩码、参数地址表、通信对象与组地址链接。
字段解不出来时会明确标 `unresolved`——**不要**拿一个"看起来合理"的地址去写。

## 5. 编码校准（每个产品族一次）

参数写在哪个 bit、多字节怎么排，公开文档里没有统一答案。用一台**已调试好**的设备反推：它的内存里本来就是正确值。

```
knx_calibrate { ia: "1.1.10" }
```

工具会把 `msb/lsb × big/little endian` 四个变体分别编码，与设备实际字节比对，给出 `decisive` 或 `ambiguous`，命中的编码按产品族入库，之后 `knx_build_download` 自动套用。

## 6. 下发参数（工程值直接带入）

```
knx_build_download { ia: "1.1.10", useProjectValues: true }
knx_download       { recipe, dryRun: true }
knx_download       { recipe }                 # 真跑，失败即停并报告停在哪一步
```

- 字节对齐参数 → `memory_write`；
- 位级参数（1 bit 使能、4 bit 档位）→ `memory_patch`：**读原字节 → 只改该字段 → 写回**，邻居不受影响；
- 配方末尾的 `memory_expect` 是校验，不是装饰。

## 7. 下发组地址表 / 关联表（换点位只做这一步）

首次需要校准表基址（每个型号一次）：

```
# 在 ETS 里只做一次"下载组地址"，同时开着录制代理
knx_proxy            { action: "start", upstream: { host: "<网关IP>" } }
knx_group_table      { action: "infer", capturePath, ia: "1.1.10" }
                     → saved: order / application / mask 三级键
```

之后同型号：

```
knx_group_table { action: "build", ia: "1.1.12" }    # profileSource: library:order
knx_download    { recipe }
```

判读：写表后设备**只**响应表内组地址。表写到错地址比不写更糟，所以工具在基址未知时拒绝生成配方。

## 8. 验收

```
knx_ga_write { ga: "1/1/3", dpt: "1.001", value: 1 }
knx_ga_read  { ga: "1/1/3", dpt: "1.001" }
knx_monitor  { seconds: 10 }
```

- 有应答但值不对 → 参数错（回第 4 步）；
- 完全无应答 → 表里没有这个组地址（回第 5 步），或设备没下过应用（需录制复放）；
- DPT 用对：调光控制是 `3.007`（方向+步进），温度 `9.001`，时间 `10.001`，日期 `11.001`。

## 9. 首次遇到的新产品（录制一次）

```
knx_proxy { action: "start", port: 3671, upstream: { host: "<网关IP>" } }
# ETS（Windows/虚拟机）把接口指向这台 Mac，点一次"下载"
knx_proxy { action: "stop" }                          → capturePath
knx_recipe_from_capture { capturePath, ia: "1.1.10" } → 配方
knx_catalog { action: "install", recipePath, orderNumber: "<型号>" }
```

之后：`knx_download { catalogId, ia }`。同型号第二台设备**不用再录**——配方按内容指纹归并（设备地址与备注被剔除）。

## 10. 出问题时的诊断顺序

```
knx_diagnose { scan, frames, failedSteps }
```

规则库给出的每条结论都带"下一步探针"。常见四类：

| 现象 | 结论 | 下一步 |
|---|---|---|
| 网关不回 ACK | `GATEWAY_NO_ACK` | 查隧道数/防火墙 → 改路由 |
| 扫不到设备 | `NO_DEVICES` | 29V 供电、终端电阻、接口是否同段 |
| 同一 IA 多次应答 | `DUPLICATE_INDIVIDUAL_ADDRESS` | 编程模式读串号，重编一个 |
| 下载某步超时 | `STEP_TIMEOUT` | 断电重启 → 回读确认下到哪 → 续跑 |

## 11. 收工

- 配方与表 profile 都在 `~/.dsh/knx-library/`，是普通 JSON，随工程归档；
- 面板（侧边栏 **KNX**）可现场复现同一套操作：扫线、组值、下载、产品数据、录制代理、配方库、监听、诊断。
