import express from 'express';
import { ApiLog, ApiKey, Token } from '../models/index.js';
import { authenticateAdmin } from '../middleware/auth.js';

const router = express.Router();

// 所有路由都需要认证
router.use(authenticateAdmin);

function parsePositiveInt(value, defaultValue, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return defaultValue;
  }
  return Math.min(Math.max(parsed, min), max);
}

function parseLogStatusFilter(value) {
  const normalized = String(value || 'all').toLowerCase();
  if (normalized === 'success' || normalized === 'error') {
    return normalized;
  }
  return 'all';
}

function csvEscape(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function resolveAnalyticsRange(range) {
  const normalized = String(range || '24h').toLowerCase();
  if (normalized === '7d') {
    return {
      key: '7d',
      label: '7天',
      sinceModifier: '-7 day',
      bucketCount: 7,
      bucketMs: 24 * 60 * 60 * 1000,
      granularity: 'day',
      windowHours: 7 * 24
    };
  }
  if (normalized === '30d') {
    return {
      key: '30d',
      label: '30天',
      sinceModifier: '-30 day',
      bucketCount: 30,
      bucketMs: 24 * 60 * 60 * 1000,
      granularity: 'day',
      windowHours: 30 * 24
    };
  }

  return {
    key: '24h',
    label: '24小时',
    sinceModifier: '-24 hour',
    bucketCount: 24,
    bucketMs: 60 * 60 * 1000,
    granularity: 'hour',
    windowHours: 24
  };
}

function toUtcDateKey(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function toUtcHourKey(date) {
  const dateKey = toUtcDateKey(date);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  return `${dateKey} ${hh}:00:00`;
}

function buildTrend(rangeConfig, rows = []) {
  const bucketMap = new Map(rows.map((row) => [
    String(row.bucket),
    {
      requestCount: Number.parseInt(row.request_count, 10) || 0,
      failedCount: Number.parseInt(row.failed_count, 10) || 0,
      avgLatency: Number.parseFloat(row.avg_response_time_ms) || 0
    }
  ]));

  const now = new Date();
  const labels = [];
  const requestData = [];
  const failedData = [];
  const latencyData = [];

  for (let offset = rangeConfig.bucketCount - 1; offset >= 0; offset -= 1) {
    const bucketDate = new Date(now.getTime() - (offset * rangeConfig.bucketMs));

    if (rangeConfig.granularity === 'hour') {
      bucketDate.setUTCMinutes(0, 0, 0);
      const key = toUtcHourKey(bucketDate);
      const label = `${String(bucketDate.getUTCHours()).padStart(2, '0')}:00`;
      labels.push(label);
      const bucket = bucketMap.get(key) || { requestCount: 0, failedCount: 0, avgLatency: 0 };
      requestData.push(bucket.requestCount);
      failedData.push(bucket.failedCount);
      latencyData.push(Number(bucket.avgLatency.toFixed(2)));
      continue;
    }

    bucketDate.setUTCHours(0, 0, 0, 0);
    const key = toUtcDateKey(bucketDate);
    const label = `${String(bucketDate.getUTCMonth() + 1).padStart(2, '0')}-${String(bucketDate.getUTCDate()).padStart(2, '0')}`;
    labels.push(label);
    const bucket = bucketMap.get(key) || { requestCount: 0, failedCount: 0, avgLatency: 0 };
    requestData.push(bucket.requestCount);
    failedData.push(bucket.failedCount);
    latencyData.push(Number(bucket.avgLatency.toFixed(2)));
  }

  return {
    labels,
    requestData,
    failedData,
    latencyData
  };
}

function formatLogsWithRelations(logs, apiKeys = [], tokens = []) {
  const apiKeyMap = {};
  const tokenMap = {};

  apiKeys.forEach((key) => {
    apiKeyMap[key.id] = key.name || `Key #${key.id}`;
  });
  tokens.forEach((token) => {
    tokenMap[token.id] = token.name || token.email || token.account_id || `Token #${token.id}`;
  });

  return logs.map((log) => ({
    ...log,
    api_key_name: log.api_key_id ? (apiKeyMap[log.api_key_id] || `Key #${log.api_key_id}`) : '-',
    token_name: log.token_id ? (tokenMap[log.token_id] || `Token #${log.token_id}`) : '-',
    response_time: Number.isFinite(Number.parseInt(log.response_time_ms, 10))
      ? Number.parseInt(log.response_time_ms, 10)
      : null
  }));
}

function filterLogs(logs = [], { keyword = '', status = 'all' } = {}) {
  let filtered = logs;

  if (status === 'success') {
    filtered = filtered.filter((log) => log.status_code >= 200 && log.status_code < 400);
  } else if (status === 'error') {
    filtered = filtered.filter((log) => log.status_code >= 400);
  }

  const normalizedKeyword = String(keyword || '').trim().toLowerCase();
  if (!normalizedKeyword) {
    return filtered;
  }

  return filtered.filter((log) => {
    const matchedText = [
      log.api_key_name,
      log.token_name,
      log.model,
      log.endpoint,
      log.error_message,
      log.status_code
    ].map((item) => String(item || '').toLowerCase()).join(' ');
    return matchedText.includes(normalizedKeyword);
  });
}

// 获取总览统计（仪表盘）
router.get('/', (req, res) => {
  try {
    const apiKeys = ApiKey.getAll();
    const activeApiKeyCount = apiKeys.filter((item) => Boolean(item.is_active)).length;
    const disabledApiKeyCount = apiKeys.length - activeApiKeyCount;

    const activeTokens = Token.getActive();
    const allTokens = Token.getAll();
    const coolingTokens = Token.getCoolingCount();
    const tokenUsageSummary = Token.getUsageSummary();
    const tokenHealthSummary = Token.getHealthSummary();

    const dashboardSummary = ApiLog.getDashboardSummary();
    const summary24h = ApiLog.getWindowSummary('-24 hour');

    const totalRequests = dashboardSummary.total_requests || 0;
    const successRequests = dashboardSummary.success_requests || 0;
    const failedRequests = dashboardSummary.failed_requests || 0;

    const requests24h = summary24h.total_requests || 0;
    const success24h = summary24h.success_requests || 0;

    const topModels = ApiLog.getTopModels(3, '-7 day');
    const topEndpoints = ApiLog.getTopEndpoints(3, '-7 day');
    const apiKeyUsageSummaries = ApiLog.getApiKeyUsageSummaries();
    const apiKeyNameMap = new Map(apiKeys.map((key) => [key.id, key.name || `Key #${key.id}`]));
    const riskyApiKeys = apiKeyUsageSummaries
      .map((row) => {
        const requests24h = row.requests_24h || 0;
        const success24h = row.success_24h || 0;
        const failed24h = row.failed_24h || 0;
        const successRate24h = requests24h > 0 ? Math.round((success24h / requests24h) * 100) : 100;
        const riskScore = (failed24h >= 10 ? 2 : failed24h >= 3 ? 1 : 0)
          + (requests24h >= 20 && successRate24h < 90 ? 2 : 0)
          + ((row.last_status_code || 0) >= 400 ? 1 : 0);

        return {
          api_key_id: row.api_key_id,
          name: apiKeyNameMap.get(row.api_key_id) || `Key #${row.api_key_id}`,
          requests24h,
          failed24h,
          successRate24h,
          lastStatusCode: row.last_status_code || null,
          riskScore
        };
      })
      .filter((item) => item.riskScore > 0)
      .sort((a, b) => {
        if (b.riskScore !== a.riskScore) {
          return b.riskScore - a.riskScore;
        }
        return b.failed24h - a.failed24h;
      })
      .slice(0, 5);

    res.json({
      apiKeys: activeApiKeyCount,
      apiKeysTotal: apiKeys.length,
      apiKeysDisabled: disabledApiKeyCount,
      tokens: activeTokens.length,
      tokensTotal: allTokens.length,
      coolingTokens,
      todayRequests: dashboardSummary.today_requests || 0,
      requestsLastHour: dashboardSummary.requests_last_hour || 0,
      requests24h,
      successRate: totalRequests > 0 ? Math.round((successRequests / totalRequests) * 100) : 100,
      successRate24h: requests24h > 0 ? Math.round((success24h / requests24h) * 100) : 100,
      avgResponseTimeMs: Number.parseFloat(summary24h.avg_response_time_ms) || 0,
      totalRequests,
      successRequests,
      failedRequests,
      tokenEstimatedConsumed: tokenUsageSummary.estimated_token_consumed || 0,
      tokenHealth: {
        total: tokenHealthSummary.total || 0,
        healthy: tokenHealthSummary.healthy || 0,
        unhealthy: tokenHealthSummary.unhealthy || 0,
        unknown: tokenHealthSummary.unknown || 0,
        autoDisabled: tokenHealthSummary.auto_disabled || 0,
        dueForCheck: tokenHealthSummary.due_for_check || 0
      },
      riskyApiKeys,
      topModels,
      topEndpoints
    });
  } catch (error) {
    console.error('获取统计失败:', error);
    res.status(500).json({ error: '获取统计失败' });
  }
});

// 获取数据分析统计
router.get('/analytics', (req, res) => {
  try {
    const rangeConfig = resolveAnalyticsRange(req.query.range);
    const summary = ApiLog.getWindowSummary(rangeConfig.sinceModifier);
    const latency = ApiLog.getLatencySummary(rangeConfig.sinceModifier);

    const totalRequests = summary.total_requests || 0;
    const successRequests = summary.success_requests || 0;
    const failedRequests = summary.failed_requests || 0;
    const avgResponseTime = Number.parseFloat(summary.avg_response_time_ms) || 0;
    const throughputPerHour = totalRequests > 0
      ? Number((totalRequests / rangeConfig.windowHours).toFixed(2))
      : 0;

    res.json({
      range: rangeConfig.key,
      rangeLabel: rangeConfig.label,
      totalRequests,
      successRequests,
      failedRequests,
      avgResponseTime,
      avgResponseTimeMs: avgResponseTime,
      throughputPerHour,
      latencySampleCount: latency.sample_count || 0,
      p50ResponseTime: latency.p50_ms || 0,
      p95ResponseTime: latency.p95_ms || 0,
      minResponseTime: latency.min_ms || 0,
      maxResponseTime: latency.max_ms || 0,
      successRate: totalRequests > 0 ? Number(((successRequests / totalRequests) * 100).toFixed(2)) : 100,
      errorRate: totalRequests > 0 ? Number(((failedRequests / totalRequests) * 100).toFixed(2)) : 0
    });
  } catch (error) {
    console.error('获取分析统计失败:', error);
    res.status(500).json({ error: '获取分析统计失败' });
  }
});

// 获取图表数据
router.get('/charts', (req, res) => {
  try {
    const rangeConfig = resolveAnalyticsRange(req.query.range);

    const trendRows = ApiLog.getTrendBuckets(rangeConfig.sinceModifier, rangeConfig.granularity);
    const trend = buildTrend(rangeConfig, trendRows);

    const modelStats = ApiLog.getModelDistribution(rangeConfig.sinceModifier, 6);
    const endpointStats = ApiLog.getEndpointDistribution(rangeConfig.sinceModifier, 6);

    const modelLabels = modelStats.map((item) => item.model);
    const modelData = modelStats.map((item) => item.request_count);

    const endpointLabels = endpointStats.map((item) => item.endpoint);
    const endpointData = endpointStats.map((item) => item.request_count);

    if (modelLabels.length === 0) {
      modelLabels.push('暂无数据');
      modelData.push(0);
    }

    if (endpointLabels.length === 0) {
      endpointLabels.push('暂无数据');
      endpointData.push(0);
    }

    res.json({
      trendLabels: trend.labels,
      trendData: trend.requestData,
      trendFailedData: trend.failedData,
      trendLatencyData: trend.latencyData,
      modelLabels,
      modelData,
      endpointLabels,
      endpointData
    });
  } catch (error) {
    console.error('获取图表数据失败:', error);
    res.status(500).json({ error: '获取图表数据失败' });
  }
});

// 获取账号统计
router.get('/accounts', (req, res) => {
  try {
    const rangeConfig = resolveAnalyticsRange(req.query.range);
    const tokenSummaries = ApiLog.getTokenUsageSummaries(rangeConfig.sinceModifier);
    const summaryMap = new Map(tokenSummaries.map((item) => [item.token_id, item]));

    const tokens = Token.getAll();
    const now = Date.now();

    const accountStats = tokens.map((token) => {
      const usage = summaryMap.get(token.id) || {};
      const lifetimeRequests = token.total_requests || 0;
      const lifetimeSuccess = token.success_requests || 0;
      const requestsInWindow = usage.requests_in_window || 0;
      const successInWindow = usage.success_in_window || 0;

      const cooldownUntilTs = token.cooldown_until ? Date.parse(token.cooldown_until) : NaN;
      const isCooling = Boolean(token.is_active) && Number.isFinite(cooldownUntilTs) && cooldownUntilTs > now;
      const healthNextCheckTs = token.health_next_check_at ? Date.parse(token.health_next_check_at) : NaN;

      return {
        id: token.id,
        name: token.name || token.email || token.account_id || `Token #${token.id}`,
        requests: lifetimeRequests,
        requestsInWindow,
        estimatedConsumed: token.quota_used > 0 ? token.quota_used : lifetimeSuccess * 100,
        successRate: lifetimeRequests > 0
          ? Math.round((lifetimeSuccess / lifetimeRequests) * 100)
          : 100,
        successRateInWindow: requestsInWindow > 0
          ? Math.round((successInWindow / requestsInWindow) * 100)
          : 100,
        avgResponseTime: Number.parseFloat(usage.avg_response_time_ms) || 0,
        lastUsed: token.last_used_at || usage.last_request_at || null,
        consecutiveFailures: token.consecutive_failures || 0,
        isCooling,
        isActive: Boolean(token.is_active),
        healthStatus: token.health_status || 'unknown',
        healthFailCount: token.health_fail_count || 0,
        healthAutoDisabled: Boolean(token.health_auto_disabled),
        healthNextCheckAt: Number.isFinite(healthNextCheckTs) ? token.health_next_check_at : null,
        healthLastCheckedAt: token.health_last_checked_at || null,
        healthLastError: token.health_last_error || null,
        lastStatusCode: usage.last_status_code || null
      };
    }).sort((a, b) => {
      if (a.healthStatus !== b.healthStatus) {
        if (a.healthStatus === 'unhealthy') return -1;
        if (b.healthStatus === 'unhealthy') return 1;
      }
      if (b.requestsInWindow !== a.requestsInWindow) {
        return b.requestsInWindow - a.requestsInWindow;
      }
      return b.requests - a.requests;
    });

    res.json(accountStats);
  } catch (error) {
    console.error('获取账号统计失败:', error);
    res.status(500).json({ error: '获取账号统计失败' });
  }
});

// 获取最近的日志
router.get('/logs', (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 50, 1, 5000);
    const status = parseLogStatusFilter(req.query.status);
    const keyword = String(req.query.keyword || '').trim();

    const logs = ApiLog.getRecent(limit);
    const apiKeys = ApiKey.getAll();
    const tokens = Token.getAll();
    const formattedLogs = formatLogsWithRelations(logs, apiKeys, tokens);
    const filteredLogs = filterLogs(formattedLogs, { keyword, status });

    res.json(filteredLogs);
  } catch (error) {
    console.error('获取日志失败:', error);
    res.status(500).json({ error: '获取日志失败' });
  }
});

// 导出日志 CSV
router.get('/logs/export', (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 500, 1, 20000);
    const status = parseLogStatusFilter(req.query.status);
    const keyword = String(req.query.keyword || '').trim();

    const logs = ApiLog.getRecent(limit);
    const apiKeys = ApiKey.getAll();
    const tokens = Token.getAll();
    const formattedLogs = formatLogsWithRelations(logs, apiKeys, tokens);
    const filteredLogs = filterLogs(formattedLogs, { keyword, status });

    const headers = ['time', 'api_key', 'token', 'model', 'endpoint', 'status_code', 'response_time_ms', 'error_message'];
    const rows = filteredLogs.map((log) => [
      log.created_at,
      log.api_key_name,
      log.token_name,
      log.model,
      log.endpoint,
      log.status_code,
      log.response_time,
      log.error_message
    ]);

    const csv = [headers, ...rows]
      .map((row) => row.map(csvEscape).join(','))
      .join('\n');

    const dateTag = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="api-logs-${dateTag}.csv"`);
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    console.error('导出日志失败:', error);
    res.status(500).json({ error: '导出日志失败' });
  }
});

// 清理历史日志
router.post('/logs/cleanup', (req, res) => {
  try {
    const days = parsePositiveInt(req.body?.days, 30, 1, 3650);
    const deletedCount = ApiLog.cleanupOlderThanDays(days);
    res.json({
      success: true,
      days,
      deletedCount,
      message: `已清理 ${days} 天前日志，共删除 ${deletedCount} 条`
    });
  } catch (error) {
    console.error('清理日志失败:', error);
    res.status(500).json({ error: '清理日志失败' });
  }
});

// 获取最近活动记录
router.get('/recent-activity', (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 10, 1, 100);
    const activities = [];

    const logs = ApiLog.getRecent(30);
    const apiKeys = ApiKey.getAll();
    const tokens = Token.getAll();

    const apiKeyMap = {};
    apiKeys.forEach((key) => {
      apiKeyMap[key.id] = key.name || `Key #${key.id}`;
    });

    const tokenMap = {};
    tokens.forEach((token) => {
      tokenMap[token.id] = token.name || token.email || token.account_id || `Token #${token.id}`;
    });

    logs.forEach((log) => {
      const isSuccess = log.status_code >= 200 && log.status_code < 400;
      activities.push({
        type: isSuccess ? 'api_success' : 'api_error',
        icon: isSuccess ? 'fa-check-circle' : 'fa-exclamation-circle',
        color: isSuccess ? 'text-green-600' : 'text-red-600',
        title: isSuccess ? 'API 请求成功' : 'API 请求失败',
        description: `${apiKeyMap[log.api_key_id] || 'Unknown Key'} / ${tokenMap[log.token_id] || 'Unknown Token'} 调用 ${log.model || 'Unknown'}（${log.endpoint || '-'})`,
        time: log.created_at
      });
    });

    apiKeys.slice(-5).forEach((key) => {
      activities.push({
        type: 'api_key_created',
        icon: 'fa-key',
        color: 'text-blue-600',
        title: 'API Key 创建',
        description: `创建了新的 API Key: ${key.name || 'Unnamed'}`,
        time: key.created_at
      });
    });

    tokens.slice(-5).forEach((token) => {
      activities.push({
        type: 'token_added',
        icon: 'fa-user-plus',
        color: 'text-purple-600',
        title: 'Token 添加',
        description: `添加了新账号: ${token.name || token.email || 'Unnamed'}`,
        time: token.created_at
      });
    });

    activities.sort((a, b) => new Date(b.time) - new Date(a.time));
    res.json(activities.slice(0, limit));
  } catch (error) {
    console.error('获取最近活动失败:', error);
    res.status(500).json({ error: '获取最近活动失败' });
  }
});

export default router;
