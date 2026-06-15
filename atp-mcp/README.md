# AnswerThePublic MCP Server

把 AnswerThePublic 的公开 REST API 包成一个 **远程 MCP server**,部署后拿到一个 HTTPS URL,作为 **自定义连接器(Custom Connector)** 接入 Claude.ai,就能在对话里直接让 Claude 跑关键词研究、读报告。

> Claude 的连接器只认 **MCP 协议**,不能直接贴一个普通 REST API 的网址进去——这个服务就是中间那层"翻译"。

---

## 暴露给 Claude 的工具

| 工具 | 作用 | 是否消耗额度 |
|------|------|------|
| `atp_me` | 查 token 绑定的 workspace / 套餐 / scopes(健康检查) | 否 |
| `atp_create_search` | 跑一个关键词(可指定 provider) | **是** |
| `atp_get_search` | 轮询某个 provider 的 search 状态/快照 | 否 |
| `atp_list_searches` | 列出历史 parent searches(可按词/语言/地区/provider 过滤) | 否 |
| `atp_get_report` | 读结构化报告(questions / prepositions / comparisons / alphabeticals + 搜索量/CPC/意图/情感),支持各种过滤排序 | 否 |
| `atp_ai_prompts` | 列出 ChatGPT/Gemini 报告的 AI prompts | 首次/报告 **是** |
| `atp_ai_answer_request` | 请求生成 AI 答案 | **是** |
| `atp_ai_answer` | 轮询 AI 答案结果 | 否 |

典型流程:`atp_create_search` → 轮询 `atp_get_search` 到 `completed` → `atp_get_report` 读结果。
同一 `keyword + language + region` 24 小时内重复跑会**复用、不重复扣费**。

---

## 前置条件

1. AnswerThePublic **付费套餐**(免费工作区无法用 API)。
2. 在 **Account → API Access** 里 **开启 API 访问**,并创建一个 Personal Access Token(`atp_pk_live_` 开头,**只显示一次,复制好**)。
3. 创建 token 时勾选 scopes:至少 `searches:read`、`searches:write`、`reports:read`;要用 AI 工具再加 `ai:read`、`ai:write`。

---

## 本地跑(可选,先验证)

```bash
npm install
cp .env.example .env        # 填入你的 ATP_TOKEN
npm run build
npm start                   # 监听 :3000,MCP 端点是 POST /mcp
```

冒烟测试:

```bash
curl -s http://localhost:3000/                              # {"status":"ok",...}
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'        # 应列出 8 个工具
```

要在本地直接接 Claude,可用 `cloudflared tunnel --url http://localhost:3000` 临时拿一个公网 HTTPS 地址。生产请正式部署 👇

---

## 部署(三选一,都能拿到公网 HTTPS URL)

### A. Railway(最快)
1. 把这个项目推到 GitHub。
2. Railway → New Project → Deploy from repo。
3. Variables 里加 `ATP_TOKEN`(Railway 会自动注入 `PORT`)。
4. 部署后 Settings → Networking → Generate Domain,得到 `https://xxx.up.railway.app`。
   **连接器 URL = `https://xxx.up.railway.app/mcp`**

### B. Render
1. New → Web Service,连 GitHub repo(用本仓库的 `Dockerfile`)。
2. Environment 加 `ATP_TOKEN`。
3. 拿到 `https://xxx.onrender.com`,**连接器 URL = `.../mcp`**。

### C. Fly.io(Docker)
```bash
fly launch --no-deploy
fly secrets set ATP_TOKEN=atp_pk_live_xxx
fly deploy
```
连接器 URL = `https://<app>.fly.dev/mcp`。

---

## 接入 Claude.ai

1. Claude.ai → 右下角头像 → **Settings → Connectors**(需 Pro/Max 及以上;Team/Enterprise 由 Owner 在 Organization settings → Connectors 添加)。
2. 点 **Add custom connector**。
3. 名称随意(如 `AnswerThePublic`),URL 填你的 **`https://.../mcp`**。
4. 保存,在对话的工具菜单里启用该连接器。

> 鉴权说明:本服务把你的 ATP token 放在**服务端**(`ATP_TOKEN` 环境变量),连接器本身走无 OAuth 模式,靠 URL 私密性保护。详见下方安全建议。

验证:在 Claude 里说 **"用 AnswerThePublic 确认一下我的 workspace 和额度"**,它会调 `atp_me`。然后试 **"用 gweb,以 en/my 跑一下 'invisalign subang jaya',完成后给我 questions 这一类按搜索量排序的前 20 个词。"**

---

## 安全建议

- 这是一个**无鉴权的公网端点**,谁拿到 `/mcp` URL 就能消耗你的 ATP 额度。把 URL 当机密对待。
- 加固做法(任选):放到 **Cloudflare Access / Tunnel** 后面、用平台自带的 IP allowlist、或在前面加一层 OAuth 代理。需要的话我可以再给你加 OAuth(Claude 连接器 Advanced settings 支持 OAuth Client ID/Secret)。
- token 泄漏时,去 AnswerThePublic 的 API Access 页面**撤销**该 token,或关掉 workspace 的 API 开关(立即作废所有 token)。

---

## 扩展

所有端点封装在 `src/atp.ts`,工具注册在 `src/server.ts`。要加新工具:在 `atp.ts` 写一个 wrapper,在 `server.ts` 用 `server.tool(name, desc, zodShape, handler)` 注册即可。
