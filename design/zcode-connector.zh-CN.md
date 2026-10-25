# ZCode 连接器设计

把本机 ZCode CLI 的 app-server 纳入 Agenvo 的连接器体系：远端助手经 relay 的 `search`/`execute` 驱动原生会话。协议依据与验证基线见文末。

## 用户目标

- 在云端助手里创建、续写、读取本机 ZCode 会话；断线不中断原生轮次。
- 会话中的权限请求、用户问题作为交互暴露给调用方，由调用方决定。
- 不复制原生状态：会话、队列、交互的权威始终在 CLI runtime。

## 架构

```
Connector (apps/zcode)
├─ protocol.ts  NDJSON stdio 客户端：请求关联、服务端反向请求应答、启动就绪门
├─ zcode.ts     Adapter：spawn app-server；sessions-index / workspace-config /
│               conversation topic 订阅；provider 账户信封；resume 物化；事件转发
├─ methods.ts   原生方法目录（zod → JSON Schema）
└─ backend.ts   实例配置（binary 解析：ZCODE_BIN → 桌面 bundle → PATH）
```

一个实例对应一个工作区（CLI 的 workspaceKey 模型）；每实例一个 app-server 子进程，连接器重启即重建进程，原生会话状态在共享会话库中不受影响。

## 协议要点（ZCode Protocol v4，wire 3）

- 传输：stdio NDJSON，信封 `{id, method, params}` / `{id, result|error}`（无 jsonrpc 字段）。
- 读：`v4/conversation/subscribe` 订阅 `sessions-index/<workspaceId>`、`conversation/<sessionId>`；帧经 `v4/conversation/frame` 通知投递，snapshot 后按 seq 连续 delta；行分页用 `v4/conversation/rowsRange`（游标 `beforeRowId`）。
- 写：`v4/command` 信封（commandId uuid 重试不变）；ACK 只表示裁决，状态以投影回流为准。
- 服务端反向请求：`session/requestRuntimePreferences`（运行偏好）、`interaction/requestProviderRuntimeHeaders`（请求期凭据，从 api-key-file 应答）、其余 host UI 面请求按无头环境拒绝。

## 关键设计决策

**resume 物化**：其他客户端创建的会话只存在于共享会话库。`session.send/stop/delete/…` 前调用 `session/resume` 物化（幂等），使跨客户端会话可操作。这是上游冷恢复通道的正规用法；对桌面端当前活跃的会话注入会造成双 runtime，属协议边界，在方法描述与文档中显式声明而不是在连接器内做活性探测。

**模型选择**：冷恢复会话必须显式携带 modelSelection。会话自身模型优先；当其属于计划类 provider（`account:zai-*`，每轮凭据仅桌面宿主可铸造）时换轨到实例 `defaultModel`。个人 provider 直接使用磁盘凭据。

**账户信封**：进程级 registry 需要账户 overlay 才暴露账户 provider。`basedOnZCodeBuiltinRevision` 必须等于运行时实际值（`zcode-builtin:<release>:<sha256(激活文件绝对路径)>`，运行时从 `~/.zcode/v2/runtime/provider` 取最新版本目录推导）；start-plan 类 overlay 必须显式携带 `builtinModelIds`（缺省即权威空列表）。

**有界输出**：`session.read` 对工具行做字段瘦身（超长 input/output 截断），配合游标分页满足 relay 64 KiB 帧限；完整载荷留在原生侧。

**交互投影**：pendingInteractions 在 snapshot 整体给出、在 delta 中以 `{op:"state.updated", patch}` 键级整体替换；连接器镜像该语义，投影保留 `optionId/label/optionKind` 供调用方选择。交互绝不自动应答。

**读就绪门**：会话列表来自首帧 snapshot；连接建立时等待该帧（超时放行），避免调用方在健康 runtime 上观察到空目录。

## 执行语义映射

| 原生 ACK | Outcome |
|---|---|
| accepted / noop / duplicate | `accepted` |
| rejected / failed | `rejected` |
| stale | `unknown`（读原生状态后再决定重试） |

## 验证基线

- 本地：真实 app-server 上跑通 握手 → 建会话（首输入 startNow）→ phase 事件 → rowsRange 读取 → resume 后跨进程 send → delete/rename/compact。
- 全链路：relay（OAuth 客户端）→ connector → 模型真实回复；交互投影字段与上游 zod schema 逐字段核对。
- 待补（上游测试体系）：`tests/adapters` 隔离用例、与 CLI 版本矩阵的回归。

## 边界

- 每会话单 runtime：桌面活跃会话不可注入；桌面列表对连接器写入的会话在重订阅前不可见。根治需上游提供跨 runtime 命令入口。
- wire 版本（当前 3）变化时需重验；`version.get` 暴露版本辅助判断。
