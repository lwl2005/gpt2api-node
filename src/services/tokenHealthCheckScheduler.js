import axios from 'axios';
import { randomUUID } from 'crypto';
import TokenManager from '../tokenManager.js';
import { Token } from '../models/index.js';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_CLIENT_VERSION = '0.101.0';
const CODEX_USER_AGENT = 'codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464';

function parseBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parsePositiveInt(value, defaultValue, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return defaultValue;
  }
  return Math.min(Math.max(parsed, min), max);
}

function normalizeErrorMessage(error) {
  if (typeof error?.response?.data?.error?.message === 'string') {
    return error.response.data.error.message;
  }
  if (typeof error?.response?.data === 'string') {
    return error.response.data;
  }
  if (error?.message) {
    return String(error.message);
  }
  return '健康检查失败';
}

function isModelAccessError(message = '') {
  return /selected model|model .*not exist|may not exist|no access|没有权限|模型不存在/i.test(message);
}

function buildManagerTokenData(token) {
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    id_token: token.id_token,
    account_id: token.account_id,
    email: token.email,
    expired_at: token.expired_at,
    last_refresh_at: token.last_refresh_at,
    type: 'codex'
  };
}

function hasAuthPayloadChanged(before, after) {
  if (!before || !after) {
    return false;
  }
  return (
    before.access_token !== after.access_token ||
    before.refresh_token !== after.refresh_token ||
    before.id_token !== after.id_token ||
    before.expired_at !== after.expired_at ||
    before.last_refresh_at !== after.last_refresh_at
  );
}

function getHealthCheckConfig() {
  const intervalSeconds = parsePositiveInt(process.env.TOKEN_HEALTHCHECK_INTERVAL_SECONDS, 120, 30, 86400);
  const timeoutMs = parsePositiveInt(process.env.TOKEN_HEALTHCHECK_TIMEOUT_MS, 15000, 1000, 120000);
  const baseCooldownMinutes = parsePositiveInt(process.env.TOKEN_COOLDOWN_MINUTES, 10, 1, 1440);
  const maxCooldownMinutes = parsePositiveInt(process.env.TOKEN_HEALTHCHECK_MAX_COOLDOWN_MINUTES, 720, 10, 1440);
  const batchSize = parsePositiveInt(process.env.TOKEN_HEALTHCHECK_BATCH_SIZE, 1000, 1, 5000);
  const model = String(process.env.TOKEN_HEALTHCHECK_MODEL || process.env.DEFAULT_CODEX_MODEL || 'gpt-5-codex').trim() || 'gpt-5-codex';

  return {
    enabled: parseBoolean(process.env.TOKEN_HEALTHCHECK_ENABLED, true),
    intervalSeconds,
    timeoutMs,
    baseCooldownMinutes,
    maxCooldownMinutes,
    batchSize,
    model
  };
}

async function probeTokenAvailability(accessToken, config) {
  const fallbackModel = 'gpt-5-codex';
  const models = config.model === fallbackModel ? [config.model] : [config.model, fallbackModel];
  let lastError = null;

  for (const model of models) {
    try {
      await axios.post('/responses', {
        model,
        stream: false,
        max_output_tokens: 8,
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'ping' }]
        }]
      }, {
        baseURL: CODEX_BASE_URL,
        timeout: config.timeoutMs,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': CODEX_USER_AGENT,
          Version: CODEX_CLIENT_VERSION,
          'Openai-Beta': 'responses=experimental',
          Session_id: randomUUID()
        }
      });
      return;
    } catch (error) {
      lastError = error;
      const message = normalizeErrorMessage(error);
      if (!isModelAccessError(message)) {
        break;
      }
    }
  }

  throw lastError || new Error('Token 健康探测失败');
}

export class TokenHealthCheckScheduler {
  constructor(options = {}) {
    this.timer = null;
    this.running = false;
    this.onTokenPayloadUpdated = typeof options.onTokenPayloadUpdated === 'function'
      ? options.onTokenPayloadUpdated
      : null;
    this.state = {
      startedAt: null,
      lastRunAt: null,
      lastRunSummary: null,
      lastError: null
    };
  }

  start(initialDelayMs = 5000) {
    if (this.timer) {
      return;
    }
    this.state.startedAt = new Date().toISOString();
    this.scheduleNext(initialDelayMs);
    console.log('✓ Token 健康巡检任务已启动');
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getState() {
    const config = getHealthCheckConfig();
    return {
      ...this.state,
      running: this.running,
      config
    };
  }

  scheduleNext(delayMs) {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runTick();
    }, Math.max(1000, delayMs));
  }

  async runTick() {
    const config = getHealthCheckConfig();
    const nextDelayMs = config.intervalSeconds * 1000;

    if (!config.enabled) {
      this.scheduleNext(Math.max(nextDelayMs, 60000));
      return;
    }

    if (this.running) {
      this.scheduleNext(nextDelayMs);
      return;
    }

    this.running = true;
    this.state.lastRunAt = new Date().toISOString();
    let checked = 0;
    let successCount = 0;
    let failedCount = 0;

    try {
      // 只巡检“已到时间”的账号，避免无意义探测
      const tokens = Token.getDueHealthCheckCandidates(config.batchSize);

      for (const token of tokens) {
        checked += 1;
        const success = await this.checkSingleToken(token, config);
        if (success) {
          successCount += 1;
        } else {
          failedCount += 1;
        }
      }

      this.state.lastRunSummary = {
        checked,
        successCount,
        failedCount
      };
      this.state.lastError = null;
    } catch (error) {
      this.state.lastError = normalizeErrorMessage(error);
      console.error('Token 健康巡检任务异常:', error);
    } finally {
      this.running = false;
      this.scheduleNext(nextDelayMs);
    }
  }

  async checkSingleToken(token, config) {
    const manager = new TokenManager(null);
    manager.tokenData = buildManagerTokenData(token);

    let accessToken = '';
    try {
      accessToken = await manager.getValidToken();
      if (!accessToken) {
        throw new Error('access_token 为空');
      }
    } catch (error) {
      // token 本身不可用（含 refresh 失败）时，直接进入封停与延时复测
      const nextFailCount = (Number.parseInt(token.health_fail_count, 10) || 0) + 1;
      const cooldownMinutes = Math.min(config.baseCooldownMinutes * nextFailCount, config.maxCooldownMinutes);
      Token.markHealthCheckFailure(token.id, normalizeErrorMessage(error), cooldownMinutes);
      return false;
    }

    if (hasAuthPayloadChanged(buildManagerTokenData(token), manager.tokenData)) {
      Token.updateAuthPayload(token.id, manager.tokenData);
      if (this.onTokenPayloadUpdated) {
        this.onTokenPayloadUpdated(token.id, manager.tokenData);
      }
    }

    try {
      // 使用最小探测请求验证账号是否可真正调用上游
      await probeTokenAvailability(accessToken, config);
      Token.markHealthCheckSuccess(token.id, config.intervalSeconds);
      return true;
    } catch (error) {
      const nextFailCount = (Number.parseInt(token.health_fail_count, 10) || 0) + 1;
      const cooldownMinutes = Math.min(config.baseCooldownMinutes * nextFailCount, config.maxCooldownMinutes);
      Token.markHealthCheckFailure(token.id, normalizeErrorMessage(error), cooldownMinutes);
      return false;
    }
  }
}

export default TokenHealthCheckScheduler;
