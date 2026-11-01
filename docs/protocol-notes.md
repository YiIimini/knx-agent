# 协议笔记：cEMI、APCI 与 KNXnet/IP

写给需要改这套代码的人。每条都对应过一次真实的失败或一个只能靠规范判断的岔路。

## 1. cEMI 帧

```
L_Data: [cEMI 码][附加信息长度][Ctrl1][Ctrl2][源 IA×2][目标×2][NPDU 长度][TPDU…]
        0x11 = req   0x29 = ind   0x2E = con
Ctrl1:  FT(1=标准帧) | 重复 | 系统广播 | 优先级 2bit | ACK 请求 | 确认错误
Ctrl2:  AT(1=组地址) | 跳数 3bit | 扩展帧格式
```

ETS 发出的标准组帧控制字节是 `0xBC / 0xE0`，个体寻址帧是 `0xBC / 0x60`。

**扩展帧阈值**：NPDU（APDU）长度 ≤ 15 用标准帧；> 15 必须切扩展帧（Ctrl1 bit7 清零），长度字段仍是 1 字节（上限 254）。大块内存写一定会遇到——一条 `A_Memory_Write` 的 APDU 是 2 字节头 + 2 字节地址 + N 字节数据，所以**数据最多 11 字节**才是标准帧。

## 2. APCI 是 10 bit，这是最大的坑

```
APDU[0] = TPCI(6bit) << 2 | APCI[9:8]
APDU[1] = APCI[7:0]（带 4bit 参数的服务：低半字节是参数）
```

- **内存服务**（`A_Memory_Read` 0x0200 / `A_Memory_Write` 0x0280 / `A_Memory_Response` 0x0240）的低半字节是**元素个数**，必须按掩码 `0xFFF0` 匹配；
- **属性服务**（`A_PropertyValue_Read` 0x03D5 / `_Response` 0x03D6 / `_Write` 0x03D7）的低半字节是**服务本体**，按掩码匹配会把 `A_PropertyValue_Write` 误判成 `A_MemoryBit_Write`；
- **`A_PropertyValue_Write` 的第三字节高半字节是"元素个数"，不是字节数**：写 4 字节的单元素属性必须发 `0x10`，发 `0x40` 会被真机判为越界。

已固化为回归用例（`plugin/test/smoke.mjs` 的 codec 段与 `python-prototype/tests/test_codec.py`）。

## 3. 组值编码

| 情形 | APDU |
|---|---|
| 1 字节且 ≤ 0x3F（DPT1） | `[APCI, 0x80|v]` 优化形式 |
| 其余 | `[APCI, 0x00, …data]`（写）/ `[APCI, 0x40, …data]`（响应） |

解码时用"有没有 payload + 第二字节 bit7"区分优化形式，两种都接受。

## 4. KNXnet/IP

| 服务 | ID | 说明 |
|---|---|---|
| SEARCH / DESCRIPTION | 0x0201–0x0204 | 发现网关；DIB 里设备信息块长 54 字节，串号字段**恰好 6 字节** |
| CONNECT / CONNECTIONSTATE / DISCONNECT | 0x0205–0x020A | 隧道；普通网关通常只有 4 条 |
| TUNNELLING_REQUEST / ACK | 0x0420 / 0x0421 | 每帧一个序号 + 一个 ACK，**不 ACK 对端会被重传直至断链** |
| ROUTING_INDICATION | 0x0530 | 组播 224.0.23.12，**无本地确认**，只有真实 KNX/IP 路由器才转个体管理帧 |

工程要点：

- 隧道序号必须严格递增并等 ACK；心跳（CONNECTIONSTATE）120s 内必须发一次；
- 路由没有 `L_Data.con`，链路层必须按传输能力区分"发出即成功"；
- 录制代理要改写 `CONNECT_RESPONSE` 里的 HPAI 指回自己（否则 ETS 绕过代理直连网关），但**不能动序号**（代理是上游该通道的唯一客户端，双方记账天然对齐）。

## 5. 设备管理的四类下载

| 类型 | 服务 | 可行性 |
|---|---|---|
| 个体地址 | `A_IndividualAddress_Write` / 串号写 | 纯协议可做 |
| 参数块 | `A_Memory_Write`（地址来自产品数据的段基址 + 位偏移） | 纯协议可做 |
| 组地址表 / 关联表 | 同为 `A_Memory_Write`（表即 `uint16` 数组，TSAP 是索引） | 可做，但**表基址按型号校准** |
| 应用镜像 | 大量 `A_Memory_Write` + 重启 | 只能录制复放 |

## 6. 数字与位序

- 产品数据里的地址常写成十六进制但**不一定带 `0x`**：`0x…` 按十六进制、纯数字按十进制、含 `a-f` 按十六进制；读错进制会写错地址，因此生成的配方**总是带回读**，错立刻暴露；
- 位序按 KNX 惯例：**bit 0 是首字节的最高位**。首次真机必须用回读确认。
