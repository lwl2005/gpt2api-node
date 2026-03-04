import express from 'express';
import { ApiKey, ApiLog } from '../models/index.js';
import { authenticateAdmin, generateApiKey } from '../middleware/auth.js';

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

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

// 获取所有 API Keys
router.get('/', (req, res) => {
  try {
    const keys = ApiKey.getAll();
    const usageRows = ApiLog.getApiKeyUsageSummaries();
    const usageMap = new Map(usageRows.map((row) => [row.api_key_id, row]));

    const enriched = keys.map((key) => {
      const usage = usageMap.get(key.id) || {};
      const requests24h = usage.requests_24h || 0;
      const success24h = usage.success_24h || 0;
      const todayRequests = usage.today_requests || 0;
      const dailyLimit = Number.parseInt(key.daily_limit, 10) || 0;
      const successRate24h = requests24h > 0 ? Math.round((success24h / requests24h) * 100) : 100;
      const dailyRemaining = dailyLimit > 0 ? Math.max(0, dailyLimit - todayRequests) : null;
      const lastStatusCode = usage.last_status_code || null;

      const riskReasons = [];
      let riskScore = 0;

      if (requests24h >= 20 && successRate24h < 90) {
        riskScore += 2;
        riskReasons.push('24h 成功率偏低');
      } else if (requests24h >= 10 && successRate24h < 95) {
        riskScore += 1;
        riskReasons.push('24h 成功率下降');
      }

      if ((usage.failed_24h || 0) >= 10) {
        riskScore += 2;
        riskReasons.push('24h 失败量较高');
      } else if ((usage.failed_24h || 0) >= 3) {
        riskScore += 1;
      }

      if (Number.isFinite(Number.parseInt(lastStatusCode, 10)) && Number.parseInt(lastStatusCode, 10) >= 400) {
        riskScore += 1;
        riskReasons.push('最近请求失败');
      }

      if (dailyLimit > 0 && dailyRemaining === 0) {
        riskScore += 2;
        riskReasons.push('日配额耗尽');
      }

      return {
        ...key,
        requests_24h: requests24h,
        success_rate_24h: successRate24h,
        today_requests: todayRequests,
        daily_remaining: dailyRemaining,
        last_status_code: lastStatusCode,
        last_error_message: usage.last_error_message || null,
        last_request_at: usage.last_request_at || null,
        risk_score: riskScore,
        is_risky: riskScore > 0,
        risk_reason: riskReasons.join('；')
      };
    });

    res.json(enriched);
  } catch (error) {
    console.error('获取 API Keys 失败:', error);
    res.status(500).json({ error: '获取 API Keys 失败' });
  }
});

// 创建新的 API Key
router.post('/', (req, res) => {
  try {
    const { name, rpm_limit: rpmLimitInput, daily_limit: dailyLimitInput } = req.body;
    const key = generateApiKey();
    
    const id = ApiKey.create(key, name || '未命名');

    const settingsPayload = {};
    if (rpmLimitInput !== undefined) {
      const rpmLimit = parseNonNegativeInt(rpmLimitInput, NaN);
      if (!Number.isFinite(rpmLimit)) {
        return res.status(400).json({ error: 'rpm_limit 必须是大于等于 0 的整数' });
      }
      settingsPayload.rpm_limit = rpmLimit;
    }

    if (dailyLimitInput !== undefined) {
      const dailyLimit = parseNonNegativeInt(dailyLimitInput, NaN);
      if (!Number.isFinite(dailyLimit)) {
        return res.status(400).json({ error: 'daily_limit 必须是大于等于 0 的整数' });
      }
      settingsPayload.daily_limit = dailyLimit;
    }

    if (Object.keys(settingsPayload).length > 0) {
      ApiKey.updateSettings(id, settingsPayload);
    }
    
    res.json({
      success: true,
      id,
      key, // 只在创建时返回完整的 key
      name,
      message: '请保存此 API Key，之后将无法再次查看完整密钥'
    });
  } catch (error) {
    console.error('创建 API Key 失败:', error);
    res.status(500).json({ error: '创建 API Key 失败' });
  }
});

// 更新 API Key
router.put('/:id', (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id, NaN, 1);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: '无效的 API Key ID' });
    }

    const key = ApiKey.findById(id);
    if (!key) {
      return res.status(404).json({ error: 'API Key 不存在' });
    }

    const payload = {};
    if (req.body.is_active !== undefined) {
      if (typeof req.body.is_active !== 'boolean') {
        return res.status(400).json({ error: 'is_active 必须是布尔值' });
      }
      payload.is_active = req.body.is_active;
    }

    if (req.body.rpm_limit !== undefined) {
      payload.rpm_limit = parseNonNegativeInt(req.body.rpm_limit, NaN);
      if (!Number.isFinite(payload.rpm_limit)) {
        return res.status(400).json({ error: 'rpm_limit 必须是大于等于 0 的整数' });
      }
    }

    if (req.body.daily_limit !== undefined) {
      payload.daily_limit = parseNonNegativeInt(req.body.daily_limit, NaN);
      if (!Number.isFinite(payload.daily_limit)) {
        return res.status(400).json({ error: 'daily_limit 必须是大于等于 0 的整数' });
      }
    }

    const hasChanges = ApiKey.updateSettings(id, payload);
    if (!hasChanges) {
      return res.status(400).json({ error: '未提供可更新字段' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('更新 API Key 失败:', error);
    res.status(500).json({ error: '更新 API Key 失败' });
  }
});

// 删除 API Key
router.delete('/:id', (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id, NaN, 1);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: '无效的 API Key ID' });
    }

    const key = ApiKey.findById(id);
    if (!key) {
      return res.status(404).json({ error: 'API Key 不存在' });
    }

    ApiKey.delete(id);
    res.json({ success: true });
  } catch (error) {
    console.error('删除 API Key 失败:', error);
    res.status(500).json({ error: '删除 API Key 失败' });
  }
});

export default router;
