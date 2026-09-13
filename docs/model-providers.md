# 第三方模型接入

LegalOS 支持 OpenAI Chat Completions 兼容接口。普通咨询及风险分类使用 `LLM_*`；合同与法律检索使用 DSH `0.1.5-rc.2`，其 `DSH_LLM_*` 可独立覆盖，空值回退至 `LLM_*`。

## DeepSeek Flash

官方文档：<https://api-docs.deepseek.com/zh-cn/>。模型名称以部署账号 `GET https://api.deepseek.com/models` 返回为准，不根据营销名称自动转换。当前验证目标为 `deepseek-flash`。

服务器 `api/.env` 中配置以下非敏感字段：

```dotenv
LLM_BASE_URL="https://api.deepseek.com"
LLM_MODEL="deepseek-flash"
DSH_LLM_PROVIDER="deepseek"
DSH_LLM_BASE_URL="https://api.deepseek.com"
DSH_LLM_MODEL="deepseek-flash"
```

`LLM_API_KEY`、`DSH_LLM_API_KEY` 填入部署账号的密钥，仅保存在服务器受保护环境文件或密钥管理系统，禁止提交 Git。若两条链路使用同一密钥，也须检查 PM2 环境是否残留旧覆盖值；更新环境后重启 API 才生效。不要把完整 `pm2 env`、环境文件或带鉴权头的请求打印到排障日志。

切换第三方供应商意味着咨询、合同正文及检索问题会由该供应商处理；正式业务使用应遵循组织的数据外发政策。连通验证只使用不含用户或合同信息的测试提示词。

## 验证与验收

在真实部署服务器的 `api` 目录运行：

```bash
npm run dsh:runtime-gate
npm run dsh:model-gate
npm run dsh:baijian-gate -- law
```

模型列表返回 200 仅证明鉴权与网络可用。模型闸门验证 DSH 实际生成；百鉴闸门验证模型工具调用、权威正文读取及引文核验。最终仍须从已登录页面新建无敏感信息的咨询/搜法请求，确认流式完成、刷新后报告可读；不得把 PM2 online 或健康检查通过当成业务验收完成。

切换失败时恢复原受保护环境配置并重启 API，不修改数据库中的历史报告或 DSH 会话。
