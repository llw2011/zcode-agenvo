# @agenvo/zcode

[English](README.md)

附着本机 ZCode CLI 的 `app-server`（stdio，ZCode Protocol v4），把会话暴露给远端助手：创建会话、提交输入、读取输出、应答权限请求。关闭连接器不影响原生会话运行。

需要 Node.js 24.13+ 和本地 ZCode CLI。该连接器为实验性实现，跟随上游 ZCode Protocol 演进；依赖前请对照你的 CLI 版本验证行为。

- 自动定位 CLI（桌面版 bundle 路径、`ZCODE_BIN` 或 `PATH`）。
- 每个实例对应一个工作区目录；其他客户端创建的会话经 `session/resume` 物化后可操作。
- 实例设置 `--default-model providerId/modelId` 时，发送会显式携带该模型选择；计划类 provider 的每轮凭据只有桌面宿主能铸造，因此换轨到该默认模型。

[配置和使用 ZCode 连接器](https://github.com/Xuanwo/agenvo/blob/main/docs/zcode.zh-CN.md)

`issue-token.mjs`（位于本目录）可针对任意 relay，用管理员密钥为无浏览器 MCP 客户端铸造 OAuth 凭据。

## 许可证

Apache-2.0。ZCode 是 Z.ai 的产品；本连接器仅通过其公开的 app-server 协议依赖 CLI，不包含 Z.ai 代码。
