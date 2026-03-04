import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_LOCAL_DB_PATH = path.join(__dirname, '../../database/app.db');
const DEFAULT_VERCEL_DB_PATH = '/tmp/gpt2api-node/app.db';

function isVercelRuntime() {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.NOW_REGION);
}

function resolveDatabasePath() {
  const configuredPath = String(process.env.DATABASE_PATH || '').trim();
  if (configuredPath) {
    // 兼容相对路径配置，统一解析到项目启动目录下
    return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(process.cwd(), configuredPath);
  }

  // Vercel Serverless 文件系统只允许写 /tmp，默认切换到可写目录
  if (isVercelRuntime()) {
    return DEFAULT_VERCEL_DB_PATH;
  }

  return DEFAULT_LOCAL_DB_PATH;
}

function ensureDatabaseDirectory(targetPath) {
  const dbDir = path.dirname(targetPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

function applyPragmas(database) {
  // 启用外键约束
  database.pragma('foreign_keys = ON');
  // 优化 SQLite 在高并发读写下的稳定性与吞吐
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('temp_store = MEMORY');
}

function createDatabase(targetPath) {
  ensureDatabaseDirectory(targetPath);
  const instance = new Database(targetPath);
  applyPragmas(instance);
  return instance;
}

function isReadonlySqliteError(error) {
  if (!error) {
    return false;
  }
  if (error.code === 'SQLITE_READONLY') {
    return true;
  }
  return String(error.message || '').toUpperCase().includes('READONLY');
}

let dbPath = resolveDatabasePath();
let db;

try {
  db = createDatabase(dbPath);
} catch (error) {
  // 部分平台会把项目目录挂为只读，此时自动回退到 /tmp 避免服务启动失败
  const shouldFallbackToTmp = isReadonlySqliteError(error) && dbPath !== DEFAULT_VERCEL_DB_PATH;
  if (!shouldFallbackToTmp) {
    throw error;
  }

  dbPath = DEFAULT_VERCEL_DB_PATH;
  console.warn(`⚠ 检测到 SQLite 路径只读，已自动切换到临时目录: ${dbPath}`);
  db = createDatabase(dbPath);
}

// 初始化数据库表
export function initDatabase() {
  // 用户表
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // API Keys 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME,
      usage_count INTEGER DEFAULT 0,
      rpm_limit INTEGER DEFAULT 60,
      daily_limit INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT 1
    )
  `);

  // 为已存在的 api_keys 表添加限流/配额字段（如果不存在）
  try {
    db.exec(`ALTER TABLE api_keys ADD COLUMN rpm_limit INTEGER DEFAULT 60`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE api_keys ADD COLUMN daily_limit INTEGER DEFAULT 0`);
  } catch (e) {
    // 字段已存在，忽略错误
  }

  // Tokens 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT,
      account_id TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      id_token TEXT,
      expired_at DATETIME,
      last_refresh_at DATETIME,
      total_requests INTEGER DEFAULT 0,
      success_requests INTEGER DEFAULT 0,
      failed_requests INTEGER DEFAULT 0,
      consecutive_failures INTEGER DEFAULT 0,
      cooldown_until DATETIME,
      health_status TEXT DEFAULT 'unknown',
      health_last_checked_at DATETIME,
      health_last_success_at DATETIME,
      health_last_error TEXT,
      health_fail_count INTEGER DEFAULT 0,
      health_next_check_at DATETIME,
      health_auto_disabled BOOLEAN DEFAULT 0,
      last_used_at DATETIME,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // 为已存在的 tokens 表添加统计字段（如果不存在）
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN total_requests INTEGER DEFAULT 0`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN success_requests INTEGER DEFAULT 0`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN failed_requests INTEGER DEFAULT 0`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN consecutive_failures INTEGER DEFAULT 0`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN cooldown_until DATETIME`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN last_used_at DATETIME`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN health_status TEXT DEFAULT 'unknown'`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN health_last_checked_at DATETIME`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN health_last_success_at DATETIME`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN health_last_error TEXT`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN health_fail_count INTEGER DEFAULT 0`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN health_next_check_at DATETIME`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN health_auto_disabled BOOLEAN DEFAULT 0`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN quota_total INTEGER DEFAULT 0`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN quota_used INTEGER DEFAULT 0`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN quota_remaining INTEGER DEFAULT 0`);
  } catch (e) {
    // 字段已存在，忽略错误
  }
  try {
    db.exec(`ALTER TABLE tokens ADD COLUMN last_quota_check DATETIME`);
  } catch (e) {
    // 字段已存在，忽略错误
  }

  // API 日志表
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER,
      token_id INTEGER,
      model TEXT,
      endpoint TEXT,
      status_code INTEGER,
      response_time_ms INTEGER,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id),
      FOREIGN KEY (token_id) REFERENCES tokens(id)
    )
  `);

  // 为已存在的 api_logs 表补充响应时间字段（若不存在）
  try {
    db.exec(`ALTER TABLE api_logs ADD COLUMN response_time_ms INTEGER`);
  } catch (e) {
    // 字段已存在，忽略错误
  }

  // 关键查询索引，提升日志统计与鉴权查询性能
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_api_logs_api_key_created_at
    ON api_logs(api_key_id, created_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_api_logs_model
    ON api_logs(model)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_api_logs_created_at
    ON api_logs(created_at)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_api_logs_endpoint
    ON api_logs(endpoint)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tokens_active
    ON tokens(is_active)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_api_keys_active
    ON api_keys(is_active)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tokens_cooldown_until
    ON tokens(cooldown_until)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tokens_health_next_check_at
    ON tokens(health_next_check_at)
  `);

  console.log('✓ 数据库表初始化完成');
}

export default db;
