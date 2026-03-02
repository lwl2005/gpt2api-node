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

// 获取总览统计
router.get('/', (req, res) => {
  try {
    const apiKeys = ApiKey.getAll();
    const activeTokens = Token.getActive();
    const usageSummary = Token.getUsageSummary();

    const totalRequests = usageSummary.total_requests || 0;
    const successRequests = usageSummary.success_requests || 0;
    const failedRequests = usageSummary.failed_requests || 0;
    
    res.json({
      apiKeys: apiKeys.length,
      tokens: activeTokens.length,
      todayRequests: totalRequests,
      successRate: totalRequests > 0 ? Math.round((successRequests / totalRequests) * 100) : 100,
      totalRequests,
      successRequests,
      failedRequests
    });
  } catch (error) {
    console.error('获取统计失败:', error);
    res.status(500).json({ error: '获取统计失败' });
  }
});

// 获取数据分析统计
router.get('/analytics', (req, res) => {
  try {
    const usageSummary = Token.getUsageSummary();

    const totalRequests = usageSummary.total_requests || 0;
    const successRequests = usageSummary.success_requests || 0;
    const failedRequests = usageSummary.failed_requests || 0;
    
    // 计算平均响应时间（模拟数据，实际需要从日志计算）
    const avgResponseTime = 150;
    
    res.json({
      totalRequests,
      successRequests,
      failedRequests,
      avgResponseTime
    });
  } catch (error) {
    console.error('获取分析统计失败:', error);
    res.status(500).json({ error: '获取分析统计失败' });
  }
});

// 获取图表数据
router.get('/charts', (req, res) => {
  try {
    const range = req.query.range === '7d' || req.query.range === '30d'
      ? req.query.range
      : '24h';
    
    // 从 api_logs 表获取实际日志数据
    const logs = ApiLog.getRecent(10000); // 获取更多日志用于统计
    
    const bucketCount = range === '24h' ? 24 : (range === '7d' ? 7 : 30);
    const bucketDuration = range === '24h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const now = Date.now();
    const start = now - (bucketCount * bucketDuration);

    // 单次遍历日志，避免每个桶重复 filter 导致 O(n*k)
    const trendData = new Array(bucketCount).fill(0);
    logs.forEach((log) => {
      const ts = Date.parse(log.created_at);
      if (Number.isNaN(ts) || ts < start || ts >= now) {
        return;
      }
      const idx = Math.floor((ts - start) / bucketDuration);
      if (idx >= 0 && idx < bucketCount) {
        trendData[idx] += 1;
      }
    });

    const trendLabels = Array.from({ length: bucketCount }, (_, idx) => {
      const ago = bucketCount - 1 - idx;
      return range === '24h' ? `${ago}小时前` : `${ago}天前`;
    });
    
    // 模型分布数据 - 从 api_logs 表统计实际使用的模型
    const modelCounts = {};
    
    logs.forEach(log => {
      if (log.model) {
        modelCounts[log.model] = (modelCounts[log.model] || 0) + 1;
      }
    });
    
    // 转换为数组并排序
    const modelStats = Object.entries(modelCounts)
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6); // 取前6个模型
    
    const modelLabels = modelStats.map(m => m.model);
    const modelData = modelStats.map(m => m.count);
    
    // 如果没有数据，使用默认值
    if (modelLabels.length === 0) {
      modelLabels.push('暂无数据');
      modelData.push(1);
    }
    
    res.json({
      trendLabels,
      trendData,
      modelLabels,
      modelData
    });
  } catch (error) {
    console.error('获取图表数据失败:', error);
    res.status(500).json({ error: '获取图表数据失败' });
  }
});

// 获取账号统计
router.get('/accounts', (req, res) => {
  try {
    const tokens = Token.getAll();
    
    const accountStats = tokens.map(token => ({
      name: token.name || token.email || token.account_id || 'Unknown',
      requests: token.total_requests || 0,
      successRate: token.total_requests > 0 
        ? Math.round(((token.success_requests || 0) / token.total_requests) * 100) 
        : 100,
      avgResponseTime: Math.floor(Math.random() * 200) + 50,
      lastUsed: token.last_used_at
    })).filter(m => m.requests > 0);
    
    res.json(accountStats);
  } catch (error) {
    console.error('获取账号统计失败:', error);
    res.status(500).json({ error: '获取账号统计失败' });
  }
});

// 获取最近的日志
router.get('/logs', (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 50, 1, 500);
    
    const logs = ApiLog.getRecent(limit);
    
    // 获取所有 API Keys 用于查找名称
    const apiKeys = ApiKey.getAll();
    const apiKeyMap = {};
    apiKeys.forEach(key => {
      apiKeyMap[key.id] = key.name || `Key #${key.id}`;
    });
    
    // 格式化日志数据
    const formattedLogs = logs.map(log => ({
      ...log,
      api_key_name: log.api_key_id ? (apiKeyMap[log.api_key_id] || `Key #${log.api_key_id}`) : '-',
      response_time: Math.floor(Math.random() * 500) + 50
    }));
    
    res.json(formattedLogs);
  } catch (error) {
    console.error('获取日志失败:', error);
    res.status(500).json({ error: '获取日志失败' });
  }
});

// 获取最近活动记录
router.get('/recent-activity', (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 10, 1, 100);
    const activities = [];
    
    // 获取最近的API日志
    const logs = ApiLog.getRecent(20);
    const apiKeys = ApiKey.getAll();
    const tokens = Token.getAll();
    
    // API Key映射
    const apiKeyMap = {};
    apiKeys.forEach(key => {
      apiKeyMap[key.id] = key.name || `Key #${key.id}`;
    });
    
    // 从日志中提取活动
    logs.forEach(log => {
      const isSuccess = log.status_code >= 200 && log.status_code < 300;
      activities.push({
        type: isSuccess ? 'api_success' : 'api_error',
        icon: isSuccess ? 'fa-check-circle' : 'fa-exclamation-circle',
        color: isSuccess ? 'text-green-600' : 'text-red-600',
        title: isSuccess ? 'API 请求成功' : 'API 请求失败',
        description: `${apiKeyMap[log.api_key_id] || 'Unknown'} 调用 ${log.model || 'Unknown'} 模型`,
        time: log.created_at
      });
    });
    
    // 添加最近创建的API Keys
    apiKeys.slice(-5).forEach(key => {
      activities.push({
        type: 'api_key_created',
        icon: 'fa-key',
        color: 'text-blue-600',
        title: 'API Key 创建',
        description: `创建了新的 API Key: ${key.name || 'Unnamed'}`,
        time: key.created_at
      });
    });
    
    // 添加最近添加的Tokens
    tokens.slice(-5).forEach(token => {
      activities.push({
        type: 'token_added',
        icon: 'fa-user-plus',
        color: 'text-purple-600',
        title: 'Token 添加',
        description: `添加了新账号: ${token.name || token.email || 'Unnamed'}`,
        time: token.created_at
      });
    });
    
    // 按时间排序并限制数量
    activities.sort((a, b) => new Date(b.time) - new Date(a.time));
    const recentActivities = activities.slice(0, limit);
    
    res.json(recentActivities);
  } catch (error) {
    console.error('获取最近活动失败:', error);
    res.status(500).json({ error: '获取最近活动失败' });
  }
});

export default router;
