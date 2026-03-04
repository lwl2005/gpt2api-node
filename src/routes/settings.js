import express from 'express';
import fs from 'fs/promises';
import { authenticateAdmin } from '../middleware/auth.js';
import { getRuntimeEnvState, reloadRuntimeEnvFromDisk } from '../config/runtimeEnv.js';

const router = express.Router();

// 所有路由都需要认证
router.use(authenticateAdmin);

// 配置文件路径
const ALLOW_ENV_FILE_UPDATES_ENV = 'ALLOW_ENV_FILE_UPDATES';

function getConfigFilePath() {
  return process.env.ENV_FILE_PATH || '.env';
}

function parsePositiveInt(value, defaultValue, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return defaultValue;
  }
  return Math.min(Math.max(parsed, min), max);
}

function parseNonNegativeInt(value, defaultValue, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    return defaultValue;
  }
  return Math.min(parsed, max);
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

async function readEnvContent() {
  try {
    return await fs.readFile(getConfigFilePath(), 'utf-8');
  } catch {
    return '';
  }
}

async function updateEnvVariables(updates = {}) {
  const envContent = await readEnvContent();
  const lines = envContent ? envContent.split(/\r?\n/) : [];
  const normalizedLines = [...lines];

  Object.entries(updates).forEach(([key, value]) => {
    const serialized = `${key}=${value}`;
    const idx = normalizedLines.findIndex((line) => line.trimStart().startsWith(`${key}=`));
    if (idx >= 0) {
      normalizedLines[idx] = serialized;
    } else {
      normalizedLines.push(serialized);
    }
  });

  await fs.writeFile(getConfigFilePath(), normalizedLines.join('\n'), 'utf-8');
}

function canWriteEnvFile() {
  const raw = String(process.env[ALLOW_ENV_FILE_UPDATES_ENV] || 'true').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(raw);
}

function rejectEnvWriteIfDisabled(res) {
  if (canWriteEnvFile()) {
    return false;
  }

  res.status(403).json({
    error: `已禁用在线写入 .env。请将 ${ALLOW_ENV_FILE_UPDATES_ENV} 设为 true（热更新，无需重启）`
  });
  return true;
}

// 获取负载均衡策略
router.get('/load-balance-strategy', async (req, res) => {
  try {
    const strategy = process.env.LOAD_BALANCE_STRATEGY || 'round-robin';
    const envState = getRuntimeEnvState();
    res.json({
      strategy,
      envFileWritable: canWriteEnvFile(),
      envHotReloadEnabled: envState.hotReloadEnabled,
      envLastLoadedAt: envState.lastLoadedAt
    });
  } catch (error) {
    console.error('获取策略失败:', error);
    res.status(500).json({ error: '获取策略失败' });
  }
});

// 更新负载均衡策略
router.post('/load-balance-strategy', async (req, res) => {
  try {
    if (rejectEnvWriteIfDisabled(res)) {
      return;
    }

    const { strategy } = req.body;
    
    if (!['round-robin', 'random', 'least-used'].includes(strategy)) {
      return res.status(400).json({ error: '无效的策略' });
    }
    
    await updateEnvVariables({
      LOAD_BALANCE_STRATEGY: strategy
    });
    await reloadRuntimeEnvFromDisk('settings:load-balance-strategy');
    
    res.json({ 
      success: true, 
      message: '策略已更新并实时生效',
      strategy 
    });
  } catch (error) {
    console.error('更新策略失败:', error);
    res.status(500).json({ error: '更新策略失败' });
  }
});

// 获取运行参数配置
router.get('/runtime', async (req, res) => {
  try {
    const envState = getRuntimeEnvState();
    res.json({
      apiKeyDefaultRpmLimit: parseNonNegativeInt(process.env.API_KEY_DEFAULT_RPM_LIMIT, 60, 100000),
      maxConcurrentProxyRequests: parsePositiveInt(process.env.MAX_CONCURRENT_PROXY_REQUESTS, 100, 1, 100000),
      tokenCircuitBreakerThreshold: 1,
      tokenCooldownMinutes: parsePositiveInt(process.env.TOKEN_COOLDOWN_MINUTES, 10, 1, 1440),
      tokenHealthCheckEnabled: parseBoolean(process.env.TOKEN_HEALTHCHECK_ENABLED, true),
      tokenHealthCheckIntervalSeconds: parsePositiveInt(process.env.TOKEN_HEALTHCHECK_INTERVAL_SECONDS, 120, 30, 86400),
      tokenHealthCheckTimeoutMs: parsePositiveInt(process.env.TOKEN_HEALTHCHECK_TIMEOUT_MS, 15000, 1000, 120000),
      tokenHealthCheckConcurrency: parsePositiveInt(process.env.TOKEN_HEALTHCHECK_CONCURRENCY, 3, 1, 20),
      tokenHealthCheckMaxCooldownMinutes: parsePositiveInt(process.env.TOKEN_HEALTHCHECK_MAX_COOLDOWN_MINUTES, 720, 10, 1440),
      envFileWritable: canWriteEnvFile(),
      envHotReloadEnabled: envState.hotReloadEnabled,
      envLastLoadedAt: envState.lastLoadedAt
    });
  } catch (error) {
    console.error('获取运行参数失败:', error);
    res.status(500).json({ error: '获取运行参数失败' });
  }
});

// 更新运行参数配置
router.post('/runtime', async (req, res) => {
  try {
    if (rejectEnvWriteIfDisabled(res)) {
      return;
    }

    const apiKeyDefaultRpmLimit = parseNonNegativeInt(req.body.apiKeyDefaultRpmLimit, NaN, 100000);
    const maxConcurrentProxyRequests = parsePositiveInt(req.body.maxConcurrentProxyRequests, NaN, 1, 100000);
    const tokenCircuitBreakerThreshold = 1;
    const tokenCooldownMinutes = parsePositiveInt(req.body.tokenCooldownMinutes, NaN, 1, 1440);
    const tokenHealthCheckEnabled = parseBoolean(req.body.tokenHealthCheckEnabled, true);
    const tokenHealthCheckIntervalSeconds = parsePositiveInt(req.body.tokenHealthCheckIntervalSeconds, NaN, 30, 86400);
    const tokenHealthCheckTimeoutMs = parsePositiveInt(req.body.tokenHealthCheckTimeoutMs, NaN, 1000, 120000);
    const tokenHealthCheckConcurrency = parsePositiveInt(
      req.body.tokenHealthCheckConcurrency,
      parsePositiveInt(process.env.TOKEN_HEALTHCHECK_CONCURRENCY, 3, 1, 20),
      1,
      20
    );
    const tokenHealthCheckMaxCooldownMinutes = parsePositiveInt(req.body.tokenHealthCheckMaxCooldownMinutes, NaN, 10, 1440);

    if (!Number.isFinite(apiKeyDefaultRpmLimit) ||
        !Number.isFinite(maxConcurrentProxyRequests) ||
        !Number.isFinite(tokenCircuitBreakerThreshold) ||
        !Number.isFinite(tokenCooldownMinutes) ||
        !Number.isFinite(tokenHealthCheckIntervalSeconds) ||
        !Number.isFinite(tokenHealthCheckTimeoutMs) ||
        !Number.isFinite(tokenHealthCheckConcurrency) ||
        !Number.isFinite(tokenHealthCheckMaxCooldownMinutes)) {
      return res.status(400).json({ error: '运行参数格式错误，请检查输入范围' });
    }

    await updateEnvVariables({
      API_KEY_DEFAULT_RPM_LIMIT: apiKeyDefaultRpmLimit,
      MAX_CONCURRENT_PROXY_REQUESTS: maxConcurrentProxyRequests,
      TOKEN_CIRCUIT_BREAKER_THRESHOLD: tokenCircuitBreakerThreshold,
      TOKEN_COOLDOWN_MINUTES: tokenCooldownMinutes,
      TOKEN_HEALTHCHECK_ENABLED: tokenHealthCheckEnabled ? 'true' : 'false',
      TOKEN_HEALTHCHECK_INTERVAL_SECONDS: tokenHealthCheckIntervalSeconds,
      TOKEN_HEALTHCHECK_TIMEOUT_MS: tokenHealthCheckTimeoutMs,
      TOKEN_HEALTHCHECK_CONCURRENCY: tokenHealthCheckConcurrency,
      TOKEN_HEALTHCHECK_MAX_COOLDOWN_MINUTES: tokenHealthCheckMaxCooldownMinutes
    });
    await reloadRuntimeEnvFromDisk('settings:runtime');

    res.json({
      success: true,
      message: '运行参数已更新并即时生效',
      data: {
        apiKeyDefaultRpmLimit,
        maxConcurrentProxyRequests,
        tokenCircuitBreakerThreshold,
        tokenCooldownMinutes,
        tokenHealthCheckEnabled,
        tokenHealthCheckIntervalSeconds,
        tokenHealthCheckTimeoutMs,
        tokenHealthCheckConcurrency,
        tokenHealthCheckMaxCooldownMinutes
      }
    });
  } catch (error) {
    console.error('更新运行参数失败:', error);
    res.status(500).json({ error: '更新运行参数失败' });
  }
});

export default router;
