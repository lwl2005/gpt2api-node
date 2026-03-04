# GPT2API Node

基于 Node.js + Express 的 OpenAI Codex 反向代理服务，支持多账号管理、自动刷新 token、负载均衡，提供 OpenAI 兼容的 API 接口和完整的管理后台。

## 界面预览

<table>
  <tr>
    <td width="50%">
      <img src="screenshots/管理员登录.png" alt="管理员登录" />
      <p align="center">管理员登录</p>
    </td>
    <td width="50%">
      <img src="screenshots/仪表盘.png" alt="仪表盘" />
      <p align="center">仪表盘</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="screenshots/API keys.png" alt="API Keys管理" />
      <p align="center">API Keys 管理</p>
    </td>
    <td width="50%">
      <img src="screenshots/账号管理.png" alt="账号管理" />
      <p align="center">账号管理</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="screenshots/数据分析.png" alt="数据分析" />
      <p align="center">数据分析</p>
    </td>
    <td width="50%">
      <img src="screenshots/系统设置.png" alt="系统设置" />
      <p align="center">系统设置</p>
    </td>
  </tr>
</table>

## 功能特性

- ✅ OpenAI Codex 反向代理
- ✅ 完整的 Web 管理后台
- ✅ 多账号管理和批量导入
- ✅ 自动 Token 刷新机制
- ✅ 负载均衡（轮询/随机/最少使用）
- ✅ API Key 管理和认证
- ✅ 请求统计和数据分析
- ✅ 支持流式和非流式响应
- ✅ OpenAI Chat Completions + Completions(legacy) + Responses 三接口兼容
- ✅ API Key 级别用量统计接口（`/v1/usage`）
- ✅ API Key 限流与每日配额（`rpm_limit` / `daily_limit`）
- ✅ Token 自动熔断与冷却恢复（失败一次即冷却，冷却时长按连续失败次数叠加）
- ✅ 全局并发保护（防止服务雪崩）
- ✅ 批量删除账号功能
- ✅ 实时活动记录
- ✅ 管理后台可视化运行状态面板（并发/熔断/健康）
- ✅ 管理后台支持在线调整运行参数（默认可在线写入并实时生效）
- ✅ API Key / Token 高级筛选与批量操作
- ✅ 请求日志条件筛选与 CSV 导出
- ✅ 后台一键清理历史日志（按天数）

## 快速开始

### 方式一：Docker 部署（推荐）

使用 Docker Compose 一键部署：

```bash
# 克隆项目
git clone https://github.com/lulistart/gpt2api-node.git
cd gpt2api-node

# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f
```

服务将在 `http://localhost:3000` 启动。

### 方式二：本地部署

#### 1. 安装依赖

```bash
cd gpt2api-node
npm install
```

#### 2. 初始化数据库

```bash
npm run init-db
```

初始化说明：
- 用户名来自 `ADMIN_USERNAME`（未配置时固定为 `admin`）
- 密码来自 `ADMIN_PASSWORD`（未配置时固定为 `Gpt2api@2026`）
- 自定义密码时策略为：至少 12 位，且必须包含大小写字母、数字和特殊字符
- 建议首次登录后立即修改默认账号密码

#### 3. 启动服务

```bash
npm start
```

开发模式（自动重启）：

```bash
npm run dev
```

#### 4. 访问管理后台

打开浏览器访问：`http://localhost:3000/admin`

使用初始管理员账户登录后，请立即修改密码。

## 管理后台功能

### 仪表盘
- 系统概览和实时统计
- API Keys 数量
- Token 账号数量
- 今日请求数和成功率
- 最近活动记录

### API Keys 管理
- 创建和管理 API Keys
- 查看使用统计
- 启用/禁用 API Key
- 配置每分钟限流（`rpm_limit`）
- 配置每日配额（`daily_limit`）
- 支持在列表中在线编辑并保存限流参数
- 支持关键字/状态筛选
- 支持批量启用、批量禁用、批量删除

### 账号管理
- 批量导入 Token（支持 JSON 文件）
- 手动添加账号
- 批量删除账号
- 批量启用/禁用账号
- 查看账号额度和使用情况
- 刷新账号额度
- 负载均衡策略配置
- 查看熔断状态（连续失败次数、冷却截止时间）
- 支持按关键字和状态（启用/冷却/禁用）筛选

### 数据分析
- 请求量趋势图表
- 模型使用分布
- 账号详细统计
- API 请求日志
- 日志关键字/状态筛选
- 日志 CSV 导出

### 系统设置
- 修改管理员密码
- 负载均衡策略设置
- 在线调整运行参数：
  - `API_KEY_DEFAULT_RPM_LIMIT`
  - `MAX_CONCURRENT_PROXY_REQUESTS`
  - `TOKEN_CIRCUIT_BREAKER_THRESHOLD`（固定为 `1`，失败一次立即进入冷却）
  - `TOKEN_COOLDOWN_MINUTES`
  - `TOKEN_HEALTHCHECK_INTERVAL_SECONDS`
  - `TOKEN_HEALTHCHECK_TIMEOUT_MS`
  - `TOKEN_HEALTHCHECK_CONCURRENCY`
- 数据维护：按天数手动清理历史日志 + 可选自动清理

## 负载均衡策略

支持三种负载均衡策略：

1. **轮询（round-robin）**：按顺序依次使用每个账号
2. **随机（random）**：随机选择一个可用账号
3. **最少使用（least-used）**：选择请求次数最少的账号

可在管理后台的账号管理页面或通过环境变量配置。

## API 接口

### 聊天完成接口

**端点**: `POST /v1/chat/completions`

**请求头**:
```
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

**请求示例**:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": false
  }'
```

**流式请求**:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": true
  }'
```

### 文本补全接口（legacy）

**端点**: `POST /v1/completions`

兼容 OpenAI 旧版 Completions 请求格式（`prompt`）。

```bash
curl http://localhost:3000/v1/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "prompt": "写一个 hello world 函数",
    "stream": false
  }'
```

### 引擎补全别名（legacy）

**端点**: `POST /v1/engines/:model/completions`

OpenAI 旧版 Engines 风格别名，效果等同于 `/v1/completions`。

```bash
curl http://localhost:3000/v1/engines/gpt-5.3-codex/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "写一个 hello world 函数",
    "stream": false
  }'
```

兼容边界说明（Completions）：
- 当前仅支持 `n=1`
- 暂不支持 `suffix`
- 暂不支持 `best_of>1`
- `stream=true` 时暂不支持 `echo=true`

未实现的 OpenAI 接口族（如 `embeddings` / `images` / `audio` / `assistants` 等）会返回 `501 endpoint_not_implemented`。

### Responses 接口

**端点**: `POST /v1/responses`

支持标准 `input` 字段，也兼容 `messages` 透传。

```bash
curl http://localhost:3000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "input": "用一句话介绍这个项目",
    "stream": false
  }'
```

### 模型列表

**端点**: `GET /v1/models`

```bash
curl http://localhost:3000/v1/models
```

### 单模型查询

**端点**: `GET /v1/models/:modelId`

```bash
curl http://localhost:3000/v1/models/gpt-5.3-codex
```

### API Key 元信息

**端点**: `GET /v1/keys/me`

```bash
curl http://localhost:3000/v1/keys/me \
  -H "Authorization: Bearer YOUR_API_KEY"
```

返回中包含：
- `rpm_limit`：每分钟限流上限（0 表示不限流）
- `daily_limit`：每日请求上限（0 表示不限额）

### API Key 用量统计

**端点**: `GET /v1/usage`

支持查询参数：
- `days`（1-30，默认 7）
- `model_limit`（1-50，默认 10）

```bash
curl "http://localhost:3000/v1/usage?days=7&model_limit=10" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

当代理接口（`/v1/chat/completions`、`/v1/completions`、`/v1/engines/:model/completions`、`/v1/responses`）触发限流或配额时，将返回 `429`，并附带：
- `x-ratelimit-limit-minute` / `x-ratelimit-remaining-minute`
- `x-ratelimit-limit-day` / `x-ratelimit-remaining-day`
- `retry-after`

### 接口索引

**端点**: `GET /v1/endpoints`

```bash
curl http://localhost:3000/v1/endpoints
```

### 健康检查

**端点**: `GET /health`

```bash
curl http://localhost:3000/health
```

也支持 OpenAI 风格前缀：`GET /v1/health`

### 管理运行参数（管理员登录后）

**端点**:
- `GET /admin/settings/runtime`
- `POST /admin/settings/runtime`

说明：默认支持在线写入 `.env`，保存后会实时热更新到运行时（无需重启）。如需禁用，可设置 `ALLOW_ENV_FILE_UPDATES=false`。

`POST` 请求体示例：

```json
{
  "apiKeyDefaultRpmLimit": 60,
  "maxConcurrentProxyRequests": 100,
  "tokenCircuitBreakerThreshold": 3,
  "tokenCooldownMinutes": 10
}
```

### 管理日志（管理员登录后）

**端点**:
- `GET /admin/stats/logs?limit=200&status=all|success|error&keyword=...`
- `GET /admin/stats/logs/export?limit=5000&status=all|success|error&keyword=...`
- `POST /admin/stats/logs/cleanup`

`POST /admin/stats/logs/cleanup` 请求体示例：

```json
{
  "days": 30
}
```

## 支持的模型

- `gpt-5.3-codex` - GPT 5.3 Codex（最新）
- `gpt-5.2` - GPT 5.2
- `gpt-5.2-codex` - GPT 5.2 Codex
- `gpt-5.1` - GPT 5.1
- `gpt-5.1-codex` - GPT 5.1 Codex
- `gpt-5.1-codex-mini` - GPT 5.1 Codex Mini（更快更便宜）
- `gpt-5.1-codex-max` - GPT 5.1 Codex Max
- `gpt-5` - GPT 5
- `gpt-5-codex` - GPT 5 Codex
- `gpt-5-codex-mini` - GPT 5 Codex Mini

## 在 Cherry Studio 中使用

Cherry Studio 是一个支持多种 AI 服务的桌面客户端。配置步骤：

### 1. 创建 API Key

1. 访问管理后台：`http://localhost:3000/admin`
2. 进入 **API Keys** 页面
3. 点击 **创建 API Key**
4. 复制生成的 API Key（只显示一次）

### 2. 在 Cherry Studio 中配置

1. 打开 Cherry Studio
2. 进入 **设置** → **模型提供商**
3. 添加新的 **OpenAI 兼容** 提供商
4. 填写配置：
   - **名称**: GPT2API Node（或自定义名称）
   - **API 地址**: `http://localhost:3000/v1`
   - **API Key**: 粘贴刚才创建的 API Key
   - **模型**: 选择或手动输入模型名称（如 `gpt-5.3-codex`）

### 3. 开始使用

配置完成后，在 Cherry Studio 中选择刚才添加的提供商和模型，即可开始对话。

## 使用示例

### Python

```python
import openai

client = openai.OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="YOUR_API_KEY"
)

response = client.chat.completions.create(
    model="gpt-5.3-codex",
    messages=[
        {"role": "user", "content": "Hello!"}
    ]
)

print(response.choices[0].message.content)
```

### JavaScript/Node.js

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'YOUR_API_KEY'
});

const response = await client.chat.completions.create({
  model: 'gpt-5.3-codex',
  messages: [
    { role: 'user', content: 'Hello!' }
  ]
});

console.log(response.choices[0].message.content);
```

## Token 管理

### 批量导入

1. 准备 JSON 文件，格式如下：

```json
[
  {
    "access_token": "your_access_token",
    "refresh_token": "your_refresh_token",
    "id_token": "your_id_token",
    "account_id": "account_id",
    "email": "email@example.com",
    "name": "账号名称"
  }
]
```

2. 在管理后台的账号管理页面点击 **导入 JSON**
3. 选择文件或粘贴 JSON 内容
4. 预览后确认导入

### 手动添加

在管理后台的账号管理页面点击 **手动添加**，填写必要信息。

### 自动刷新

服务会自动检测 token 是否过期，并在需要时自动刷新。

## 环境变量配置

创建 `.env` 文件：

```env
PORT=3000
SESSION_SECRET=replace-with-strong-random-secret-min-32chars
JWT_SECRET=replace-with-strong-random-secret-min-32chars
ADMIN_USERNAME=admin
ADMIN_PASSWORD=Gpt2api@2026
LOAD_BALANCE_STRATEGY=round-robin
MODELS_FILE=./models.json
DEFAULT_CODEX_MODEL=gpt-5-codex
API_KEY_DEFAULT_RPM_LIMIT=60
MAX_CONCURRENT_PROXY_REQUESTS=100
TOKEN_CIRCUIT_BREAKER_THRESHOLD=1
TOKEN_COOLDOWN_MINUTES=10
TOKEN_HEALTHCHECK_ENABLED=true
TOKEN_HEALTHCHECK_INTERVAL_SECONDS=120
TOKEN_HEALTHCHECK_TIMEOUT_MS=15000
TOKEN_HEALTHCHECK_CONCURRENCY=3
TOKEN_HEALTHCHECK_MAX_COOLDOWN_MINUTES=720
API_LOG_AUTO_CLEANUP_ENABLED=true
API_LOG_RETENTION_DAYS=30
API_LOG_CLEANUP_INTERVAL_MINUTES=60
ALLOW_ENV_FILE_UPDATES=true
ENV_HOT_RELOAD=true
EXPOSE_DETAILED_ERRORS=false
```

## 项目结构

```
gpt2api-node/
├── src/
│   ├── index.js              # 主服务器文件
│   ├── tokenManager.js       # Token 管理模块
│   ├── proxyHandler.js       # 代理处理模块
│   ├── config/
│   │   └── database.js       # 数据库配置
│   ├── models/
│   │   └── index.js          # 数据模型
│   ├── routes/
│   │   ├── auth.js           # 认证路由
│   │   ├── apiKeys.js        # API Keys 路由
│   │   ├── tokens.js         # Tokens 路由
│   │   ├── stats.js          # 统计路由
│   │   └── settings.js       # 设置路由
│   ├── middleware/
│   │   └── auth.js           # 认证中间件
│   └── scripts/
│       └── initDatabase.js   # 数据库初始化脚本
├── public/
│   └── admin/                # 管理后台前端
│       ├── index.html
│       ├── login.html
│       └── js/
│           └── admin.js
├── database/
│   └── app.db                # SQLite 数据库
├── models.json               # 模型配置
├── package.json
└── README.md
```

## 注意事项

1. **安全性**: 
   - 生产环境必须配置高强度 `SESSION_SECRET`、`JWT_SECRET`、`ADMIN_USERNAME` 和 `ADMIN_PASSWORD`
   - 若使用默认账号密码（`admin / Gpt2api@2026`），首次登录后请立即修改
   - 妥善保管 API Keys
   - 生产环境请使用 HTTPS
   - 默认允许管理后台在线写入 `.env` 并热更新；如需锁定配置，可设置 `ALLOW_ENV_FILE_UPDATES=false`

2. **网络要求**: 需要能够访问 `chatgpt.com` 和 `auth.openai.com`

3. **Token 有效期**: Token 会自动刷新，但如果 refresh_token 失效，需要重新获取

4. **并发限制**: 根据 OpenAI 账户限制，注意控制并发请求数量

## 故障排除

### 无法访问管理后台

确保服务已启动，访问 `http://localhost:3000/admin`

### 数据库初始化失败

删除 `database/app.db` 文件，重新运行 `npm run init-db`

### Token 刷新失败

可能是 refresh_token 已过期，需要重新导入新的 token

### API 请求失败

1. 检查 API Key 是否正确
2. 确保有可用的 Token 账号
3. 查看管理后台的请求日志

### 报错：selected model may not exist or you may not have access

常见原因：
1. 请求中的模型名被终端颜色码污染（例如 `gpt-5.3-codex[1m`）
2. 当前账号对该模型没有访问权限

处理建议：
1. 先调用 `GET /v1/models` 确认可用模型
2. 改用 `gpt-5-codex` 或你账号有权限的模型
3. 通过环境变量 `DEFAULT_CODEX_MODEL` 设置默认模型

## 许可证

MIT License

## 相关项目

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
