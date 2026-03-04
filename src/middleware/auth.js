import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { ApiKey, ApiLog } from '../models/index.js';

const INSECURE_SECRET_VALUES = new Set([
  'gpt2api-node-secret-key-change-in-production',
  'your-secret-key-change-in-production',
  'change-this-session-secret',
  'change-this-jwt-secret'
]);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const apiKeyRateBuckets = new Map();
const apiKeyDailyUsageCache = new Map();
const RATE_BUCKET_STALE_MS = 5 * 60 * 1000;
const DAILY_USAGE_CACHE_STALE_MS = 2 * 24 * 60 * 60 * 1000;
const CACHE_CLEANUP_INTERVAL_MS = 60 * 1000;
let cachedJwtSecret = null;
let lastRateBucketCleanupAt = 0;
let lastDailyUsageCleanupAt = 0;

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function getJwtSecret() {
  if (cachedJwtSecret) {
    return cachedJwtSecret;
  }

  const current = process.env.JWT_SECRET;
  const invalid = !current || current.length < 32 || INSECURE_SECRET_VALUES.has(current);

  if (!invalid) {
    cachedJwtSecret = current;
    return cachedJwtSecret;
  }

  if (isProduction()) {
    throw new Error('JWT_SECRET 未配置或强度不足，请设置至少 32 字符的随机字符串');
  }

  const generated = randomBytes(48).toString('hex');
  process.env.JWT_SECRET = generated;
  cachedJwtSecret = generated;
  console.warn('⚠ JWT_SECRET 未安全配置，已自动生成临时值（仅开发环境有效）');
  return cachedJwtSecret;
}

function getDefaultApiKeyRpmLimit() {
  return Math.max(Number.parseInt(process.env.API_KEY_DEFAULT_RPM_LIMIT || '60', 10) || 60, 0);
}

function normalizeNonNegativeInt(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    return defaultValue;
  }
  return parsed;
}

function getSecondsUntilUtcDayEnd() {
  const now = new Date();
  const nextUtcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0
  );
  return Math.max(1, Math.ceil((nextUtcMidnight - now.getTime()) / 1000));
}

function getUtcDateKey(timestampMs = Date.now()) {
  const now = new Date(timestampMs);
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function maybeCleanupRateBuckets(nowMs = Date.now()) {
  if (nowMs - lastRateBucketCleanupAt < CACHE_CLEANUP_INTERVAL_MS) {
    return;
  }
  lastRateBucketCleanupAt = nowMs;

  for (const [apiKeyId, bucket] of apiKeyRateBuckets) {
    if (!bucket || nowMs - (bucket.lastSeenAt || 0) > RATE_BUCKET_STALE_MS) {
      apiKeyRateBuckets.delete(apiKeyId);
    }
  }
}

function maybeCleanupDailyUsageCache(nowMs = Date.now()) {
  if (nowMs - lastDailyUsageCleanupAt < CACHE_CLEANUP_INTERVAL_MS) {
    return;
  }
  lastDailyUsageCleanupAt = nowMs;

  const currentDateKey = getUtcDateKey(nowMs);
  for (const [apiKeyId, entry] of apiKeyDailyUsageCache) {
    const staleByDate = entry?.dateKey && entry.dateKey !== currentDateKey;
    const staleByTime = nowMs - (entry?.lastSeenAt || 0) > DAILY_USAGE_CACHE_STALE_MS;
    if (staleByDate || staleByTime) {
      apiKeyDailyUsageCache.delete(apiKeyId);
    }
  }
}

function checkRateLimitByMinute(apiKeyId, rpmLimit) {
  if (rpmLimit <= 0) {
    return { allowed: true, remaining: Infinity, retryAfter: 0 };
  }

  const now = Date.now();
  maybeCleanupRateBuckets(now);

  const currentWindowStart = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  let bucket = apiKeyRateBuckets.get(apiKeyId);
  if (!bucket || bucket.windowStart !== currentWindowStart) {
    bucket = {
      windowStart: currentWindowStart,
      count: 0,
      lastSeenAt: now
    };
  }

  if (bucket.count >= rpmLimit) {
    const retryAfter = Math.max(
      1,
      Math.ceil(((bucket.windowStart + RATE_LIMIT_WINDOW_MS) - now) / 1000)
    );
    bucket.lastSeenAt = now;
    apiKeyRateBuckets.set(apiKeyId, bucket);
    return { allowed: false, remaining: 0, retryAfter };
  }

  bucket.count += 1;
  bucket.lastSeenAt = now;
  apiKeyRateBuckets.set(apiKeyId, bucket);
  return { allowed: true, remaining: Math.max(0, rpmLimit - bucket.count), retryAfter: 0 };
}

function getDailyUsageBucket(apiKeyId) {
  const now = Date.now();
  const currentDateKey = getUtcDateKey(now);
  maybeCleanupDailyUsageCache(now);

  const cached = apiKeyDailyUsageCache.get(apiKeyId);
  if (cached && cached.dateKey === currentDateKey) {
    cached.lastSeenAt = now;
    return cached;
  }

  const todayCount = ApiLog.getTodayCountByApiKey(apiKeyId);
  const entry = {
    dateKey: currentDateKey,
    count: todayCount,
    lastSeenAt: now
  };
  apiKeyDailyUsageCache.set(apiKeyId, entry);
  return entry;
}

function increaseDailyUsage(apiKeyId) {
  const now = Date.now();
  const currentDateKey = getUtcDateKey(now);
  const existing = apiKeyDailyUsageCache.get(apiKeyId);

  if (existing && existing.dateKey === currentDateKey) {
    existing.count += 1;
    existing.lastSeenAt = now;
    return;
  }

  apiKeyDailyUsageCache.set(apiKeyId, {
    dateKey: currentDateKey,
    count: ApiLog.getTodayCountByApiKey(apiKeyId) + 1,
    lastSeenAt: now
  });
}

// 统一解析 Bearer Token，兼容大小写和多余空格
function parseBearerToken(authorization) {
  if (!authorization || typeof authorization !== 'string') {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function buildOpenAIError(message, type, extra = {}) {
  const error = {
    message,
    type
  };

  if (extra.param !== undefined) {
    error.param = extra.param;
  }
  if (extra.code !== undefined) {
    error.code = extra.code;
  }

  return { error };
}

// JWT 认证中间件（用于管理后台）
export function authenticateJWT(req, res, next) {
  const token = req.cookies?.token || parseBearerToken(req.headers.authorization);

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    req.user = decoded;
    next();
  } catch (error) {
    if (/JWT_SECRET 未配置/.test(String(error?.message || ''))) {
      console.error('JWT 认证配置错误:', error);
      return res.status(500).json({ error: '认证服务配置错误' });
    }
    return res.status(403).json({ error: 'Invalid token' });
  }
}

// Session 认证中间件（用于管理后台）
export function authenticateAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// API Key 认证中间件（用于代理接口）
export function authenticateApiKey(req, res, next) {
  const xApiKeyHeader = req.headers['x-api-key'];
  const apiKey = (Array.isArray(xApiKeyHeader) ? xApiKeyHeader[0] : xApiKeyHeader)
    || parseBearerToken(req.headers.authorization);

  if (!apiKey) {
    return res.status(401).json(buildOpenAIError('API key required', 'invalid_request_error', {
      param: 'Authorization',
      code: 'api_key_required'
    }));
  }

  const keyData = ApiKey.findByKey(apiKey);

  if (!keyData) {
    return res.status(403).json(buildOpenAIError('Invalid API key', 'invalid_api_key', {
      code: 'invalid_api_key'
    }));
  }

  req.apiKey = keyData;
  next();
}

// API Key 策略中间件（限流/配额），建议仅用于真正的代理调用接口
export function enforceApiKeyPolicy(req, res, next) {
  const keyData = req.apiKey;
  if (!keyData) {
    return res.status(500).json(buildOpenAIError('API key context missing', 'server_error'));
  }

  // 每分钟限流（rpm_limit=0 表示不限流）
  const rpmLimit = normalizeNonNegativeInt(keyData.rpm_limit, getDefaultApiKeyRpmLimit());
  const rateLimit = checkRateLimitByMinute(keyData.id, rpmLimit);
  if (rpmLimit > 0) {
    res.setHeader('x-ratelimit-limit-minute', String(rpmLimit));
    res.setHeader('x-ratelimit-remaining-minute', String(rateLimit.remaining));
  }
  if (!rateLimit.allowed) {
    res.setHeader('retry-after', String(rateLimit.retryAfter));
    return res.status(429).json(buildOpenAIError(
      `每分钟请求已达上限（${rpmLimit}）`,
      'rate_limit_error',
      { code: 'rate_limit_exceeded' }
    ));
  }

  // 每日配额（daily_limit=0 表示不限制）
  const dailyLimit = normalizeNonNegativeInt(keyData.daily_limit, 0);
  if (dailyLimit > 0) {
    const dailyUsage = getDailyUsageBucket(keyData.id);
    const todayCount = dailyUsage.count;
    const remaining = Math.max(0, dailyLimit - todayCount);
    res.setHeader('x-ratelimit-limit-day', String(dailyLimit));
    res.setHeader('x-ratelimit-remaining-day', String(remaining));

    if (todayCount >= dailyLimit) {
      res.setHeader('retry-after', String(getSecondsUntilUtcDayEnd()));
      return res.status(429).json(buildOpenAIError(
        `今日请求已达上限（${dailyLimit}）`,
        'quota_exceeded_error',
        { code: 'quota_exceeded' }
      ));
    }
  }

  // 更新使用统计
  ApiKey.updateUsage(keyData.id);
  if (dailyLimit > 0) {
    increaseDailyUsage(keyData.id);
  }
  next();
}

// 生成 JWT Token
export function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    getJwtSecret(),
    { expiresIn: '7d' }
  );
}

// 生成 API Key
export function generateApiKey() {
  // 使用安全随机数生成器，避免可预测的 API Key
  return `sk-${randomBytes(24).toString('hex')}`;
}
