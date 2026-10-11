# 三档审核（0.3.1）

这是 0.2.0 审批门禁上的增量改造。权限边界、人类授权上下文、原生确认、执行前再次核对和一次性授权保持原有实现。

## 切换规则

1. 第一档：GPT-6 Astra，使用第一组每日免费 token 的估算余量。
2. 第二档：GPT-5.6 Terra，第一组不足以覆盖完整下一次审核时切入第二组。
3. 第三档：GPT-6 Luna，两组余量都不足时使用付费 API。

50 次只是早期粗略估算，不是计数阈值。这里配置的每日池上限为第一组 250,000、第二组 2,500,000 token；它们是可调整的本地默认参数，不是 Usage API 自动发现或对其他账户承诺的权益。各组与组织其他应用共用，按 UTC 午夜重置。当天只向下切档，次日回到第一档。

模型仍然只负责判断；它不能执行工具，也不能读取管理员密钥。拒绝后不会再找低档模型重新审核。敏感操作、未知语义、服务异常、用量查询过期仍转原生人工确认。

## 数字的含义

- 官方已用：Usage API 返回的 input + output，缓存输入已经包含在 input 内。
- 估算余量：依据官方累计、本地基线、已结算用量和未结算预扣计算；不重复扣本插件已被官方统计的用量。
- 公式：`max(官方已用高水位, 首次基线 + 本地已结算) + 未结算预扣`。
- 第三档本地预算：初始为每天 US$1，可在插件配置调整；只限制第三档，不覆盖前两档可能产生的费用，也不是账户余额。预扣按输入、输出分别计价，包含缓存写入价格上界。免费组的标价折算成本也不是实际扣费。
- 账户费用：Costs API 查询到的今日、本月费用，可能含调整记录，可能延迟。
- 账户预付余额：官方公开 Usage/Costs 接口没有已核实的余额查询能力，因此显示“未知”，附账单页入口。

使用全部组织用量作保守估算。只固定识别当前选用的 GPT-6 家族和 GPT-5.6 Terra/Luna；其他模型的 token 计入两组，避免遗漏后高估免费余量。仍不能保证外部并发、账单延迟、促销变更或项目取消数据共享后每次都免费。免费资格应保持在调用普通 API Key 所属项目上。

## 密钥与查询进程

- 普通审核密钥：`~/.dsh/safe-review/openai.key`。
- 独立查询 Admin Key：`~/.dsh/safe-review/admin-usage.key`。
- 文件权限为 0600；专用目录为 0700；拒绝符号链接、硬链接、错误权限或错误密钥种类。
- 只读查询进程访问固定的 OpenAI Usage / Costs GET 接口，拒绝重定向。它的输出只包含计量数字。
- 审核进程只接收汇总结果，子进程不继承普通推理密钥或 NODE_OPTIONS。
- 查询每分钟一次；五分钟内的数据可用于路由。任何分页失败都不把部分数据当完整账户用量。
- 这不是对同一 macOS 用户下恶意本机程序的强隔离；任意同用户代码仍可能访问其文件。插件门禁只能约束受支持的 DSH 工具执行路径。

## 界面与重启

通过官方 `shell.overlay` 的 Toast 显示切档提示，插件详情显示三档卡片。只读 RPC 不包含批准、运行命令或修改配置能力。重启初次连接显示当前档位，不重放旧提示；后续切换再提示。

账本保留每日档位、请求身份、预扣和切换记录。旧版当日 token 继承到第二档，标记旧费用未知；不会因升级清零。重启不会切到 Full Access。

## 官方来源

- [模型与计价](https://developers.openai.com/api/docs/pricing)
- [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
- [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions)
- [Costs API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs)

开发机 0.3.1 已完成真实账户查询、三档请求、用量卡片、原生审批与重启检查；预算不足提示已被实际观察，两个切档短提示及提示按钮动作未逐项确认。公开版本的验证范围见 [验证记录](TEST_RESULTS.md)。
