import express from 'express';
import { Token } from '../models/index.js';
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

function parseTokenId(id) {
  return parsePositiveInt(id, NaN, 1);
}

function maskSensitiveToken(token) {
  return {
    ...token,
    access_token: token.access_token ? '***' : null,
    refresh_token: token.refresh_token ? '***' : null,
    id_token: token.id_token ? '***' : null
  };
}

// 统一兼容新旧字段，降低前端和历史导入格式差异
function normalizeTokenPayload(payload = {}, fallbackName = '未命名账户') {
  return {
    name: payload.name || payload.email || payload.account_id || fallbackName,
    email: payload.email || null,
    account_id: payload.account_id || null,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    id_token: payload.id_token || null,
    expired_at: payload.expired_at || payload.expired || null,
    last_refresh_at: payload.last_refresh_at || payload.last_refresh || null
  };
}

function parsePlanTypeFromIdToken(idToken) {
  if (!idToken) {
    return 'free';
  }

  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) {
      return 'free';
    }

    // JWT payload 使用 base64url，需要做字符替换后再解码
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(normalized, 'base64').toString('utf-8'));
    const authInfo = payload['https://api.openai.com/auth'];

    if (!authInfo?.chatgpt_plan_type) {
      return 'free';
    }

    return String(authInfo.chatgpt_plan_type).toLowerCase();
  } catch (error) {
    console.warn('解析 ID Token 失败:', error.message);
    return 'free';
  }
}

function estimateQuota(token) {
  const planType = parsePlanTypeFromIdToken(token.id_token);
  let totalQuota = 50000;

  if (planType.includes('plus') || planType.includes('pro')) {
    totalQuota = 500000;
  } else if (planType.includes('team')) {
    totalQuota = 1000000;
  }

  // 估算规则：每次成功请求按约 100 tokens 消耗
  const used = (token.success_requests || 0) * 100;
  const remaining = Math.max(0, totalQuota - used);
  const failureRate = token.total_requests > 0
    ? Math.round(((token.failed_requests || 0) / token.total_requests) * 100)
    : 0;

  return {
    total: totalQuota,
    used,
    remaining,
    plan_type: planType,
    failure_rate: failureRate
  };
}

// 获取所有 Tokens（支持分页）
router.get('/', (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1, 1);
    const limit = parsePositiveInt(req.query.limit, 20, 1, 100);
    const offset = (page - 1) * limit;

    const total = Token.getTotalCount();
    const tokens = Token.getPaginated(offset, limit).map(maskSensitiveToken);

    res.json({
      data: tokens,
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('获取 Tokens 失败:', error);
    res.status(500).json({ error: '获取 Tokens 失败' });
  }
});

// 创建 Token
router.post('/', (req, res) => {
  try {
    const tokenPayload = normalizeTokenPayload(req.body);

    if (!tokenPayload.access_token || !tokenPayload.refresh_token) {
      return res.status(400).json({ error: 'access_token 和 refresh_token 是必需的' });
    }

    const id = Token.create(tokenPayload);

    res.json({
      success: true,
      id,
      message: 'Token 添加成功'
    });
  } catch (error) {
    console.error('添加 Token 失败:', error);
    res.status(500).json({ error: `添加 Token 失败: ${error.message}` });
  }
});

// 批量导入 Tokens
router.post('/import', (req, res) => {
  try {
    const { tokens } = req.body;

    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ error: '请提供有效的 tokens 数组' });
    }

    let successCount = 0;
    let failedCount = 0;
    const errors = [];

    for (let i = 0; i < tokens.length; i += 1) {
      try {
        const tokenPayload = normalizeTokenPayload(tokens[i], `导入账户 ${i + 1}`);
        if (!tokenPayload.access_token || !tokenPayload.refresh_token) {
          failedCount += 1;
          errors.push(`第 ${i + 1} 个 token: 缺少 access_token 或 refresh_token`);
          continue;
        }

        Token.create(tokenPayload);
        successCount += 1;
      } catch (error) {
        failedCount += 1;
        errors.push(`第 ${i + 1} 个 token: ${error.message}`);
      }
    }

    res.json({
      success: true,
      total: tokens.length,
      successCount,
      failedCount,
      errors: errors.length > 0 ? errors : undefined,
      message: `导入完成：成功 ${successCount} 个，失败 ${failedCount} 个`
    });
  } catch (error) {
    console.error('批量导入 Tokens 失败:', error);
    res.status(500).json({ error: `批量导入失败: ${error.message}` });
  }
});

// 更新 Token
router.put('/:id', (req, res) => {
  try {
    const id = parseTokenId(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: '无效的 Token ID' });
    }

    const { is_active: isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'is_active 必须是布尔值' });
    }

    if (!Token.findById(id)) {
      return res.status(404).json({ error: 'Token 不存在' });
    }

    Token.toggleActive(id, isActive);
    res.json({ success: true });
  } catch (error) {
    console.error('更新 Token 失败:', error);
    res.status(500).json({ error: '更新 Token 失败' });
  }
});

// 手动刷新 Token（占位接口）
router.post('/:id/refresh', (req, res) => {
  try {
    const id = parseTokenId(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: '无效的 Token ID' });
    }

    if (!Token.findById(id)) {
      return res.status(404).json({ error: 'Token 不存在' });
    }

    res.json({
      success: false,
      message: 'Token 刷新功能需要集成到 tokenManager'
    });
  } catch (error) {
    console.error('刷新 Token 失败:', error);
    res.status(500).json({ error: '刷新 Token 失败' });
  }
});

// 删除 Token
router.delete('/:id', (req, res) => {
  try {
    const id = parseTokenId(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: '无效的 Token ID' });
    }

    if (!Token.findById(id)) {
      return res.status(404).json({ error: 'Token 不存在' });
    }

    Token.delete(id);
    res.json({ success: true });
  } catch (error) {
    console.error('删除 Token 失败:', error);
    res.status(500).json({ error: '删除 Token 失败' });
  }
});

// 批量删除 Tokens
router.post('/batch-delete', (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '请提供有效的 ids 数组' });
    }

    const normalizedIds = Array.from(new Set(ids.map(parseTokenId).filter(Number.isFinite)));
    if (normalizedIds.length === 0) {
      return res.status(400).json({ error: '未提供有效的 Token ID' });
    }

    let successCount = 0;
    let failedCount = 0;
    const errors = [];

    normalizedIds.forEach((id) => {
      try {
        if (!Token.findById(id)) {
          failedCount += 1;
          errors.push(`ID ${id}: Token 不存在`);
          return;
        }

        Token.delete(id);
        successCount += 1;
      } catch (error) {
        failedCount += 1;
        errors.push(`ID ${id}: ${error.message}`);
      }
    });

    res.json({
      success: true,
      total: normalizedIds.length,
      successCount,
      failedCount,
      errors: errors.length > 0 ? errors : undefined,
      message: `批量删除完成：成功 ${successCount} 个，失败 ${failedCount} 个`
    });
  } catch (error) {
    console.error('批量删除 Tokens 失败:', error);
    res.status(500).json({ error: `批量删除失败: ${error.message}` });
  }
});

// 刷新 Token 额度
router.post('/:id/quota', (req, res) => {
  try {
    const id = parseTokenId(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: '无效的 Token ID' });
    }

    const token = Token.findById(id);
    if (!token) {
      return res.status(404).json({ error: 'Token 不存在' });
    }

    const quota = estimateQuota(token);
    Token.updateQuota(id, quota);

    res.json({
      success: true,
      quota,
      message: '额度已更新（基于请求统计估算）'
    });
  } catch (error) {
    console.error('刷新额度失败:', error);
    res.status(500).json({ error: `刷新额度失败: ${error.message}` });
  }
});

// 批量刷新所有 Token 额度
router.post('/quota/refresh-all', (req, res) => {
  try {
    const tokens = Token.getAll();
    let successCount = 0;
    let failedCount = 0;

    tokens.forEach((token) => {
      try {
        Token.updateQuota(token.id, estimateQuota(token));
        successCount += 1;
      } catch (error) {
        console.error(`刷新 Token ${token.id} 额度失败:`, error);
        failedCount += 1;
      }
    });

    res.json({
      success: true,
      total: tokens.length,
      successCount,
      failedCount,
      message: `批量刷新完成：成功 ${successCount} 个，失败 ${failedCount} 个`
    });
  } catch (error) {
    console.error('批量刷新额度失败:', error);
    res.status(500).json({ error: `批量刷新失败: ${error.message}` });
  }
});

export default router;
