# GPT2API Node - 部署文档

## 🎉 系统功能

### 核心功能
- ✅ OpenAI Codex 反向代理服务
- ✅ 完整的 Web 管理后台
- ✅ 多账号管理和批量操作
- ✅ 自动 Token 刷新机制
- ✅ 负载均衡（轮询/随机/最少使用）
- ✅ API Key 管理和认证
- ✅ 请求统计和数据分析
- ✅ 实时活动记录

### 管理后台功能

#### 1. 仪表盘
- 系统概览和实时统计
- API Keys 数量
- Token 账号数量
- 今日请求数和成功率
- 最近活动记录（API请求、账号添加等）

#### 2. API Keys 管理
- 创建和管理 API Keys
- 查看使用统计
- 启用/禁用 API Key
- 删除 API Key

#### 3. 账号管理
- **批量导入 Token**（支持 JSON 文件和多文件）
- **批量删除账号**（支持多选）
- 手动添加账号
- 查看账号额度和使用情况
- 刷新账号额度（单个/全部）
- 负载均衡策略配置
- 账号总数实时显示

#### 4. 数据分析
- **请求量趋势图表**（基于真实数据）
- 模型使用分布
- 账号详细统计（带滚动条）
- API 请求日志（带滚动条）
- 支持时间范围筛选（24小时/7天/30天）

#### 5. 系统设置
- 修改管理员密码
- 负载均衡策略设置
- GitHub 项目链接

## 🚀 快速部署

### 1. 环境要求
- Node.js 16+ 
- npm 或 yarn

### 2. 安装步骤

```bash
# 克隆项目
git clone https://github.com/lulistart/gpt2api-node.git
cd gpt2api-node

# 安装依赖
npm install

# 初始化数据库
npm run init-db

# 启动服务
npm start
```

### 3. 访问管理后台

打开浏览器访问：`http://localhost:3000/admin`

初始管理员账户：
- 用户名：来自 `ADMIN_USERNAME`（未配置时为 `admin`）
- 密码：来自 `ADMIN_PASSWORD`（未配置时为 `Gpt2api@2026`）

**重要**：
- 密码至少 12 位，且需包含大小写字母、数字、特殊字符
- 若使用默认账号密码，请首次登录后立即修改

## 📁 项目结构

```
gpt2api-node/
├── src/
│   ├── config/
│   │   └── database.js          # 数据库配置和初始化
│   ├── middleware/
│   │   └── auth.js              # 认证中间件
│   ├── models/
│   │   └── index.js             # 数据模型（User、ApiKey、Token、ApiLog）
│   ├── routes/
│   │   ├── auth.js              # 认证路由（登录、登出、修改密码）
│   │   ├── apiKeys.js           # API Keys 管理路由
│   │   ├── tokens.js            # Tokens 管理路由（含批量删除）
│   │   ├── stats.js             # 统计路由（含最近活动）
│   │   └── settings.js          # 设置路由
│   ├── scripts/
│   │   └── initDatabase.js      # 数据库初始化脚本
│   ├── index.js                 # 主入口文件
│   ├── tokenManager.js          # Token 管理模块
│   └── proxyHandler.js          # 代理处理模块
├── public/
│   └── admin/
│       ├── login.html           # 登录页面
│       ├── index.html           # 管理后台主页
│       └── js/
│           └── admin.js         # 管理后台脚本
├── database/
│   └── app.db                   # SQLite 数据库
├── models.json                  # 模型配置
├── package.json
├── README.md
└── DEPLOYMENT.md
```

## 🔧 配置说明

### 环境变量

创建 `.env` 文件：

```env
# 服务端口
PORT=3000

# Session 密钥（生产环境必须修改）
SESSION_SECRET=your-random-secret-key-change-in-production

# 负载均衡策略：round-robin（轮询）、random（随机）、least-used（最少使用）
LOAD_BALANCE_STRATEGY=round-robin

# 模型配置文件
MODELS_FILE=./models.json

# 数据库路径
DATABASE_PATH=./database/app.db
```

### 负载均衡策略

支持三种策略：

1. **round-robin（轮询）**：按顺序依次使用每个账号，默认策略
2. **random（随机）**：随机选择一个可用账号
3. **least-used（最少使用）**：选择请求次数最少的账号

可通过环境变量或管理后台配置。

## 📊 数据库结构

### users 表
- 管理员账户信息
- 字段：id, username, password_hash, created_at

### api_keys 表
- API 密钥管理
- 字段：id, name, key, is_active, usage_count, last_used_at, created_at

### tokens 表
- OpenAI Token 账户
- 字段：id, name, email, account_id, access_token, refresh_token, id_token, expired_at, last_refresh_at, is_active, total_requests, success_requests, failed_requests, quota_total, quota_used, quota_remaining, created_at

### api_logs 表
- API 请求日志
- 字段：id, api_key_id, token_id, model, endpoint, status_code, error_message, created_at

## 🔐 安全建议

### 生产环境配置

1. **修改默认密码**
   - 首次登录后立即修改管理员密码
   - 使用强密码（至少8位，包含大小写字母、数字、特殊字符）

2. **设置环境变量**
   ```bash
   SESSION_SECRET=$(openssl rand -base64 32)
   ```

3. **启用 HTTPS**
   - 使用 Nginx 或 Caddy 作为反向代理
   - 配置 SSL 证书
   - 设置 `cookie.secure = true`

4. **防火墙配置**
   - 只开放必要的端口
   - 限制管理后台访问 IP

5. **定期备份**
   - 备份 `database/app.db` 数据库文件
   - 备份环境变量配置

### Nginx 反向代理示例

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 🎯 使用指南

### 1. 创建 API Key

1. 登录管理后台
2. 进入 **API Keys** 页面
3. 点击 **创建 API Key**
4. 输入名称（可选）
5. 复制生成的 API Key（只显示一次）

### 2. 导入 Token 账号

#### 方式一：批量导入 JSON

1. 准备 JSON 文件：
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

2. 进入 **账号管理** 页面
3. 点击 **导入 JSON**
4. 选择文件或粘贴 JSON 内容
5. 点击 **预览导入**
6. 确认后点击 **确认导入**

#### 方式二：手动添加

1. 进入 **账号管理** 页面
2. 点击 **手动添加**
3. 填写 Access Token 和 Refresh Token
4. 点击 **添加**

### 3. 批量删除账号

1. 进入 **账号管理** 页面
2. 勾选要删除的账号
3. 点击 **删除选中** 按钮
4. 确认删除

### 4. 使用 API

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.3-codex",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

## 🐛 故障排除

### 无法访问管理后台

1. 检查服务是否启动：`npm start`
2. 检查端口是否被占用：`netstat -ano | findstr :3000`
3. 检查防火墙设置

### 数据库初始化失败

```bash
# 删除旧数据库
rm database/app.db

# 重新初始化
npm run init-db
```

### Token 刷新失败

1. 检查网络连接
2. 确认 refresh_token 是否有效
3. 重新导入新的 token

### API 请求失败

1. 检查 API Key 是否正确
2. 确保有可用的 Token 账号
3. 查看管理后台的请求日志
4. 检查账号是否被禁用

### 请求趋势图表显示异常

- 图表数据基于 `api_logs` 表的真实请求记录
- 如果没有请求记录，图表会显示为空
- 发送几次 API 请求后刷新页面查看

## 📝 维护建议

1. **定期备份数据库**
   ```bash
   cp database/app.db database/app.db.backup.$(date +%Y%m%d)
   ```

2. **监控日志**
   - 查看终端输出
   - 检查请求日志

3. **更新依赖**
   ```bash
   npm update
   ```

4. **清理旧日志**
   - 定期清理 `api_logs` 表中的旧记录

## 🔄 更新日志

### v2.0.0 (2026-02-17)
- ✅ 添加批量删除账号功能
- ✅ 添加仪表盘最近活动记录
- ✅ 添加 GitHub 项目链接
- ✅ 移除前台页面，根路径重定向到管理后台
- ✅ 修复模型列表（删除不存在的 gpt-5.3-codex-spark）
- ✅ 优化终端日志输出
- ✅ 账号管理页面显示账号总数
- ✅ 账号详细统计和请求日志添加滚动条
- ✅ 修复请求趋势图表，使用真实数据

### v1.0.0
- ✅ 基础管理系统
- ✅ API Keys 管理
- ✅ Tokens 管理
- ✅ 数据统计

## 📞 支持

- GitHub: https://github.com/lulistart/gpt2api-node
- Issues: https://github.com/lulistart/gpt2api-node/issues

## 📄 许可证

MIT License
