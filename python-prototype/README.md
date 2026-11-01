# knxagent —— 在 macOS 上调试 KNX 的 agent 运行时

零第三方依赖（Python 3.9+）。目标：把 KNX 有线系统的现场调试（找设备、编址、读参数、写组地址、下载、验收、诊断）从 ETS 的鼠标流程，变成可脚本化、可审计、可被 LLM 调用的工具面。

> 配套阅读：[docs/KNX-Agent-macOS-研究报告.md](docs/KNX-Agent-macOS-研究报告.md) —— 路线选择、协议细节、KNX Secure 门槛、风险与路线图。

## 快速开始（不需要任何硬件）

```bash
# 1. 起一个 KNXnet/IP 网关模拟器（3 台虚拟设备：执行器 / 调光器 / 卷帘）
python3 -m knxagent.cli serve --port 3671

# 2. 另开一个终端
python3 -m knxagent.cli search --no-multicast --host 127.0.0.1
python3 -m knxagent.cli scan  --gateway 127.0.0.1:3671 --line 1.1 --end 8
python3 -m knxagent.cli info  --gateway 127.0.0.1:3671 --ia 1.1.1
python3 -m knxagent.cli ga    --gateway 127.0.0.1:3671 --ga 3/1/5 --dpt 9.001 --value 21.5

# 3. 真机
python3 -m knxagent.cli scan --gateway 192.168.1.50 --line 1.1
python3 -m knxagent.cli run  --gateway 192.168.1.50 --recipe examples/recipe-dimmer.json --dry-run
```

## 命令

| 命令 | 说明 |
|---|---|
| `search` | 发现 KNXnet/IP 网关（组播 / 指定 IP） |
| `scan` | 流水线扫描一条线（`A_DeviceDescriptor_Read`，一次发一窗再收） |
| `info` | 设备身份：描述符 / 掩码 / 串号（编程模式下） |
| `read` / `write` | 设备内存读写（自动分块到 15 octet，超长走扩展帧） |
| `monitor` | 抓总线（`--busmon` 用总线监视隧道，能看个体管理帧） |
| `ga` | 组值读写 + DPT 编解码 |
| `project` | 解析 `.knxproj`（工程）/ `.knxprod`（产品库导出） |
| `capture` | 把一段下载流量转成可复用 recipe |
| `run` | 执行 recipe（`--dry-run` 只校验不落地） |
| `plan` | 把调试意图（JSON）编译成工具调用计划 |
| `selftest` | 跑全部测试 |

## 代码地图

| 模块 | 职责 |
|---|---|
| `cemi.py` | cEMI + TPCI/APCI 编解码；内存/属性/IA/描述符/重启/串号/组值 |
| `knxip.py` | KNXnet/IP：搜索、描述、隧道（序号/ACK/心跳）、总线监视、路由 |
| `link.py` | 设备管理层：分块内存读写、扫描、属性、重启、串号、组值 |
| `dpt.py` | DPT1/5/6/7/9/12/13/14/16 |
| `download.py` | recipe 模型、录制转 recipe、执行器（失败即停 + 逐步报告 + dry-run） |
| `project.py` | `.knxproj` / `.knxprod` 解析（命名空间无关、容忍 ETS4/5/6 差异） |
| `agent.py` | 13 个 MCP 兼容工具、运行时、诊断规则库、意图→计划 |
| `simulate.py` | 回环 KNXnet/IP 网关 + 虚拟设备（测试与演练） |

## 设计原则

1. **模型不发电报字节**。LLM 只填 JSON 参数，字节由编解码层生成；错误被限制在"选错工具/填错地址"，而不是"发错帧写坏设备"。
2. **不可逆操作要显式声明**。`restart(master)` 会清用户数据，必须写在 recipe 里；默认先 `dry_run`，跑完必须回读。
3. **每一步都留证据**。执行报告含每步耗时与结果，`runtime.audit` 记录工具调用，总线帧可回放复盘。
4. **不假装能做的事**。完整应用镜像重建依赖厂商产品库，原型只承诺：编址、参数块、组地址表/关联表、验收、诊断。完整下载走"录制回放"。

## 测试

```bash
python3 -m unittest discover -s knxagent/tests -t .
# 43 tests, OK
```

包含：APCI/控制字节向量（ETS 真机字节）、扩展帧阈值、确认帧镜像、隧道失败路径、分块内存读写、流水线扫描、属性读写、IA/重启/组值、工程与产品库解析、录制→recipe、recipe 执行与中止、dry-run 无副作用、agent 分发与诊断。
