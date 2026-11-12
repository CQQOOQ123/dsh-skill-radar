# Security Policy

## Scope

`dsh-skill-radar` 是一个本地单机插件，设计上只监听 loopback，并由本机 DSH 实例使用。

## Protections

- 写接口要求同源 `Origin`、写 token / SameSite Cookie，并只接受 loopback；
- 安装需要人工确认，或显式开启 `full + autoAcquire`；
- 安装后校验完整性，失败自动回滚；
- 状态文件写前备份，损坏时自动恢复；
- 资源路径限制在 storeDir 与技能安装目录内；
- 置顶技能不可被自动禁用。

## Known limitations

- 安全预检是静态启发式，不保证覆盖所有恶意代码；
- 没有发布者公钥基础设施（PKI）；
- 没有多用户鉴权；
- 在线搜索结果来自第三方，默认视为不可信。

## Reporting

如果你发现安全问题，请不要公开 Issue 细节，先通过仓库维护者提供的私下渠道联系，并附上：

- 版本；
- 复现步骤；
- 影响范围；
- 是否涉及本机数据。

在修复前请不要公开利用细节。
