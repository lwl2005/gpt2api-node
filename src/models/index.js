import db from '../config/database.js';
import bcrypt from 'bcryptjs';

function getDefaultApiKeyRpmLimit() {
  return Math.max(Number.parseInt(process.env.API_KEY_DEFAULT_RPM_LIMIT || '60', 10) || 60, 0);
}

function getTokenCircuitBreakerThreshold() {
  // 按产品要求：失败一次立即进入冷却，阈值固定为 1
  return 1;
}

function getTokenCooldownMinutes() {
  return Math.max(Number.parseInt(process.env.TOKEN_COOLDOWN_MINUTES || '10', 10) || 10, 1);
}

function normalizeNonNegativeInt(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    return defaultValue;
  }
  return parsed;
}

function buildTokenFilterClause(filters = {}) {
  const conditions = [];
  const params = [];

  const keyword = String(filters.keyword || '').trim();
  if (keyword) {
    const likeKeyword = `%${keyword}%`;
    conditions.push('(name LIKE ? OR email LIKE ? OR account_id LIKE ?)');
    params.push(likeKeyword, likeKeyword, likeKeyword);
  }

  const status = String(filters.status || 'all').toLowerCase();
  if (status === 'active') {
    conditions.push('is_active = 1 AND (cooldown_until IS NULL OR cooldown_until <= CURRENT_TIMESTAMP)');
  } else if (status === 'healthy') {
    conditions.push('health_status = \'healthy\'');
  } else if (status === 'unhealthy') {
    conditions.push('health_status = \'unhealthy\'');
  } else if (status === 'auto-disabled') {
    conditions.push('is_active = 0 AND health_auto_disabled = 1');
  } else if (status === 'disabled') {
    conditions.push('is_active = 0');
  } else if (status === 'cooling') {
    conditions.push(`
      (
        (is_active = 1 AND cooldown_until IS NOT NULL AND cooldown_until > CURRENT_TIMESTAMP)
        OR
        (is_active = 0 AND health_auto_disabled = 1 AND (
          (health_next_check_at IS NOT NULL AND health_next_check_at > CURRENT_TIMESTAMP)
          OR
          (cooldown_until IS NOT NULL AND cooldown_until > CURRENT_TIMESTAMP)
        ))
      )
    `);
  }

  return {
    whereSql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  };
}

export class User {
  static findByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  static findById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  static async create(username, password) {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(
      username,
      hashedPassword
    );
    return result.lastInsertRowid;
  }

  static async updatePassword(id, newPassword) {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      hashedPassword,
      id
    );
  }

  static async verifyPassword(password, hashedPassword) {
    return await bcrypt.compare(password, hashedPassword);
  }
}

export class ApiKey {
  static getAll() {
    return db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all();
  }

  static findById(id) {
    return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  }

  static findByKey(key) {
    return db.prepare('SELECT * FROM api_keys WHERE key = ? AND is_active = 1').get(key);
  }

  static create(key, name) {
    const result = db.prepare(`
      INSERT INTO api_keys (key, name, rpm_limit, daily_limit)
      VALUES (?, ?, ?, ?)
    `).run(key, name, getDefaultApiKeyRpmLimit(), 0);
    return result.lastInsertRowid;
  }

  static delete(id) {
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  }

  static updateUsage(id) {
    db.prepare('UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  }

  static toggleActive(id, isActive) {
    db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
  }

  static updateSettings(id, data = {}) {
    const fields = [];
    const values = [];

    if (typeof data.is_active === 'boolean') {
      fields.push('is_active = ?');
      values.push(data.is_active ? 1 : 0);
    }

    if (data.rpm_limit !== undefined) {
      fields.push('rpm_limit = ?');
      values.push(normalizeNonNegativeInt(data.rpm_limit, getDefaultApiKeyRpmLimit()));
    }

    if (data.daily_limit !== undefined) {
      fields.push('daily_limit = ?');
      values.push(normalizeNonNegativeInt(data.daily_limit, 0));
    }

    if (fields.length === 0) {
      return false;
    }

    values.push(id);
    db.prepare(`UPDATE api_keys SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return true;
  }
}

export class Token {
  static getAll() {
    return db.prepare('SELECT * FROM tokens ORDER BY created_at DESC').all();
  }

  static getTotalCount(filters = {}) {
    const { whereSql, params } = buildTokenFilterClause(filters);
    return db.prepare(`SELECT COUNT(*) as count FROM tokens ${whereSql}`).get(...params).count;
  }

  static getPaginated(offset = 0, limit = 20, filters = {}) {
    const { whereSql, params } = buildTokenFilterClause(filters);
    return db.prepare(`
      SELECT * FROM tokens
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
  }

  static getActive() {
    return db.prepare(`
      SELECT * FROM tokens
      WHERE is_active = 1
        AND (cooldown_until IS NULL OR cooldown_until <= CURRENT_TIMESTAMP)
    `).all();
  }

  static getCoolingCount() {
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM tokens
      WHERE is_active = 1
        AND cooldown_until IS NOT NULL
        AND cooldown_until > CURRENT_TIMESTAMP
    `).get();
    return row?.count || 0;
  }

  static getUsageSummary() {
    return db.prepare(`
      SELECT
        COALESCE(SUM(total_requests), 0) as total_requests,
        COALESCE(SUM(success_requests), 0) as success_requests,
        COALESCE(SUM(failed_requests), 0) as failed_requests,
        COALESCE(SUM(CASE
          WHEN quota_used IS NOT NULL AND quota_used > 0 THEN quota_used
          ELSE success_requests * 100
        END), 0) as estimated_token_consumed
      FROM tokens
    `).get();
  }

  static getHealthSummary() {
    return db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN health_status = 'healthy' THEN 1 ELSE 0 END), 0) as healthy,
        COALESCE(SUM(CASE WHEN health_status = 'unhealthy' THEN 1 ELSE 0 END), 0) as unhealthy,
        COALESCE(SUM(CASE WHEN health_status IS NULL OR health_status = '' OR health_status = 'unknown' THEN 1 ELSE 0 END), 0) as unknown,
        COALESCE(SUM(CASE WHEN health_auto_disabled = 1 THEN 1 ELSE 0 END), 0) as auto_disabled,
        COALESCE(SUM(CASE WHEN health_next_check_at IS NULL OR health_next_check_at <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END), 0) as due_for_check
      FROM tokens
    `).get();
  }

  static getDueHealthCheckCandidates(limit = 200) {
    const normalizedLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 5000);
    // 仅返回到达巡检时间的账号，避免每轮扫描都对全表发请求
    return db.prepare(`
      SELECT *
      FROM tokens
      WHERE health_next_check_at IS NULL
         OR health_next_check_at <= CURRENT_TIMESTAMP
      ORDER BY
        CASE WHEN health_next_check_at IS NULL THEN 0 ELSE 1 END ASC,
        health_next_check_at ASC,
        created_at ASC
      LIMIT ?
    `).all(normalizedLimit);
  }

  static findById(id) {
    return db.prepare('SELECT * FROM tokens WHERE id = ?').get(id);
  }

  static create(data) {
    const result = db.prepare(`
      INSERT INTO tokens (name, email, account_id, access_token, refresh_token, id_token, expired_at, last_refresh_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.name || null,
      data.email || null,
      data.account_id || null,
      data.access_token,
      data.refresh_token,
      data.id_token || null,
      data.expired_at || null,
      data.last_refresh_at || new Date().toISOString()
    );
    return result.lastInsertRowid;
  }

  static update(id, data) {
    db.prepare(`
      UPDATE tokens
      SET access_token = ?, refresh_token = ?, id_token = ?, expired_at = ?, last_refresh_at = ?
      WHERE id = ?
    `).run(
      data.access_token,
      data.refresh_token,
      data.id_token || null,
      data.expired_at || null,
      new Date().toISOString(),
      id
    );
  }

  static updateAuthPayload(id, data = {}) {
    db.prepare(`
      UPDATE tokens
      SET access_token = ?,
          refresh_token = ?,
          id_token = ?,
          expired_at = ?,
          last_refresh_at = ?
      WHERE id = ?
    `).run(
      data.access_token || null,
      data.refresh_token || null,
      data.id_token || null,
      data.expired_at || null,
      data.last_refresh_at || null,
      id
    );
  }

  static delete(id) {
    // 先删除相关的 api_logs 记录
    db.prepare('DELETE FROM api_logs WHERE token_id = ?').run(id);
    // 再删除 token
    db.prepare('DELETE FROM tokens WHERE id = ?').run(id);
  }

  static toggleActive(id, isActive) {
    if (isActive) {
      db.prepare(`
        UPDATE tokens
        SET is_active = 1,
            health_auto_disabled = 0,
            cooldown_until = NULL,
            consecutive_failures = 0
        WHERE id = ?
      `).run(id);
      return;
    }

    db.prepare('UPDATE tokens SET is_active = 0 WHERE id = ?').run(id);
  }

  static updateUsage(id, success = true) {
    if (success) {
      db.prepare(`
        UPDATE tokens
        SET total_requests = total_requests + 1,
            success_requests = success_requests + 1,
            consecutive_failures = 0,
            cooldown_until = NULL,
            last_used_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(id);
    } else {
      const threshold = getTokenCircuitBreakerThreshold();
      const baseCooldownMinutes = getTokenCooldownMinutes();
      db.prepare(`
        UPDATE tokens
        SET total_requests = total_requests + 1,
            failed_requests = failed_requests + 1,
            consecutive_failures = consecutive_failures + 1,
            cooldown_until = CASE
              WHEN consecutive_failures + 1 >= ? THEN datetime(
                'now',
                '+' || (? * (consecutive_failures + 1)) || ' minutes'
              )
              ELSE cooldown_until
            END,
            last_used_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(threshold, baseCooldownMinutes, id);
    }
  }

  static markHealthCheckSuccess(id, nextCheckSeconds = 120) {
    const normalizedSeconds = Math.min(Math.max(Number.parseInt(nextCheckSeconds, 10) || 120, 30), 86400);
    // 自动封停账号探测成功后自动恢复，并重置失败计数
    db.prepare(`
      UPDATE tokens
      SET health_status = 'healthy',
          health_last_checked_at = CURRENT_TIMESTAMP,
          health_last_success_at = CURRENT_TIMESTAMP,
          health_last_error = NULL,
          health_fail_count = 0,
          health_next_check_at = datetime('now', '+' || ? || ' seconds'),
          is_active = CASE WHEN health_auto_disabled = 1 THEN 1 ELSE is_active END,
          health_auto_disabled = 0,
          cooldown_until = CASE WHEN health_auto_disabled = 1 THEN NULL ELSE cooldown_until END,
          consecutive_failures = CASE WHEN health_auto_disabled = 1 THEN 0 ELSE consecutive_failures END
      WHERE id = ?
    `).run(normalizedSeconds, id);
  }

  static markHealthCheckFailure(id, message, cooldownMinutes = 10) {
    const normalizedCooldownMinutes = Math.min(Math.max(Number.parseInt(cooldownMinutes, 10) || 10, 1), 1440);
    // 探测失败后封停并设置下次复测时间，失败次数会用于递增冷却时长
    db.prepare(`
      UPDATE tokens
      SET health_status = 'unhealthy',
          health_last_checked_at = CURRENT_TIMESTAMP,
          health_last_error = ?,
          health_fail_count = health_fail_count + 1,
          health_next_check_at = datetime('now', '+' || ? || ' minutes'),
          cooldown_until = datetime('now', '+' || ? || ' minutes'),
          is_active = CASE WHEN is_active = 1 OR health_auto_disabled = 1 THEN 0 ELSE is_active END,
          health_auto_disabled = CASE WHEN is_active = 1 OR health_auto_disabled = 1 THEN 1 ELSE health_auto_disabled END
      WHERE id = ?
    `).run(message || '健康检查失败', normalizedCooldownMinutes, normalizedCooldownMinutes, id);
  }

  static updateQuota(id, quota) {
    db.prepare(`
      UPDATE tokens
      SET quota_total = ?,
          quota_used = ?,
          quota_remaining = ?,
          last_quota_check = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      quota.total || 0,
      quota.used || 0,
      quota.remaining || 0,
      id
    );
  }
}

export class ApiLog {
  static create(data) {
    db.prepare(`
      INSERT INTO api_logs (api_key_id, token_id, model, endpoint, status_code, response_time_ms, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.api_key_id || null,
      data.token_id || null,
      data.model || null,
      data.endpoint || null,
      data.status_code || null,
      Number.isFinite(Number.parseInt(data.response_time_ms, 10))
        ? Number.parseInt(data.response_time_ms, 10)
        : null,
      data.error_message || null
    );
  }

  static getRecent(limit = 100) {
    return db.prepare('SELECT * FROM api_logs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  static getWindowSummary(sinceModifier = '-24 hour') {
    return db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END), 0) as success_requests,
        COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) as failed_requests,
        ROUND(COALESCE(AVG(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END), 0), 2) as avg_response_time_ms
      FROM api_logs
      WHERE created_at >= datetime('now', ?)
    `).get(sinceModifier);
  }

  static getLatencySummary(sinceModifier = '-24 hour', sampleLimit = 50000) {
    const normalizedLimit = Math.min(Math.max(Number.parseInt(sampleLimit, 10) || 50000, 1000), 200000);
    const rows = db.prepare(`
      SELECT response_time_ms
      FROM api_logs
      WHERE created_at >= datetime('now', ?)
        AND response_time_ms IS NOT NULL
      ORDER BY response_time_ms ASC
      LIMIT ?
    `).all(sinceModifier, normalizedLimit);

    if (!rows || rows.length === 0) {
      return {
        sample_count: 0,
        min_ms: 0,
        max_ms: 0,
        p50_ms: 0,
        p95_ms: 0
      };
    }

    const values = rows.map((row) => Number.parseInt(row.response_time_ms, 10) || 0);
    const pickPercentile = (percentile) => {
      const idx = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * percentile)));
      return values[idx] || 0;
    };

    return {
      sample_count: values.length,
      min_ms: values[0] || 0,
      max_ms: values[values.length - 1] || 0,
      p50_ms: pickPercentile(0.5),
      p95_ms: pickPercentile(0.95)
    };
  }

  static getDashboardSummary() {
    return db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END), 0) as success_requests,
        COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) as failed_requests,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-1 hour') THEN 1 ELSE 0 END), 0) as requests_last_hour,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', '-24 hour') THEN 1 ELSE 0 END), 0) as requests_last_24h,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', 'start of day') THEN 1 ELSE 0 END), 0) as today_requests,
        ROUND(COALESCE(AVG(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END), 0), 2) as avg_response_time_ms
      FROM api_logs
    `).get();
  }

  static getTopModels(limit = 5, sinceModifier = '-7 day') {
    return db.prepare(`
      SELECT
        model,
        COUNT(*) as request_count
      FROM api_logs
      WHERE created_at >= datetime('now', ?)
        AND model IS NOT NULL
        AND model != ''
      GROUP BY model
      ORDER BY request_count DESC
      LIMIT ?
    `).all(sinceModifier, limit);
  }

  static getTopEndpoints(limit = 5, sinceModifier = '-7 day') {
    return db.prepare(`
      SELECT
        endpoint,
        COUNT(*) as request_count
      FROM api_logs
      WHERE created_at >= datetime('now', ?)
        AND endpoint IS NOT NULL
        AND endpoint != ''
      GROUP BY endpoint
      ORDER BY request_count DESC
      LIMIT ?
    `).all(sinceModifier, limit);
  }

  static getApiKeyUsageSummaries() {
    return db.prepare(`
      WITH stats_24h AS (
        SELECT
          api_key_id,
          COUNT(*) as requests_24h,
          COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END), 0) as success_24h,
          COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) as failed_24h
        FROM api_logs
        WHERE api_key_id IS NOT NULL
          AND created_at >= datetime('now', '-24 hour')
        GROUP BY api_key_id
      ),
      stats_today AS (
        SELECT
          api_key_id,
          COUNT(*) as today_requests
        FROM api_logs
        WHERE api_key_id IS NOT NULL
          AND created_at >= datetime('now', 'start of day')
        GROUP BY api_key_id
      ),
      latest_log AS (
        SELECT
          l.api_key_id,
          l.status_code as last_status_code,
          l.error_message as last_error_message,
          l.created_at as last_request_at
        FROM api_logs l
        INNER JOIN (
          SELECT api_key_id, MAX(id) as max_id
          FROM api_logs
          WHERE api_key_id IS NOT NULL
          GROUP BY api_key_id
        ) t ON t.max_id = l.id
      )
      SELECT
        k.id as api_key_id,
        COALESCE(s24.requests_24h, 0) as requests_24h,
        COALESCE(s24.success_24h, 0) as success_24h,
        COALESCE(s24.failed_24h, 0) as failed_24h,
        COALESCE(st.today_requests, 0) as today_requests,
        ll.last_status_code,
        ll.last_error_message,
        ll.last_request_at
      FROM api_keys k
      LEFT JOIN stats_24h s24 ON s24.api_key_id = k.id
      LEFT JOIN stats_today st ON st.api_key_id = k.id
      LEFT JOIN latest_log ll ON ll.api_key_id = k.id
      ORDER BY k.id ASC
    `).all();
  }

  static getTokenUsageSummaries(sinceModifier = '-7 day') {
    // 这里统一使用 l.token_id，避免与 CTE 字段同名导致 SQL 歧义
    return db.prepare(`
      WITH latest_log AS (
        SELECT
          l.token_id,
          l.status_code as last_status_code,
          l.error_message as last_error_message,
          l.created_at as last_request_at
        FROM api_logs l
        INNER JOIN (
          SELECT token_id, MAX(id) as max_id
          FROM api_logs
          WHERE token_id IS NOT NULL
          GROUP BY token_id
        ) t ON t.max_id = l.id
      )
      SELECT
        l.token_id as token_id,
        COUNT(*) as requests_in_window,
        COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END), 0) as success_in_window,
        COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) as failed_in_window,
        ROUND(COALESCE(AVG(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END), 0), 2) as avg_response_time_ms,
        ll.last_status_code,
        ll.last_error_message,
        ll.last_request_at
      FROM api_logs l
      LEFT JOIN latest_log ll ON ll.token_id = l.token_id
      WHERE l.token_id IS NOT NULL
        AND l.created_at >= datetime('now', ?)
      GROUP BY l.token_id, ll.last_status_code, ll.last_error_message, ll.last_request_at
      ORDER BY requests_in_window DESC
    `).all(sinceModifier);
  }

  static getTrendBuckets(sinceModifier = '-24 hour', granularity = 'hour') {
    if (granularity === 'hour') {
      return db.prepare(`
        SELECT
          strftime('%Y-%m-%d %H:00:00', created_at) as bucket,
          COUNT(*) as request_count,
          COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) as failed_count,
          ROUND(COALESCE(AVG(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END), 0), 2) as avg_response_time_ms
        FROM api_logs
        WHERE created_at >= datetime('now', ?)
        GROUP BY bucket
        ORDER BY bucket ASC
      `).all(sinceModifier);
    }

    return db.prepare(`
      SELECT
        date(created_at) as bucket,
        COUNT(*) as request_count,
        COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) as failed_count,
        ROUND(COALESCE(AVG(CASE WHEN response_time_ms IS NOT NULL THEN response_time_ms END), 0), 2) as avg_response_time_ms
      FROM api_logs
      WHERE created_at >= datetime('now', ?)
      GROUP BY bucket
      ORDER BY bucket ASC
    `).all(sinceModifier);
  }

  static getModelDistribution(sinceModifier = '-7 day', limit = 8) {
    return db.prepare(`
      SELECT
        model,
        COUNT(*) as request_count
      FROM api_logs
      WHERE created_at >= datetime('now', ?)
        AND model IS NOT NULL
        AND model != ''
      GROUP BY model
      ORDER BY request_count DESC
      LIMIT ?
    `).all(sinceModifier, limit);
  }

  static getEndpointDistribution(sinceModifier = '-7 day', limit = 8) {
    return db.prepare(`
      SELECT
        endpoint,
        COUNT(*) as request_count
      FROM api_logs
      WHERE created_at >= datetime('now', ?)
        AND endpoint IS NOT NULL
        AND endpoint != ''
      GROUP BY endpoint
      ORDER BY request_count DESC
      LIMIT ?
    `).all(sinceModifier, limit);
  }

  static getTodayCountByApiKey(apiKeyId) {
    const row = db.prepare(`
      SELECT COUNT(*) as count
      FROM api_logs
      WHERE api_key_id = ?
        AND created_at >= datetime('now', 'start of day')
    `).get(apiKeyId);
    return row?.count || 0;
  }

  static getUsageByApiKey(apiKeyId) {
    return db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END), 0) as success_requests,
        COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) as failed_requests,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now', 'start of day') THEN 1 ELSE 0 END), 0) as today_requests
      FROM api_logs
      WHERE api_key_id = ?
    `).get(apiKeyId);
  }

  static getTopModelsByApiKey(apiKeyId, limit = 10) {
    return db.prepare(`
      SELECT
        model,
        COUNT(*) as request_count
      FROM api_logs
      WHERE api_key_id = ? AND model IS NOT NULL AND model != ''
      GROUP BY model
      ORDER BY request_count DESC
      LIMIT ?
    `).all(apiKeyId, limit);
  }

  static getDailyUsageByApiKey(apiKeyId, days = 7) {
    const normalizedDays = Math.min(Math.max(Number.parseInt(days, 10) || 7, 1), 30);
    const interval = `-${normalizedDays - 1} day`;

    return db.prepare(`
      SELECT
        date(created_at) as date,
        COUNT(*) as total_requests,
        COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END), 0) as success_requests,
        COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) as failed_requests
      FROM api_logs
      WHERE api_key_id = ? AND created_at >= datetime('now', ?)
      GROUP BY date(created_at)
      ORDER BY date ASC
    `).all(apiKeyId, interval);
  }

  static getStats() {
    return {
      total: db.prepare('SELECT COUNT(*) as count FROM api_logs').get().count,
      success: db.prepare('SELECT COUNT(*) as count FROM api_logs WHERE status_code >= 200 AND status_code < 300').get().count,
      error: db.prepare('SELECT COUNT(*) as count FROM api_logs WHERE status_code >= 400').get().count
    };
  }

  static cleanupOlderThanDays(days = 30) {
    const normalizedDays = Math.min(Math.max(Number.parseInt(days, 10) || 30, 1), 3650);
    const modifier = `-${normalizedDays} day`;
    const result = db.prepare(`
      DELETE FROM api_logs
      WHERE created_at < datetime('now', ?)
    `).run(modifier);
    return result?.changes || 0;
  }
}
