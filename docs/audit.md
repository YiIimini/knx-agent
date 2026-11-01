# 审计报告：knx-agent（DSH 插件）

审计日期：2026-10-31 · 范围：`plugins/knx-agent`（约 5.7k 行：8 个 lib 模块 + 24 个工具 + 面板 + 录制代理 + 配方库）
方法：静态通读 → 运行期探测（未认证访问、绑定地址、并发、抖动）→ 协议对照（KNX 规范 + 社区实现）→ 修复 → 回归。

**结论**：发现 2 个高危、2 个中危、5 个低危/信息项，**全部已修或已定性**；回归 78 项自检连续 3 轮全绿；协议层与 ETS 真实载荷仍属"未验证"（见 §4）。

---

## 1. 安全

| ID | 等级 | 发现 | 证据 | 处置 |
|---|---|---|---|---|
| **A1** | **严重** | 面板桥 `/knx/api/*` **未认证即可访问**：`GET /knx/api/state` 返回 200，而同一监听上的 `GET /` 返回 401 | `curl` 实测（`state:200` / `root:401`） | 改为经 Host `connection.requestRejection()` 走同一套 Host/Origin + 浏览器凭证校验；无 `connection` 服务的组合退化为**仅回环地址**；另支持 `bridgeToken` 共享密钥。修复后未认证访问被拒（见 §3 复测） |
| **A2** | **严重** | 录制代理默认 `bind 0.0.0.0`，等于把总线暴露成**局域网可写的 KNX 网关** | 代码审查：`bindSocket(port)` 硬编码 `0.0.0.0` | 默认绑定 `127.0.0.1`；`bind` 只能由插件配置改；非回环绑定时在状态里写入显式告警 |
| **A3** | 高 | 代理通道无上限、ID 可能撞上活跃通道、客户端崩溃后通道与其上游 socket **永久泄漏** | 代码审查：`byClient` 仅在 `DISCONNECT_REQUEST` 清理 | 通道上限（默认 8，超出回 `E_NO_MORE_CONNECTIONS`）、ID 冲突规避、60s 空闲扫描（默认 5 分钟超时）、`sweptChannels`/`refusedChannels` 计数 |
| **A4** | 信息 | 桥暴露 `import`/`download`/`memoryWrite`，路径参数可读写主机文件 | 代码审查 | 定性为**业主自身权限**（同一凭证下的 agent 本就有文件工具）；已在 README 与本节说明，不做额外沙箱 |

## 2. 可靠性与正确性

| ID | 等级 | 发现 | 处置 |
|---|---|---|---|
| **B1** | 高 | 面板与工具可**并发驱动同一条隧道**（单序号计数器，捕获还要切换隧道层），交错会污染捕获、打乱序号 | 引入 `runtime.serialize()`；按 `BUS_OPS` 白名单串行化占用总线的操作，纯内存操作（status/library/catalog/project/diagnose）不排队，面板不被 60s 捕获阻塞 |
| **B2** | 中 | `A_PropertyValue_Write` 的 count 半字节用了**字节数** | 改为元素数（新 `count` 参数，默认 1）：4 字节单元素属性现在发 `0x10` 而不是 `0x40` |
| **B3** | 中 | 捕获 JSONL 写流无背压上限 | 4 MiB 上限丢弃并计 `droppedCaptureLines`；转发不受影响 |
| **B4** | 中 | `readCapture` 无大小上限 | 64 MiB 上限，超限显式报错 |
| B5 | 低 | 死代码：`parseHpai`、`MUTATING`、`LISTEN_*` | 删除；`describeFrame` 改为真正使用（捕获行加 `summary`，人工可读） |
| B6 | 低 | `locale/*.json` 的 tools 元数据停在 17 个工具 | 刷新为 24 个（中英双语） |

## 3. 复测（修复后）

```
node test/smoke.mjs            → all checks passed（连续 3 轮）
新增校验：bridge 拒绝非回环 peer(403)、Host 拒绝状态透传(401)、bridgeToken 强制(401/200)、
          代理默认绑定 127.0.0.1、捕获在独立驱动下可转录
```

轮询语义回归：`knx_ga_write` 在 routing 上"发出即成功"、在 tunnel 上仍等 `L_Data.con`（见上一轮 B 类修复）。

## 4. 未能验证的部分（诚实边界）

1. **真实网关与设备**：所有验证都在内置模拟器 + 回环多播上完成。真机差异集中在组地址表写入的掩码细节、`A_MemoryExtended_*` 支持度、属性实例编号约定。
2. **真实 ETS 载荷**：录制代理的转发/落盘/转配方已闭环，但没有跑过一次真实 ETS 下载；`LoadProcedures` 只给出下载形状，镜像字节在 ETS Product Store。
3. **KNX Secure**：IP Secure（设备认证码）与 Data Secure（工具密钥由工程密码派生）均未实现；此类站点必须继续由 ETS 分发密钥。
4. **Config schema**：linked 安装无法 import `@deepseek-ai/schemastery`，故 `Config.listConfigs` 显示 `absent`；配置在运行时校验（`runtime` 构造时剔除空串）。

## 5. 残余风险与建议

- **现场误操作**是最大风险而非代码缺陷：建议固定流程 —— `dry_run` → 回读 → 再执行；配方已强制携带 `memory_expect`/回读步骤。
- 代理一旦需要跨网段使用，请同时设置 `bind` 与 `bridgeToken`，并在交换机侧限制 3671/UDP 的源地址。
- 位序（bit0 = 首字节 MSB）按 KNX 惯例实现，必须在**首次真机**用回读确认；读错会立刻失败，不会静默写坏（配方内置回读）。

## 6. 定级说明

- 严重：可导致未授权**写总线**（A1、A2）。
- 高：可导致资源耗尽或数据损坏（A3、B1）。
- 中：错误行为可观测但影响有限（B2–B4）。
- 低/信息：代码卫生、元数据（B5、B6、A4）。
