# 使用 ZCode 连接器

[English](zcode.md) · [README](../README.zh-CN.md)

ZCode 连接器把本机 ZCode CLI（`zcode app-server --stdio`，ZCode Protocol v4）接到你的 relay，让助手驱动原生会话：创建工作上下文、提交输入、读取输出、应答权限请求。连接器关闭或重连时原生会话继续运行。

## 前置条件

- 本机安装 ZCode CLI（桌面版 bundle 或独立安装）。连接器按 `ZCODE_BIN`、桌面默认安装路径、`PATH` 的顺序解析。
- Node.js 24.13+。

## 配置

每个工作区目录注册一个实例：

```sh
agenvo-zcode instance add --id laptop-zcode --cwd /path/to/project \
  [--api-key-file /path/to/key] [--default-model providerId/modelId]
```

- `--api-key-file`（权限 0600）在运行时向宿主请求 provider 凭据时提供 coding-plan API key。
- `--default-model`：会话自身模型属于计划类 provider（其每轮凭据只有桌面宿主能铸造）时，发送换轨到该默认模型。请使用 CLI 可直接调用的个人 provider 模型。

之后与其他连接器一致：`agenvo-zcode connect https://RELAY`、`agenvo-zcode run`。

## 方法

| 方法 | 参数 | 说明 |
|---|---|---|
| `version.get` | `{}` | CLI 版本与 wire 版本 |
| `session.list` | `{}` | 会话列表与实时 phase（running / waiting_input / completedSuccess…） |
| `session.create` | `{text, mode?, planEnabled?}` | 建会话并提交首条输入（startNow） |
| `session.send` | `{sessionId, text, mode?}` | 追加输入；turn 运行中可能被排队 |
| `session.read` | `{sessionId, limit?, beforeRowId?}` | 有界游标分页读取；工具行做瘦身 |
| `session.stop` | `{sessionId}` | 打断当前 turn |
| `session.delete` | `{sessionId}` | 删除会话及历史（先 stop） |
| `session.rename` | `{sessionId, title}` | 重命名 |
| `session.compact` | `{sessionId}` | 原生 compact 回收上下文 |
| `interaction.list` | `{sessionId}` | 待处理权限请求与用户问题，含选项 id |
| `interaction.resolve` | `{sessionId, interactionId, optionId?/freeText?/action?}` | 应答并解除阻塞 |

ACK `accepted` 只表示已派发。订阅 `runtime.changed` 事件或轮询 `session.list`，再用 `session.read` 读输出。

## 会话所有权与可见性

CLI 限制每个会话同一时刻只有一个 runtime。本连接器创建的会话、或已在桌面关闭的会话（经共享会话库 resume）完全可操作。不要向桌面应用中当前活跃的会话发送消息：两个 runtime 叠加在同一会话上会破坏投影。本连接器写入的会话在桌面应用重新订阅列表后可见（重启或切换工作区）。

## 无浏览器客户端令牌

`apps/zcode/issue-token.mjs` 无头走完 OAuth 流程，为打不开浏览器的 agent 打印 `client_id` 与 access/refresh 令牌：

```sh
AGENVO_ADMIN_SECRET=… AGENVO_BASE_URL=https://relay.example.com node issue-token.mjs "my-agent"
```

refresh token 每次使用后轮换；每次刷新后持久化新值，否则整个授权被撤销。

## 诊断

`agenvo-zcode doctor` 检查 CLI 版本与 relay 可达性。连接器把原生诊断（模型错误、崩溃）以 JSON 行形式输出到 stderr。
