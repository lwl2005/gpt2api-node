import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID, randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { initDatabase } from './config/database.js';
import { initRuntimeEnvHotReload } from './config/runtimeEnv.js';
import { Token, ApiKey, ApiLog } from './models/index.js';
import TokenManager from './tokenManager.js';
import ProxyHandler from './proxyHandler.js';
import TokenHealthCheckScheduler from './services/tokenHealthCheckScheduler.js';
import { authenticateApiKey, enforceApiKeyPolicy } from './middleware/auth.js';

// 导入路由
import authRoutes from './routes/auth.js';
import apiKeysRoutes from './routes/apiKeys.js';
import tokensRoutes from './routes/tokens.js';
import statsRoutes from './routes/stats.js';
import settingsRoutes from './routes/settings.js';

dotenv.config();
await initRuntimeEnvHotReload();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const MODELS_FILE = process.env.MODELS_FILE || './models.json';
const VALID_LOAD_BALANCE_STRATEGIES = new Set(['round-robin', 'random', 'least-used']);
const SERVER_STARTED_AT = new Date().toISOString();
const INSECURE_SECRET_VALUES = new Set([
  'gpt2api-node-secret-key-change-in-production',
  'your-secret-key-change-in-production',
  'change-this-session-secret',
  'change-this-jwt-secret'
]);
let cachedSessionSecret = null;

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function isDetailedErrorsExposed() {
  return String(process.env.EXPOSE_DETAILED_ERRORS || '').toLowerCase() === 'true';
}

function resolveSecuritySecret(envName, displayName) {
  const current = process.env[envName];
  const invalid = !current || current.length < 32 || INSECURE_SECRET_VALUES.has(current);

  if (!invalid) {
    return current;
  }

  if (isProduction()) {
    throw new Error(`${displayName} 未配置或强度不足，请设置安全的 ${envName}（至少 32 字符随机字符串）`);
  }

  const generated = randomBytes(48).toString('hex');
  process.env[envName] = generated;
  console.warn(`⚠ ${displayName} 未安全配置，已自动生成临时值（仅开发环境有效，重启后会变化）`);
  return generated;
}

function getSessionSecret() {
  if (cachedSessionSecret) {
    return cachedSessionSecret;
  }
  cachedSessionSecret = resolveSecuritySecret('SESSION_SECRET', 'Session Secret');
  return cachedSessionSecret;
}

function getClientErrorMessage(rawMessage, statusCode) {
  if (isDetailedErrorsExposed() || !isProduction()) {
    return rawMessage;
  }

  if (statusCode === 401 || statusCode === 403) {
    return '认证失败或权限不足';
  }
  if (statusCode === 404) {
    return '资源不存在';
  }
  if (statusCode === 429) {
    return '请求过于频繁，请稍后重试';
  }
  if (statusCode >= 500) {
    return '服务暂时不可用，请稍后重试';
  }
  return '请求处理失败';
}

function buildOpenAIErrorPayload(message, type, requestId, extra = {}) {
  const payload = {
    message,
    type
  };

  if (requestId) {
    payload.request_id = requestId;
  }
  if (extra.param !== undefined) {
    payload.param = extra.param;
  }
  if (extra.code !== undefined) {
    payload.code = extra.code;
  }

  return { error: payload };
}

function getMaxConcurrentProxyRequests() {
  return Math.max(
    Number.parseInt(process.env.MAX_CONCURRENT_PROXY_REQUESTS || '100', 10) || 100,
    1
  );
}

function getLoadBalanceStrategy() {
  const strategy = process.env.LOAD_BALANCE_STRATEGY || 'round-robin';
  return VALID_LOAD_BALANCE_STRATEGIES.has(strategy) ? strategy : 'round-robin';
}

function parsePositiveInt(value, defaultValue, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return defaultValue;
  }
  return Math.min(Math.max(parsed, min), max);
}

// 初始化数据库
initDatabase();

// 中间件
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' })); // 增加请求体大小限制以支持批量导入
app.use(cookieParser());
app.use((req, res, next) => {
  // 基础安全响应头，减少浏览器侧攻击面
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('referrer-policy', 'same-origin');
  next();
});
app.use(session({
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction(),
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 小时
  }
}));
app.use(express.static(path.join(__dirname, '../public')));

// 加载模型列表
let modelsList = [];
try {
  const modelsData = await fs.readFile(MODELS_FILE, 'utf-8');
  modelsList = JSON.parse(modelsData);
  console.log(`✓ 加载了 ${modelsList.length} 个模型`);
} catch (err) {
  console.warn('⚠ 无法加载模型列表，使用默认列表');
  modelsList = [
    { id: 'gpt-5-codex', object: 'model', created: 1757894400, owned_by: 'openai' },
    { id: 'gpt-5.3-codex', object: 'model', created: 1770307200, owned_by: 'openai' }
  ];
}

// 创建 Token 管理器池
const tokenManagers = new Map();
let currentTokenIndex = 0; // 轮询索引
let inFlightProxyRequests = 0; // 当前代理并发数

function syncTokenManagerPayload(tokenId, tokenData) {
  if (!tokenManagers.has(tokenId)) {
    return;
  }
  const entry = tokenManagers.get(tokenId);
  if (!entry?.manager) {
    return;
  }
  entry.manager.tokenData = {
    ...(entry.manager.tokenData || {}),
    ...(tokenData || {})
  };
}

const tokenHealthCheckScheduler = new TokenHealthCheckScheduler({
  onTokenPayloadUpdated: syncTokenManagerPayload
});

// 获取可用的 Token Manager（支持多种策略）
function getAvailableTokenManager() {
  const activeTokens = Token.getActive();
  
  if (activeTokens.length === 0) {
    const coolingCount = Token.getCoolingCount();
    if (coolingCount > 0) {
      throw new Error(`暂无可用 Token（${coolingCount} 个账号处于熔断冷却中）`);
    }
    throw new Error('没有可用的 Token 账户');
  }

  let token;
  const strategy = getLoadBalanceStrategy();
  
  switch (strategy) {
    case 'random':
      // 随机策略：随机选择一个 token
      token = activeTokens[Math.floor(Math.random() * activeTokens.length)];
      break;
      
    case 'least-used':
      // 最少使用策略：选择总请求数最少的 token
      token = activeTokens.reduce((min, current) => {
        return (current.total_requests || 0) < (min.total_requests || 0) ? current : min;
      });
      break;
      
    case 'round-robin':
    default:
      // 轮询策略：按顺序选择下一个 token
      token = activeTokens[currentTokenIndex % activeTokens.length];
      currentTokenIndex = (currentTokenIndex + 1) % activeTokens.length;
      break;
  }
  
  if (!tokenManagers.has(token.id)) {
    // 创建临时 token 文件
    const tempTokenData = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      id_token: token.id_token,
      account_id: token.account_id,
      email: token.email,
      expired_at: token.expired_at,
      last_refresh_at: token.last_refresh_at,
      type: 'codex'
    };
    
    // 使用内存中的 token 数据
    const manager = new TokenManager(null);
    manager.tokenData = tempTokenData;
    tokenManagers.set(token.id, { manager, tokenId: token.id });
  }

  return tokenManagers.get(token.id);
}

function buildHealthPayload() {
  const activeTokens = Token.getActive();
  const allTokens = Token.getAll();
  const coolingTokens = Token.getCoolingCount();
  const tokenHealthSummary = Token.getHealthSummary();
  const apiKeys = ApiKey.getAll();
  const strategy = getLoadBalanceStrategy();
  const usage = Token.getUsageSummary();

  return {
    status: activeTokens.length > 0 ? 'ok' : 'degraded',
    uptime_seconds: Math.floor(process.uptime()),
    started_at: SERVER_STARTED_AT,
    timestamp: new Date().toISOString(),
    load_balance_strategy: strategy,
    tokens: {
      active: activeTokens.length,
      cooling: coolingTokens,
      total: allTokens.length,
      healthy: tokenHealthSummary.healthy || 0,
      unhealthy: tokenHealthSummary.unhealthy || 0,
      unknown: tokenHealthSummary.unknown || 0,
      auto_disabled: tokenHealthSummary.auto_disabled || 0
    },
    api_keys: {
      total: apiKeys.length
    },
    requests: {
      total: usage.total_requests || 0,
      success: usage.success_requests || 0,
      failed: usage.failed_requests || 0,
      estimated_token_consumed: usage.estimated_token_consumed || 0
    },
    proxy: {
      in_flight: inFlightProxyRequests,
      max_concurrent: getMaxConcurrentProxyRequests()
    },
    token_health_check: {
      ...tokenHealthCheckScheduler.getState()
    }
  };
}

async function handleProxyRequest(req, res, options) {
  const requestStartedAt = Date.now();
  const requestId = randomUUID();
  const apiKeyId = req.apiKey?.id || null;
  const endpoint = options.endpoint;
  const model = options.resolveModel?.(req.body) || req.body?.model || 'unknown';
  let tokenId = null;
  let statusCode = 200;
  let errorMessage = null;
  let acquiredSlot = false;

  res.setHeader('x-request-id', requestId);

  try {
    // 并发保护：超过上限时快速失败，避免服务雪崩
    const maxConcurrent = getMaxConcurrentProxyRequests();
    if (inFlightProxyRequests >= maxConcurrent) {
      statusCode = 503;
      errorMessage = `服务繁忙，并发已达上限（${maxConcurrent}）`;
      const clientMessage = getClientErrorMessage(errorMessage, statusCode);
      res.status(503).json(buildOpenAIErrorPayload(
        clientMessage,
        'service_unavailable_error',
        requestId,
        { code: 'server_busy' }
      ));
      return;
    }

    inFlightProxyRequests += 1;
    acquiredSlot = true;

    const { manager, tokenId: selectedTokenId } = getAvailableTokenManager();
    tokenId = selectedTokenId;
    res.setHeader('x-proxy-token-id', String(selectedTokenId));

    const proxyHandler = new ProxyHandler(manager);
    await options.handler(proxyHandler);

    statusCode = res.statusCode || 200;
  } catch (error) {
    statusCode = Number.parseInt(error?.statusCode, 10) || 500;
    errorMessage = error?.message || '未知错误';
    const clientMessage = getClientErrorMessage(errorMessage, statusCode);
    const errorType = typeof error?.type === 'string' ? error.type : 'proxy_error';
    console.error(`${endpoint} 请求失败:`, error);

    if (!res.headersSent) {
      res.status(statusCode).json(buildOpenAIErrorPayload(
        clientMessage,
        errorType,
        requestId,
        {
          param: error?.param,
          code: error?.code
        }
      ));
    }
  } finally {
    const success = statusCode >= 200 && statusCode < 400;
    const responseTimeMs = Math.max(0, Date.now() - requestStartedAt);

    if (acquiredSlot && inFlightProxyRequests > 0) {
      inFlightProxyRequests -= 1;
    }

    if (tokenId) {
      Token.updateUsage(tokenId, success);
    }

    ApiLog.create({
      api_key_id: apiKeyId,
      token_id: tokenId,
      model,
      endpoint,
      status_code: statusCode,
      response_time_ms: responseTimeMs,
      error_message: success ? null : errorMessage
    });
  }
}

// ==================== 管理后台路由 ====================
app.use('/admin/auth', authRoutes);
app.use('/admin/api-keys', apiKeysRoutes);
app.use('/admin/tokens', tokensRoutes);
app.use('/admin/stats', statsRoutes);
app.use('/admin/settings', settingsRoutes);

// 根路径重定向到管理后台
app.get('/', (req, res) => {
  res.redirect('/admin');
});

// ==================== 代理接口（需要 API Key） ====================

// OpenAI 兼容的聊天完成接口
app.post('/v1/chat/completions', authenticateApiKey, enforceApiKeyPolicy, async (req, res) => {
  await handleProxyRequest(req, res, {
    endpoint: '/v1/chat/completions',
    resolveModel: (body) => body?.model,
    handler: async (proxyHandler) => {
      if (req.body?.stream === true) {
        await proxyHandler.handleStreamRequest(req, res);
      } else {
        await proxyHandler.handleNonStreamRequest(req, res);
      }
    }
  });
});

// OpenAI 兼容的文本补全接口（legacy）
app.post('/v1/completions', authenticateApiKey, enforceApiKeyPolicy, async (req, res) => {
  await handleProxyRequest(req, res, {
    endpoint: '/v1/completions',
    resolveModel: (body) => body?.model,
    handler: async (proxyHandler) => {
      await proxyHandler.handleCompletionsRequest(req, res);
    }
  });
});

// OpenAI 旧版引擎补全别名接口（legacy）
app.post('/v1/engines/:model/completions', authenticateApiKey, enforceApiKeyPolicy, async (req, res) => {
  req.body = {
    ...(req.body || {}),
    model: req.body?.model || req.params.model
  };

  await handleProxyRequest(req, res, {
    endpoint: '/v1/engines/:model/completions',
    resolveModel: (body) => body?.model || req.params.model,
    handler: async (proxyHandler) => {
      await proxyHandler.handleCompletionsRequest(req, res, req.params.model);
    }
  });
});

// OpenAI Responses 接口
app.post('/v1/responses', authenticateApiKey, enforceApiKeyPolicy, async (req, res) => {
  await handleProxyRequest(req, res, {
    endpoint: '/v1/responses',
    resolveModel: (body) => body?.model,
    handler: async (proxyHandler) => {
      await proxyHandler.handleResponsesRequest(req, res);
    }
  });
});

// 模型列表接口（公开）
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: modelsList
  });
});

// 单模型查询接口（公开）
app.get('/v1/models/:modelId', (req, res) => {
  const model = modelsList.find((item) => item.id === req.params.modelId);
  if (!model) {
    return res.status(404).json(buildOpenAIErrorPayload(
      `模型不存在: ${req.params.modelId}`,
      'not_found_error',
      null,
      { param: 'model', code: 'model_not_found' }
    ));
  }

  res.json(model);
});

// 接口能力发现（公开）
app.get('/v1/endpoints', (req, res) => {
  res.json({
    object: 'list',
    data: [
      { method: 'POST', path: '/v1/chat/completions', auth: 'api_key', description: 'OpenAI Chat Completions 兼容接口' },
      { method: 'POST', path: '/v1/completions', auth: 'api_key', description: 'OpenAI Completions（legacy）兼容接口' },
      { method: 'POST', path: '/v1/engines/:model/completions', auth: 'api_key', description: 'OpenAI Engines Completions（legacy alias）兼容接口' },
      { method: 'POST', path: '/v1/responses', auth: 'api_key', description: 'OpenAI Responses 兼容接口' },
      { method: 'GET', path: '/v1/models', auth: 'none', description: '模型列表' },
      { method: 'GET', path: '/v1/models/:modelId', auth: 'none', description: '单模型信息' },
      { method: 'GET', path: '/v1/keys/me', auth: 'api_key', description: '当前 API Key 元信息' },
      { method: 'GET', path: '/v1/usage', auth: 'api_key', description: '当前 API Key 的请求统计' },
      { method: 'GET', path: '/v1/health', auth: 'none', description: '系统健康检查' }
    ]
  });
});

// 当前 API Key 信息
app.get('/v1/keys/me', authenticateApiKey, (req, res) => {
  const key = ApiKey.findById(req.apiKey.id);
  if (!key) {
    return res.status(404).json(buildOpenAIErrorPayload('API Key 不存在', 'not_found_error'));
  }

  res.json({
    id: key.id,
    name: key.name,
    is_active: Boolean(key.is_active),
    rpm_limit: key.rpm_limit ?? null,
    daily_limit: key.daily_limit ?? null,
    usage_count: key.usage_count || 0,
    last_used_at: key.last_used_at,
    created_at: key.created_at
  });
});

// API Key 级别用量统计
app.get('/v1/usage', authenticateApiKey, (req, res) => {
  const days = parsePositiveInt(req.query.days, 7, 1, 30);
  const modelLimit = parsePositiveInt(req.query.model_limit, 10, 1, 50);

  const usage = ApiLog.getUsageByApiKey(req.apiKey.id);
  const topModels = ApiLog.getTopModelsByApiKey(req.apiKey.id, modelLimit);
  const dailyUsage = ApiLog.getDailyUsageByApiKey(req.apiKey.id, days);

  const totalRequests = usage.total_requests || 0;
  const successRequests = usage.success_requests || 0;
  const failedRequests = usage.failed_requests || 0;
  const todayRequests = usage.today_requests || 0;
  const dailyLimit = Number.parseInt(req.apiKey.daily_limit, 10) || 0;

  res.json({
    object: 'usage',
    api_key: {
      id: req.apiKey.id,
      name: req.apiKey.name
    },
    window_days: days,
    limits: {
      rpm_limit: Number.parseInt(req.apiKey.rpm_limit, 10) || 0,
      daily_limit: dailyLimit,
      daily_remaining: dailyLimit > 0 ? Math.max(0, dailyLimit - todayRequests) : null
    },
    stats: {
      total_requests: totalRequests,
      success_requests: successRequests,
      failed_requests: failedRequests,
      today_requests: todayRequests,
      success_rate: totalRequests > 0 ? Number(((successRequests / totalRequests) * 100).toFixed(2)) : 100
    },
    top_models: topModels,
    daily_usage: dailyUsage
  });
});

// 健康检查（公开）
const healthHandler = (req, res) => {
  const payload = buildHealthPayload();
  const statusCode = payload.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(payload);
};

app.get('/health', healthHandler);
app.get('/v1/health', healthHandler);

// 显式声明当前未实现的 OpenAI 接口族，避免客户端误判为网络错误
const unsupportedOpenAIEndpointFamilies = [
  '/v1/embeddings',
  '/v1/moderations',
  '/v1/images',
  '/v1/audio',
  '/v1/files',
  '/v1/fine_tuning',
  '/v1/assistants',
  '/v1/threads',
  '/v1/vector_stores',
  '/v1/batches'
];

for (const endpointPrefix of unsupportedOpenAIEndpointFamilies) {
  app.use(endpointPrefix, (req, res) => {
    res.status(501).json(buildOpenAIErrorPayload(
      `当前服务暂不支持接口族: ${endpointPrefix}`,
      'unsupported_api_error',
      null,
      { code: 'endpoint_not_implemented' }
    ));
  });
}

// 统一返回 v1 下的未知接口错误
app.use('/v1', (req, res) => {
  res.status(404).json(buildOpenAIErrorPayload(
    `接口不存在: ${req.method} ${req.originalUrl}`,
    'invalid_request_error',
    null,
    { code: 'endpoint_not_found' }
  ));
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  const statusCode = Number.parseInt(err?.statusCode, 10) || 500;
  const message = getClientErrorMessage(err?.message || '内部服务器错误', statusCode);
  const errorType = typeof err?.type === 'string' ? err.type : 'server_error';
  res.status(statusCode).json(buildOpenAIErrorPayload(
    message,
    errorType,
    null,
    {
      param: err?.param,
      code: err?.code
    }
  ));
});

// 启动服务器
app.listen(PORT, () => {
  const activeTokens = Token.getActive();
  const allTokens = Token.getAll();
  const strategy = getLoadBalanceStrategy();
  const strategyNames = {
    'round-robin': '轮询',
    'random': '随机',
    'least-used': '最少使用'
  };
  
  console.log('=================================');
  console.log('🚀 GPT2API Node 管理系统已启动');
  console.log(`📡 监听端口: ${PORT}`);
  console.log(`⚖️  账号总数: ${allTokens.length} | 负载均衡: ${strategyNames[strategy] || strategy}`);
  console.log(`🔑 活跃账号: ${activeTokens.length} 个`);
  console.log('=================================');
  console.log(`\n管理后台: http://localhost:${PORT}/admin`);
  console.log(`API Chat: http://localhost:${PORT}/v1/chat/completions`);
  console.log(`API Completions: http://localhost:${PORT}/v1/completions`);
  console.log(`API Responses: http://localhost:${PORT}/v1/responses`);
  console.log(`API 文档索引: http://localhost:${PORT}/v1/endpoints`);
  console.log(`\n首次使用请运行: npm run init-db`);
  console.log('请确保已通过环境变量安全配置管理员账号与密钥\n');

  tokenHealthCheckScheduler.start(8000);
});
