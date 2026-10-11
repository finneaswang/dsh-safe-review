# 可选 GitHub Actions

`ci/verify.yml` 和 `ci/release.yml` 是固定官方 Action 提交的自动构建模板，目前没有放进 `.github/workflows/`，因此不会自动运行。

首次发布时，当前 GitHub OAuth 登录没有 `workflow` 写入权限。源码及安装包发布不需要扩大该权限，现有验证记录来自本机执行。

需要启用时，由仓库所有者在已具有相应权限的 GitHub 登录中，把这两个模板复制到 `.github/workflows/` 并提交。不要配置普通 API Key 或 Admin Key：构建检查均使用合成数据，发布使用 GitHub 自带的短期 token。

- Verify：main 推送和 pull request 时进行类型检查、构建、492 项测试、打包检查及三个独立 CLI 进程的恢复验证，并提供安装包 artifact。
- Release：推送与 package version 对应的 `v*` tag 后，执行完整验证并创建含安装包和 SHA-256 清单的 GitHub Release。发布 job 需要仓库 contents 写入权限。

模板当前使用 macOS runner 和 Node.js 22.20.0。更改依赖版本或支持平台后，先完成对应验证，再更新模板和说明。
