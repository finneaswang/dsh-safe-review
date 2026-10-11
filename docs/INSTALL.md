# 安装与配置

目标为 DSH Desktop 0.2.0-rc.2、Cordis 4.0.4、macOS Apple Silicon。其他版本和平台尚未获得相同的 Desktop 验收。

## 准备与备份

停止正在运行的 DSH 任务。备份 `~/.dsh/profiles/desktop/` 内的 package、Cordis 配置与 patch、锁文件，以及 `~/.dsh/safe-review/budget/` 的账本。保留现有工作区配置；密钥单独留在本机。

从 GitHub Release 下载 `.tgz` 并核对随包的 `SHA256SUMS.txt`，通过 DSH 官方插件入口安装。也可以在项目目录运行：

```sh
dsh plugin --profile desktop add "$PWD/dist/finneas-dsh-safe-review-0.3.3.tgz" --ignore-scripts
```

如果命令提示 pnpm store 不一致，使用提示中原有 store 路径作为 `--store-dir`；不要为此重新配置全局 store。

## 启用三档审核

在 Desktop profile 的 `cordis.patch.yml` **更新已有** `finneas-safe-review` 条目；没有该条目时才新增。不要创建重复实例。

```yaml
- id: finneas-safe-review
  config:
    reviewerMode: tiered
    primaryTokenLimit: 250000
    secondaryTokenLimit: 2500000
    paidDailyUsd: 1
    reviewerTimeoutMs: 30000
    approvalTimeoutMs: 300000
    maxOutputTokens: 2048
```

保持工作区或只读权限、`ask` 审批，停用其他自动回答审批的插件。`paidDailyUsd: 0` 禁止第三档请求，额度不足后转人工。两组上限须根据自己的账户计划调整，公开接口不会自动确认免费资格。

## 密钥

在本机双击以下助手，输入隐藏，不要把密钥发到 issue 或聊天：

- `scripts/设置审核API密钥.command` 保存普通项目 API Key 到 `~/.dsh/safe-review/openai.key`。
- `scripts/设置用量查询密钥.command` 保存独立 Admin Key 到 `~/.dsh/safe-review/admin-usage.key`。

助手需要 macOS 的 zsh 和 Python 3；也可从终端直接运行对应 Python 脚本。目录须本人所有、权限 700，密钥文件权限 600，不接受链接。助手不会覆盖已有密钥。Admin Key 只用于固定 Usage/Costs GET 查询，不发送给审核模型或用量界面。

完整退出并重开 DSH，输入 `/safe-review`，检查版本、模式、审批通道。打开插件详情确认用量面板，再按 [演示步骤](DEMO.md) 测试。

## 升级、回退

0.3.3 将可完整识别的非递归目录查看交给正常自动审核，包括 `ls -la ~/.dsh/` 及静态 `echo` 标题。三档模式仍核对用户指令，审核服务或用量不可用时仍转人工。读取文件内容、递归扫描、动态命令和配置写入沿用原规则。GitHub 发布不会自动升级本机；安装后需完整退出重启并复验。

回退前另存当前配置与账本，通过官方入口安装保留的旧 `.tgz` 并恢复对应插件配置，重启后检查权限和审批。0.3 会导入旧 `daily-budget.json` 当日用量；0.2 不会反向读取 `tier-budget.json` 的新增消费。因此保留两代账本并核对当天用量，不通过删除账本清零。
