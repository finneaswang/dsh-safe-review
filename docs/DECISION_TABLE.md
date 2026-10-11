# 逐条判定表

0.3.3 源码静态核对 + 2026-10-11 DSH Desktop 实机会话证据（工作区 `work/desktop-approval-test`，tiered 模式）。目标：解释「为什么排查任务里几乎每一步都弹窗」，并给出每个入口的完整判定链。

## 判定链（tiered 模式）

1. **环境闸**（`src/index.ts` environmentProblem）：会话预设不是 Read Only / Workspace Write → 一律直接拒绝；父会话审批策略不是 ask → 拒绝。审核器与人工通道都不参与。
2. **硬拒绝**（`src/vendor/policy.ts` hardDenyReason + `src/policy.ts` assess 高危分支）：破坏性目标、外呼带凭据、特权工具名、保护路径写入等 → 直接拒绝，不弹窗。
3. **风险分级**（`src/policy.ts` assess）：`low` / `sensitive` / `unknown` / `high`。`high` 拒绝；其余进入第 4 层。
4. **资格地板**（`src/model-eligibility.ts`）：判定该调用是否**有资格**交给独立审核器。`sensitive` 永远不可晋升；不认识的原生工具落到兜底行，直接转人工，审核器不会被咨询。
5. **独立审核器**（Astra → Terra → Luna 三档，预算与账本见 docs/TIERS.md）：allow+low → 自动放行；其余 → 人工。
6. **人工原生窗**：唯一兜底；只认官方 UI 桥；拒绝/取消/超时 → 调用被拒。

## 逐条表

| 调用 | 分级 | 资格地板 | 结果 | 实测（2026-10-11） |
|---|---|---|---|---|
| bash：纯 `ls`/`echo` 复合（无管道/重定向/展开，目标为真实目录，workdir 在工作区内） | low（目录适配，0.3.3 新增） | 通过 | 审核器 allow → **自动** | 15:16 `ls -la` 无弹窗执行 ✓ |
| bash：白名单原语（printf/echo/pwd/cat/rg/grep/find… 单段、无展开） | unknown | 通过 | 审核器 allow → **自动**（消耗免费档额度） | 12:14 / 12:17 / 12:21 三个 printf 探针均无弹窗 ✓ |
| bash：含管道 `\|`、`2>/dev/null`、`&` | unknown | 拒：descriptor indirection / 后台执行 | **人工** | 14:12 `ls \| head` 弹窗 |
| bash：含 `$()`、`$VAR`、`*` 通配、`~` | unknown | 拒：dynamic expansion | **人工** | 14:13 `find ~/Library/…`、`~/.dsh` 系列 |
| bash：`cd`、`for`、脚本/解释器（非白名单可执行） | unknown | 拒：scripts/interpreters/wrappers | **人工** | 14:13 `cd …; for f in …; cat` |
| bash：目标含 `.dsh/.codex/.ssh/.git/node_modules` 等保护路径 | 读 sensitive / 改 **high** | 敏感不可晋升 | 读 → 人工；改 → **直接拒绝** | 14:13 读 `~/.dsh` 弹窗；12:16 写 `.codex/blockedv3.txt` 直接拒（文件未创建）✓ |
| bash：`.env`、credentials、id_rsa 等敏感文件名 | sensitive | 敏感不可晋升 | **人工** | 12:14 读 `.env.reviewprobe` 弹窗→允许一次 ✓ |
| read：工作区内普通文件 | low | 通过 | 审核器 → **自动** | （CLI live 测试覆盖；本会话无原生实例） |
| read：`.env*`/凭据文件（无论何处） | sensitive | 敏感不可晋升 | **人工** | 12:15 同一文件二次读弹窗→**用户拒绝→调用被拒** ✓（拒绝路径实测） |
| read：工作区外文件 | sensitive（outside workspace） | 敏感不可晋升 | **人工** | 14:13 读插件源码 5 次，每次弹窗 |
| write/edit：工作区内普通文件 | low | 通过 | 审核器 → **自动** | （CLI live 测试与 0.3.1 基线覆盖） |
| write/edit：保护路径、符号链接、硬链接 | high（写）/unknown（符号链接读） | — | **直接拒绝**或人工 | 12:16 ✓ |
| **glob / grep（原生工具调用）** | unknown（无已验证低风险适配器） | 兜底行：verified adapter | **必人工** | 14:13 grep 原生调用弹窗 |
| **todo_write** | unknown | 兜底行 | **必人工** | 14:12 弹窗 |
| **web_search** | unknown | 兜底行（不在 browser/web_fetch 分支） | **必人工** | — |
| browser/web_fetch：仅公共 HTTPS navigate/fetch | unknown | 通过 | 审核器 → **自动** | — |
| browser：点击/执行 JS/带查询参数或私有地址 | unknown | 拒：opaque effects / private-network | **人工** | — |
| 任意工具带 `sandbox_permissions: danger-full-access` 参数 | sensitive | — | **人工** | — |
| 工具名匹配 cordis/plugin_manager/permissions/sandbox 等 | high | — | **直接拒绝** | — |
| 会话处于 danger-full-access 预设 | 环境闸 | — | **全部直接拒绝**（fail-closed） | 14:10:52 四个调用连拒 ✓ |

## vendor 层结论（排查的「最后一步」）

`src/vendor/policy.ts` 的 `assessTool` 确实有一套宽白名单：`read/read_image/grep/glob/lsp` 归 allow，`todo_write/ask_user_question/skill` 等归 allow（trusted session state），`web_search/web_fetch` 归 allow。**但该函数没有被 gate 调用**——运行时只从 vendor 层 import 了 `hardDenyReason`（硬拒绝子集）。因此这套白名单不影响任何实际判定；原生 grep/glob/todo_write/web_search 的弹窗完全由 `src/policy.ts` 的 unknown 分级 + `src/model-eligibility.ts` 的兜底行决定。

这也解释了同一天里的不对称现象：shell 形式的 `ls`、`grep`、`find` 能走目录适配或白名单原语进审核器自动通过，而**原生工具形式**的 glob/grep 必弹窗——排查会话里 DSH 恰好大量使用后者（外加管道、`$()`、读工作区外源码），于是 25 次点击全部命中「地板之外」的组合。

若要在 0.3.4 减少这两类弹窗，可选：把 glob/grep/todo_write/web_search 加入资格地板（进审核器路径，保留模型否决），或为其新增只读适配器（免审放行，语义与 vendor 未接线白名单对齐）。二者都是策略决定：前者多消耗审核额度但保留独立否决，后者零额度但放弃模型把关。截至 0.3.3 发布，两者都未实施。

## 证据边界

上表「实测」列全部来自 2026-10-11 单机会话（session-469dc334 及其 15:16 续用），配置为 tiered + Read Only/Workspace Write + ask；标注「—」的行只有源码依据，无桌面实例。审核器 allow 的自动放行依赖当次模型判断，不构成对识别准确率的总体声明。
