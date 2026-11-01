# 架构

## 分层

```
┌──────────────────────────────────────────────────────────────┐
│ 调用方                                                        │
│   agent 工具（25 个 knx_*）        面板 UI（8 张卡）           │
└───────────────┬──────────────────────────┬───────────────────┘
                │ tools.js                 │ http.js（同源 /knx/api）
                └──────────┬───────────────┘
                           ▼
                  ops.js  应用操作（唯一实现）
                           │
        ┌──────────────────┼────────────────────────────┐
        ▼                  ▼                            ▼
   library.js          catalog.js                   proxy.js
   knxprod.js          profiles.js                  gatable.js
   project.js                                       simulator.js
        └──────────────────┼────────────────────────────┘
                           ▼
                      link.js（设备管理）  dpt.js  diagnose.js  recipe.js
                           ▼
                      knxip.js（隧道 / 路由 / 总线监视）
                           ▼
                      cemi.js（cEMI + TPCI/APCI 编解码）
```

## 三条设计约束

**1. 一个操作，两个调用方。** 面板与 agent 走同一份 `ops.js`：一次 UI 点击和一次工具调用产生同样的结果、同样的失败原因、同一条审计记录（审计里两者并列：`panel:simulator` 与 `knx_simulator`）。UI 不可能与模型"各做一套"。

**2. 模型只填 JSON，不发电报字节。** 错误的工具选择或地址是可恢复的；手工拼帧不是。字节只由 `cemi.js` 生成，并被向量测试钉死。

**3. 一条总线一条队。** 插件持有单个隧道（单序号计数器），捕获还要临时切换隧道层。`runtime.serialize()` 让占用总线的操作排队（`BUS_OPS` 白名单），纯内存操作（状态、库、解析、诊断）不排队——否则 60 秒的捕获会把面板卡死。

## 数据流：一次"从工程下发"

```
.knxproj ──project.js──▶ 设备 / IA / 参数值 / 组地址 / 通信对象链接
.knxprod ──knxprod.js─▶ 应用 / 段基址 / 参数位宽位偏移 / 通信对象号 / LoadProcedure
                     │
              library.js（resolve：设备 → 产品 → 应用 → 地址表）
                     │
      ┌──────────────┴───────────────┐
      ▼                              ▼
buildDownload（参数块）        gatable.buildTables（组地址表 + 关联表）
 memory_write / memory_patch     address table: uint16[TSAP]
      └──────────────┬───────────────┘
                     ▼
              recipe（有序步骤，可 dry-run）
                     ▼
              link.js → cemi.js → 总线
```

## 录制路径

```
ETS（Windows/虚拟机）──▶ proxy.js ──▶ 真实网关
                            └─ captures/*.jsonl（每帧：方向、服务、地址、字节）
                                    ▼
                          recipe.js captureToRecipe（连续写合并）
                                    ▼
                          catalog.js（产品身份 + 内容指纹去重、版本保留）
                                    ▼
                          knx_download { catalogId, ia } —— Mac 侧复放
```

## 为什么 profile 要单独存

表格式简单（`uint16` 数组），难的是**表在设备内存里的地址**——写错比不写更糟。所以：

- 基址只能"观测"得到：一次 ETS"下载组地址"的录制里，用已知组地址表去匹配；
- 观测结果按 `订单号 → 应用 id → 掩码` 三级键持久化，越具体越优先；
- 找不到 profile 时**拒绝生成配方**，并说明怎么校准。

## 测试策略

`plugin/test/smoke.mjs` 98 项，分四层：

1. **字节层**：APDU/控制字节向量、扩展帧阈值、DPT 编解码；
2. **传输层**：隧道连接/心跳/序号/失败路径、组播路由；
3. **语义层**：扫描、内存分块、属性、组值、配方执行、表下载后设备"只响应表内地址"；
4. **流程层**：录制 → 配方 → 入库 → 按 `catalogId` 下载、面板桥鉴权、基址反推。

`python-prototype/` 是早期参考实现（43 项），保留用于交叉验证常量与字节序列——两套实现互相印证，胜过单一实现的自信。
