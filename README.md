# DSH Safe Review

为 DeepSeek Harness Desktop 提供独立模型审批、原生人工确认和三档用量面板。

An independent approval-review plugin for DeepSeek Harness Desktop. Deterministic checks and a one-use execution guard constrain model decisions; sensitive and uncertain actions use the native human approval window.

**兼容目标：DSH Desktop 0.2.0-rc.2、Cordis 4.0.4、macOS Apple Silicon。** 这是独立社区项目。当前仓库版本 **0.3.2**，从已在开发机验收的 0.3.1 整理而来；版本差异见 [变更记录](CHANGELOG.md)。

## 审批行为

| 操作 | 处理 |
|---|---|
| 普通工作区文件、可以完整分析的简单终端操作 | 规则或独立模型审核，低风险可自动批准 |
| 敏感目标、删除、外部写入、扩权、不透明脚本 | 原生窗口逐次确认 |
| 明确系统破坏、凭据外传、修改审批或关键配置 | 拒绝 |
| 模型、网络、用量或预算不可用；风险不明确 | 转人工，未确认不执行 |

Browser 简单 HTTPS 导航已有适配；点击、页面脚本、Computer Use、未知 MCP、子代理和 PTC 容器默认人工确认。PTC 内部工具调用仍单独经过门禁。模型没有工具执行权限，批准绑定到一次具体调用和完整人类授权上下文。

## 三档与面板

默认顺序为 **GPT-6 Astra → GPT-5.6 Terra → GPT-6 Luna**，按两组 token 估算余量切换，按 UTC 换日；没有“50 次请求”阈值。前两组默认上限分别为 250,000 和 2,500,000 token，第三档默认本地预算 **US$1/天**。

这些数字是可调整的本地参数，不保证任何账户具有免费资格。US$1 只约束第三档，不覆盖前两档可能产生的费用。面板综合官方用量与本地预扣显示预计余量；账户预付余额显示“未知”。详见 [计量规则](docs/TIERS.md)。

在 **插件 → @finneas/dsh-safe-review** 查看用量；切档或预算不足时通过官方 Toast 提示。`/safe-review` 查看当前状态。

## 安装

从 [Releases](https://github.com/finneaswang/dsh-safe-review/releases) 下载插件 `.tgz`，或从源码构建：

```sh
npm ci --ignore-scripts
npm run verify
mkdir -p dist
npm pack --ignore-scripts --pack-destination dist
```

安装前停止 DSH 任务并备份 Desktop profile 和预算。通过 DSH 官方插件入口安装本地包，更新已有的 `finneas-safe-review` 配置条目，保持“工作区内修改”或“只读”，审批为 `ask`。完整步骤、双密钥设置及回退见 [安装说明](docs/INSTALL.md)。

默认模式为 `advisory`，可在不配置 OpenAI 密钥时使用规则审批；三档独立模型模式需要普通项目 API Key 和独立用量查询 Admin Key。密钥由本机隐藏输入助手保存，权限 600，不写入仓库或 DSH 配置。模型接口固定为 OpenAI Responses API，`store:false`；相关人类指令和工具参数会发送到 OpenAI，账户的数据共享设置单独生效。

## 演示和验证

[三步桌面演示](docs/DEMO.md) 展示普通操作、敏感确认和保护路径拦截。

```sh
npm run verify
npm run check:publication
node scripts/product-smoke.mjs dist/finneas-dsh-safe-review-0.3.2.tgz
node scripts/restart-smoke.mjs dist/finneas-dsh-safe-review-0.3.2.tgz
```

自动化检查使用合成数据，不读取用户密钥或调用真实模型。显式运行 `scripts/live-review-eval.mjs` 才会调用真实 API、产生可能的费用；它只审核合成案例，不执行案例中的工具。已验证内容和未验证范围见 [验证记录](docs/TEST_RESULTS.md)。

## 安全边界与来源

本插件保留宿主沙箱，通过最终 guard 重新检查调用身份、参数和上下文，批准不可在重启后复用。普通 Node 插件无法隔离同进程恶意插件、卸载后的调用或已批准脚本的内部行为。它也不等价于 Codex 的整体隔离机制。

项目复用 NanmiCoder/dsh-auto-mode 的 MIT 路径与 Shell 分析基础；完整来源及许可证见 [第三方说明](THIRD_PARTY_NOTICES.md) 和 [审计记录](docs/AUDIT.md)。项目使用 [MIT License](LICENSE)。

- [安全问题报告](SECURITY.md)
- [开发与贡献](CONTRIBUTING.md)
- [可选自动构建模板](docs/CI.md)
