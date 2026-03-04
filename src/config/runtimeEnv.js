import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';

const HOT_RELOAD_FLAG_ENV = 'ENV_HOT_RELOAD';

function resolveEnvFilePath() {
  return path.resolve(process.cwd(), process.env.ENV_FILE_PATH || '.env');
}

const runtimeEnvState = {
  envFilePath: null,
  watcher: null,
  debounceTimer: null,
  reloadInProgress: false,
  pendingReload: false,
  managedKeys: new Set(),
  lastLoadedAt: null,
  lastError: null
};

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function isHotReloadEnabled() {
  return parseBoolean(process.env[HOT_RELOAD_FLAG_ENV], true);
}

function applyParsedEnv(parsedEnv = {}) {
  const nextKeys = new Set(Object.keys(parsedEnv));

  for (const key of runtimeEnvState.managedKeys) {
    if (!nextKeys.has(key)) {
      delete process.env[key];
    }
  }

  Object.entries(parsedEnv).forEach(([key, value]) => {
    process.env[key] = String(value);
  });

  runtimeEnvState.managedKeys = nextKeys;
}

export async function reloadRuntimeEnvFromDisk(reason = 'manual') {
  if (!runtimeEnvState.envFilePath) {
    runtimeEnvState.envFilePath = resolveEnvFilePath();
  }

  if (runtimeEnvState.reloadInProgress) {
    runtimeEnvState.pendingReload = true;
    return {
      success: true,
      pending: true,
      reason
    };
  }

  runtimeEnvState.reloadInProgress = true;

  try {
    let raw = '';
    try {
      raw = await fsPromises.readFile(runtimeEnvState.envFilePath, 'utf-8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      raw = '';
    }

    const parsedEnv = dotenv.parse(raw || '');
    applyParsedEnv(parsedEnv);
    runtimeEnvState.lastLoadedAt = new Date().toISOString();
    runtimeEnvState.lastError = null;

    return {
      success: true,
      reason,
      loadedKeys: Object.keys(parsedEnv).length,
      loadedAt: runtimeEnvState.lastLoadedAt
    };
  } catch (error) {
    runtimeEnvState.lastError = error?.message || '未知错误';
    return {
      success: false,
      reason,
      error: runtimeEnvState.lastError
    };
  } finally {
    runtimeEnvState.reloadInProgress = false;
    if (runtimeEnvState.pendingReload) {
      runtimeEnvState.pendingReload = false;
      void reloadRuntimeEnvFromDisk('queued');
    }
  }
}

function scheduleReload(reason = 'watch') {
  if (runtimeEnvState.debounceTimer) {
    clearTimeout(runtimeEnvState.debounceTimer);
  }

  runtimeEnvState.debounceTimer = setTimeout(() => {
    runtimeEnvState.debounceTimer = null;
    void reloadRuntimeEnvFromDisk(reason);
  }, 120);
}

function setupWatcher() {
  if (runtimeEnvState.watcher || !isHotReloadEnabled()) {
    return;
  }

  try {
    runtimeEnvState.watcher = fs.watch(runtimeEnvState.envFilePath, (eventType) => {
      // Windows 下保存文件常见 rename + change 组合事件，这里统一触发热加载
      if (eventType === 'rename') {
        scheduleReload('watch:rename');
        if (runtimeEnvState.watcher) {
          runtimeEnvState.watcher.close();
          runtimeEnvState.watcher = null;
        }
        setTimeout(setupWatcher, 200);
        return;
      }

      if (eventType === 'change') {
        scheduleReload('watch:change');
      }
    });

    runtimeEnvState.watcher.on('error', (error) => {
      runtimeEnvState.lastError = error?.message || 'watcher error';
      if (runtimeEnvState.watcher) {
        runtimeEnvState.watcher.close();
        runtimeEnvState.watcher = null;
      }
      setTimeout(setupWatcher, 500);
    });
  } catch (error) {
    runtimeEnvState.lastError = error?.message || 'watcher init error';
  }
}

export async function initRuntimeEnvHotReload() {
  runtimeEnvState.envFilePath = resolveEnvFilePath();
  await reloadRuntimeEnvFromDisk('startup');
  setupWatcher();
}

export function getRuntimeEnvState() {
  const envFilePath = runtimeEnvState.envFilePath || resolveEnvFilePath();
  return {
    envFilePath,
    hotReloadEnabled: isHotReloadEnabled(),
    lastLoadedAt: runtimeEnvState.lastLoadedAt,
    lastError: runtimeEnvState.lastError,
    managedKeys: Array.from(runtimeEnvState.managedKeys)
  };
}
