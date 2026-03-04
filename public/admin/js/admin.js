const UI_STATE_STORAGE_KEY = 'gpt2api_admin_ui_state_v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const FILTER_INPUT_DEBOUNCE_MS = 450;
const AVAILABLE_PAGES = new Set(['dashboard', 'apikeys', 'accounts', 'analytics', 'settings']);
const AVAILABLE_TIME_RANGES = new Set(['24h', '7d', '30d']);
const MODAL_IDS = ['createApiKeyModal', 'createTokenModal', 'importTokenModal', 'changePasswordModal'];

const state = {
  currentPage: 'dashboard',
  currentTokenPage: 1,
  tokenPageSize: 20,
  totalTokens: 0,
  autoRefreshEnabled: false,
  isRefreshing: false,
  pendingRefresh: false,
  isRedirectingToLogin: false,
  selectedApiKeys: new Set(),
  selectedTokens: new Set(),
  importData: null,
  currentTimeRange: '24h',
  autoRefreshTimer: null,
  requestTrendChart: null,
  modelDistributionChart: null,
  endpointDistributionChart: null,
  envFileWritable: true,
  apiKeyFilters: {
    keyword: '',
    status: 'all',
    sort: 'traffic_desc'
  },
  tokenFilters: {
    keyword: '',
    status: 'all'
  },
  logFilters: {
    keyword: '',
    status: 'all'
  },
  latestLogs: []
};

function normalizeFilterState(source, defaults) {
  const next = { ...defaults };
  if (!source || typeof source !== 'object') {
    return next;
  }
  if (typeof source.keyword === 'string') {
    next.keyword = source.keyword;
  }
  if (typeof source.status === 'string') {
    next.status = source.status;
  }
  if (typeof source.sort === 'string') {
    next.sort = source.sort;
  }
  return next;
}

function saveUiState() {
  try {
    const payload = {
      currentPage: state.currentPage,
      currentTimeRange: state.currentTimeRange,
      autoRefreshEnabled: state.autoRefreshEnabled,
      apiKeyFilters: state.apiKeyFilters,
      tokenFilters: state.tokenFilters,
      logFilters: state.logFilters
    };
    localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('保存页面状态失败:', error);
  }
}

function loadUiState() {
  try {
    const raw = localStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    if (typeof parsed.currentPage === 'string' && AVAILABLE_PAGES.has(parsed.currentPage)) {
      state.currentPage = parsed.currentPage;
    }
    if (typeof parsed.currentTimeRange === 'string' && AVAILABLE_TIME_RANGES.has(parsed.currentTimeRange)) {
      state.currentTimeRange = parsed.currentTimeRange;
    }
    state.autoRefreshEnabled = parsed.autoRefreshEnabled === true;
    state.apiKeyFilters = normalizeFilterState(parsed.apiKeyFilters, state.apiKeyFilters);
    state.tokenFilters = normalizeFilterState(parsed.tokenFilters, state.tokenFilters);
    state.logFilters = normalizeFilterState(parsed.logFilters, state.logFilters);
  } catch (error) {
    console.warn('读取页面状态失败:', error);
  }
}

function scheduleDebouncedTask(key, task, delay = FILTER_INPUT_DEBOUNCE_MS) {
  const prev = state[`${key}DebounceTimer`];
  if (prev) {
    clearTimeout(prev);
  }
  state[`${key}DebounceTimer`] = setTimeout(() => {
    state[`${key}DebounceTimer`] = null;
    task();
  }, delay);
}

function hydrateFilterInputsFromState() {
  const apiKeyKeyword = document.getElementById('apiKeyKeywordFilter');
  const apiKeyStatus = document.getElementById('apiKeyStatusFilter');
  const apiKeySort = document.getElementById('apiKeySortFilter');
  const tokenKeyword = document.getElementById('tokenKeywordFilter');
  const tokenStatus = document.getElementById('tokenStatusFilter');
  const logKeyword = document.getElementById('logsKeywordFilter');
  const logStatus = document.getElementById('logsStatusFilter');

  if (apiKeyKeyword) apiKeyKeyword.value = state.apiKeyFilters.keyword;
  if (apiKeyStatus) apiKeyStatus.value = state.apiKeyFilters.status;
  if (apiKeySort) apiKeySort.value = state.apiKeyFilters.sort;
  if (tokenKeyword) tokenKeyword.value = state.tokenFilters.keyword;
  if (tokenStatus) tokenStatus.value = state.tokenFilters.status;
  if (logKeyword) logKeyword.value = state.logFilters.keyword;
  if (logStatus) logStatus.value = state.logFilters.status;
}

function setGlobalLoading(active) {
  const loadingBar = document.getElementById('globalLoadingBar');
  if (!loadingBar) {
    return;
  }
  loadingBar.classList.toggle('opacity-0', !active);
}

function setManualRefreshButtonLoading(active) {
  const btn = document.getElementById('manualRefreshBtn');
  if (!btn) {
    return;
  }

  btn.disabled = active;
  btn.classList.toggle('opacity-70', active);
  btn.classList.toggle('cursor-not-allowed', active);
  btn.innerHTML = active
    ? '<i class="fas fa-spinner fa-spin mr-2"></i>刷新中'
    : '<i class="fas fa-rotate mr-2"></i>刷新';
}

function redirectToLogin(message = '登录状态已过期，请重新登录') {
  if (state.isRedirectingToLogin) {
    return;
  }
  state.isRedirectingToLogin = true;
  showToast(message, 'warning');
  setTimeout(() => {
    window.location.href = '/admin/login.html';
  }, 300);
}

function bindInputActions(inputId, onApply) {
  const el = document.getElementById(inputId);
  if (!el) {
    return;
  }

  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onApply();
    }
  });

  el.addEventListener('input', () => {
    scheduleDebouncedTask(`debounce_${inputId}`, () => onApply());
  });
}

function bindSelectActions(selectId, onApply) {
  const el = document.getElementById(selectId);
  if (!el) {
    return;
  }
  el.addEventListener('change', () => onApply());
}

function bindFilterActions() {
  bindInputActions('apiKeyKeywordFilter', applyApiKeyFilters);
  bindInputActions('tokenKeywordFilter', applyTokenFilters);
  bindInputActions('logsKeywordFilter', applyLogFilters);
  bindSelectActions('apiKeyStatusFilter', applyApiKeyFilters);
  bindSelectActions('apiKeySortFilter', applyApiKeyFilters);
  bindSelectActions('tokenStatusFilter', applyTokenFilters);
  bindSelectActions('logsStatusFilter', applyLogFilters);
}

function setActiveTimeRangeButton(range) {
  document.querySelectorAll('.time-range-btn').forEach((btn) => {
    const isActive = btn.dataset.range === range;
    btn.classList.toggle('bg-blue-500', isActive);
    btn.classList.toggle('text-white', isActive);
    btn.classList.toggle('text-gray-700', !isActive);
    btn.classList.toggle('hover:bg-gray-100', !isActive);
  });
}

function closeModalById(id) {
  switch (id) {
    case 'createApiKeyModal':
      closeCreateApiKeyModal();
      break;
    case 'createTokenModal':
      closeCreateTokenModal();
      break;
    case 'importTokenModal':
      closeImportModal();
      break;
    case 'changePasswordModal':
      closeChangePasswordModal();
      break;
    default: {
      const modal = document.getElementById(id);
      if (modal) modal.classList.add('hidden');
    }
  }
}

function bindModalInteractions() {
  MODAL_IDS.forEach((id) => {
    const modal = document.getElementById(id);
    if (!modal) {
      return;
    }
    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeModalById(id);
      }
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }

    const openedModalId = MODAL_IDS.find((id) => {
      const modal = document.getElementById(id);
      return modal && !modal.classList.contains('hidden');
    });

    if (openedModalId) {
      closeModalById(openedModalId);
    }
  });
}

function getNavItemByPage(page) {
  return document.querySelector(`.nav-item[data-page="${page}"]`);
}

document.addEventListener('DOMContentLoaded', async () => {
  loadUiState();
  hydrateFilterInputsFromState();
  setActiveTimeRangeButton(state.currentTimeRange);
  bindAutoRefreshToggle();
  bindFilterActions();
  bindModalInteractions();
  await checkAuth();

  const autoRefreshToggle = document.getElementById('autoRefreshToggle');
  if (autoRefreshToggle) {
    autoRefreshToggle.checked = state.autoRefreshEnabled;
  }
  setAutoRefresh(state.autoRefreshEnabled, true);

  if (state.currentPage !== 'dashboard') {
    const navItem = getNavItemByPage(state.currentPage);
    if (navItem) {
      switchPage({
        preventDefault() {},
        currentTarget: navItem
      }, state.currentPage);
      return;
    }
  }

  await refreshCurrentPageData();
});

async function apiRequest(url, options = {}) {
  const {
    throwOnError = true,
    allowUnauthorized = false,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ...fetchOptions
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`请求超时（>${timeoutMs}ms）`));
  }, timeoutMs);

  if (fetchOptions.signal) {
    fetchOptions.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  fetchOptions.signal = controller.signal;
  if (!fetchOptions.credentials) {
    fetchOptions.credentials = 'same-origin';
  }

  let response;
  let text = '';
  let data = null;
  try {
    response = await fetch(url, fetchOptions);
    text = await response.text();
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? `请求超时或已取消（${url}）`
      : (error?.message || '网络请求失败');
    const wrappedError = new Error(message);
    wrappedError.status = 0;
    throw wrappedError;
  } finally {
    clearTimeout(timer);
  }

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (response.status === 401 && !allowUnauthorized) {
    redirectToLogin('登录已过期，请重新登录');
  }

  if (!response.ok && throwOnError) {
    const message =
      data?.error?.message ||
      data?.error ||
      data?.message ||
      `请求失败（HTTP ${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = data;
    throw error;
  }

  return { response, data, text };
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const colorMap = {
    info: 'bg-blue-500',
    success: 'bg-green-500',
    error: 'bg-red-500',
    warning: 'bg-amber-500'
  };

  const toast = document.createElement('div');
  toast.className = `${colorMap[type] || colorMap.info} text-white px-4 py-3 rounded-lg shadow-lg text-sm max-w-md`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 2800);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN');
}

function getTimeAgo(timestamp) {
  if (!timestamp) return '未知';
  const now = Date.now();
  const target = new Date(timestamp).getTime();
  if (Number.isNaN(target)) return '未知';

  const diff = Math.floor((now - target) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

function formatUptime(seconds) {
  const value = Number.parseInt(seconds, 10) || 0;
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (days > 0) return `${days}天 ${hours}小时 ${minutes}分钟`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  return `${minutes}分钟`;
}

function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function applyEnvWritableState(envFileWritable) {
  const writable = envFileWritable !== false;
  state.envFileWritable = writable;

  const strategySelect = document.getElementById('loadBalanceStrategy');
  const runtimeForm = document.getElementById('runtimeSettingsForm');
  const runtimeSubmit = runtimeForm?.querySelector('button[type="submit"]');
  const accountNotice = document.getElementById('envWriteNoticeAccounts');
  const settingsNotice = document.getElementById('envWriteNoticeSettings');

  if (strategySelect) {
    strategySelect.disabled = !writable;
    strategySelect.classList.toggle('opacity-60', !writable);
    strategySelect.classList.toggle('cursor-not-allowed', !writable);
    strategySelect.title = writable ? '' : '已禁用在线写入 .env';
  }

  if (runtimeSubmit) {
    runtimeSubmit.disabled = !writable;
    runtimeSubmit.classList.toggle('opacity-60', !writable);
    runtimeSubmit.classList.toggle('cursor-not-allowed', !writable);
    runtimeSubmit.classList.toggle('hover:bg-blue-600', writable);
  }

  if (runtimeForm) {
    runtimeForm.querySelectorAll('input, select, textarea').forEach((field) => {
      if (field.id === 'settingTokenCircuitBreakerThreshold') {
        return;
      }
      field.disabled = !writable;
      field.classList.toggle('opacity-70', !writable);
    });
  }

  if (accountNotice) {
    accountNotice.classList.toggle('hidden', writable);
  }
  if (settingsNotice) {
    settingsNotice.classList.toggle('hidden', writable);
  }
}

function bindAutoRefreshToggle() {
  const toggle = document.getElementById('autoRefreshToggle');
  if (!toggle) return;

  toggle.addEventListener('change', () => {
    setAutoRefresh(toggle.checked);
  });
}

function setAutoRefresh(enabled, silent = false) {
  state.autoRefreshEnabled = enabled === true;
  if (state.autoRefreshTimer) {
    clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }

  if (state.autoRefreshEnabled) {
    state.autoRefreshTimer = setInterval(() => {
      refreshCurrentPageData().catch((error) => {
        console.error('自动刷新失败:', error);
      });
    }, 15000);
    if (!silent) {
      showToast('已开启自动刷新（15秒）', 'info');
    }
  } else if (!silent) {
    showToast('已关闭自动刷新', 'info');
  }

  saveUiState();
}

async function checkAuth() {
  try {
    const { response } = await apiRequest('/admin/auth/check', {
      throwOnError: false,
      allowUnauthorized: true,
      timeoutMs: 8000
    });
    if (!response.ok) {
      window.location.href = '/admin/login.html';
    }
  } catch (error) {
    console.error('认证检查失败:', error);
    window.location.href = '/admin/login.html';
  }
}

async function refreshCurrentPageData() {
  if (state.isRefreshing) {
    state.pendingRefresh = true;
    return;
  }

  state.isRefreshing = true;
  setGlobalLoading(true);
  setManualRefreshButtonLoading(true);

  try {
    if (state.currentPage === 'dashboard') {
      await Promise.all([loadStats(), loadRecentActivity(), loadSystemHealth()]);
      return;
    }

    if (state.currentPage === 'apikeys') {
      await loadApiKeys();
      return;
    }

    if (state.currentPage === 'accounts') {
      await Promise.all([
        loadTokens(state.currentTokenPage),
        loadLoadBalanceStrategy(),
        loadStats(),
        loadSystemHealth()
      ]);
      return;
    }

    if (state.currentPage === 'analytics') {
      await loadAnalytics();
      return;
    }

    if (state.currentPage === 'settings') {
      await Promise.all([loadRuntimeSettings(), loadSystemHealth(true)]);
    }
  } catch (error) {
    console.error('刷新失败:', error);
    showToast(error.message || '刷新失败', 'error');
  } finally {
    state.isRefreshing = false;
    setGlobalLoading(false);
    setManualRefreshButtonLoading(false);

    if (state.pendingRefresh) {
      state.pendingRefresh = false;
      refreshCurrentPageData().catch((error) => {
        console.error('刷新补偿执行失败:', error);
      });
    }
  }
}

function switchPage(event, page) {
  event.preventDefault();
  state.currentPage = page;

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.remove('active', 'text-white');
    item.classList.add('text-gray-700');
  });

  const targetNav = event.currentTarget || getNavItemByPage(page);
  if (targetNav) {
    targetNav.classList.add('active');
    targetNav.classList.remove('text-gray-700');
  }

  ['dashboardPage', 'apikeysPage', 'accountsPage', 'analyticsPage', 'settingsPage'].forEach((id) => {
    document.getElementById(id).classList.add('hidden');
  });

  const titles = {
    dashboard: { title: '仪表盘', desc: '系统概览和实时数据' },
    apikeys: { title: 'API Keys', desc: 'API 密钥管理与限流配置' },
    accounts: { title: '账号管理', desc: 'Token 账户、熔断状态和配额' },
    analytics: { title: '数据分析', desc: 'API 请求统计和趋势分析' },
    settings: { title: '系统设置', desc: '运行参数与安全配置' }
  };

  document.getElementById('pageTitle').textContent = titles[page].title;
  document.getElementById('pageDesc').textContent = titles[page].desc;
  document.getElementById(`${page}Page`).classList.remove('hidden');

  saveUiState();
  refreshCurrentPageData();
}

async function loadStats() {
  const { data } = await apiRequest('/admin/stats');
  document.getElementById('apiKeysCount').textContent = data?.apiKeys || 0;
  document.getElementById('tokensCount').textContent = data?.tokens || 0;
  document.getElementById('todayRequests').textContent = data?.todayRequests || 0;
  document.getElementById('successRate').textContent = `${data?.successRate ?? 100}%`;

  const dashActiveApiKeys = document.getElementById('dashActiveApiKeys');
  const dashDisabledApiKeys = document.getElementById('dashDisabledApiKeys');
  const dashTotalTokens = document.getElementById('dashTotalTokens');
  const dashCoolingTokens = document.getElementById('dashCoolingTokens');
  const dashRequestsLastHour = document.getElementById('dashRequestsLastHour');
  const dashSuccessRate24h = document.getElementById('dashSuccessRate24h');

  if (dashActiveApiKeys) dashActiveApiKeys.textContent = data?.apiKeys || 0;
  if (dashDisabledApiKeys) dashDisabledApiKeys.textContent = data?.apiKeysDisabled || 0;
  if (dashTotalTokens) dashTotalTokens.textContent = data?.tokensTotal || 0;
  if (dashCoolingTokens) dashCoolingTokens.textContent = data?.coolingTokens || 0;
  if (dashRequestsLastHour) dashRequestsLastHour.textContent = data?.requestsLastHour || 0;
  if (dashSuccessRate24h) dashSuccessRate24h.textContent = `${data?.successRate24h ?? 100}%`;

  const dashRequests24h = document.getElementById('dashRequests24h');
  const dashAvgLatency = document.getElementById('dashAvgLatency');
  const dashFailedRequests = document.getElementById('dashFailedRequests');
  const dashTokenConsumed = document.getElementById('dashTokenConsumed');
  const dashHealthyTokens = document.getElementById('dashHealthyTokens');
  const dashUnhealthyTokens = document.getElementById('dashUnhealthyTokens');
  const dashAutoDisabledTokens = document.getElementById('dashAutoDisabledTokens');
  if (dashRequests24h) dashRequests24h.textContent = data?.requests24h || 0;
  if (dashAvgLatency) dashAvgLatency.textContent = `${Math.round(data?.avgResponseTimeMs || 0)}ms`;
  if (dashFailedRequests) dashFailedRequests.textContent = data?.failedRequests || 0;
  if (dashTokenConsumed) dashTokenConsumed.textContent = Number(data?.tokenEstimatedConsumed || 0).toLocaleString('zh-CN');
  if (dashHealthyTokens) dashHealthyTokens.textContent = data?.tokenHealth?.healthy || 0;
  if (dashUnhealthyTokens) dashUnhealthyTokens.textContent = data?.tokenHealth?.unhealthy || 0;
  if (dashAutoDisabledTokens) dashAutoDisabledTokens.textContent = data?.tokenHealth?.autoDisabled || 0;

  const renderTopList = (targetId, items, fallbackLabel) => {
    const container = document.getElementById(targetId);
    if (!container) return;
    if (!Array.isArray(items) || items.length === 0) {
      container.innerHTML = '<li class="py-2 text-sm text-gray-500">暂无数据</li>';
      return;
    }
    container.innerHTML = items.map((item, index) => `
      <li class="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
        <span class="text-sm text-gray-700 truncate max-w-xs" title="${escapeHtml(item?.label || fallbackLabel)}">${index + 1}. ${escapeHtml(item?.label || fallbackLabel)}</span>
        <span class="text-sm font-semibold text-gray-900">${item?.count || 0}</span>
      </li>
    `).join('');
  };

  const topModelItems = (data?.topModels || []).map((item) => ({
    label: item?.model || 'unknown',
    count: Number.parseInt(item?.request_count, 10) || 0
  }));
  const topEndpointItems = (data?.topEndpoints || []).map((item) => ({
    label: item?.endpoint || '/',
    count: Number.parseInt(item?.request_count, 10) || 0
  }));
  const riskyApiKeyItems = (data?.riskyApiKeys || []).map((item) => ({
    label: `${item?.name || 'Key'}（${item?.successRate24h ?? 100}%）`,
    count: Number.parseInt(item?.failed24h, 10) || 0
  }));

  renderTopList('dashTopModels', topModelItems, 'unknown');
  renderTopList('dashTopEndpoints', topEndpointItems, '/');
  renderTopList('dashRiskApiKeys', riskyApiKeyItems, '无');
}

async function loadRecentActivity() {
  const { data } = await apiRequest('/admin/stats/recent-activity?limit=10');
  const activities = Array.isArray(data) ? data : [];
  const container = document.getElementById('recentActivity');

  if (activities.length === 0) {
    container.innerHTML = '<div class="text-center py-8 text-gray-500"><i class="fas fa-info-circle mr-2"></i>暂无活动记录</div>';
    return;
  }

  container.innerHTML = activities.map((activity) => `
    <div class="flex items-start space-x-3 py-3 border-b border-gray-100 last:border-0">
      <div class="flex-shrink-0">
        <div class="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
          <i class="fas ${activity.icon} ${activity.color} text-sm"></i>
        </div>
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-gray-900">${escapeHtml(activity.title)}</p>
        <p class="text-xs text-gray-500 mt-0.5">${escapeHtml(activity.description)}</p>
      </div>
      <div class="flex-shrink-0">
        <span class="text-xs text-gray-400">${getTimeAgo(activity.time)}</span>
      </div>
    </div>
  `).join('');
}

async function loadSystemHealth(isSettingsOnly = false) {
  const { response, data } = await apiRequest('/v1/health', { throwOnError: false });
  if (!data) {
    if (!isSettingsOnly) {
      document.getElementById('runtimeStatus').textContent = '离线';
    }
    return;
  }

  const statusText = data.status === 'ok' ? '正常' : data.status === 'degraded' ? '降级' : '异常';
  const tokenText = `${data.tokens?.active ?? 0}/${data.tokens?.cooling ?? 0}/${data.tokens?.total ?? 0}`;
  const tokenHealthText = `${data.tokens?.healthy ?? 0}/${data.tokens?.unhealthy ?? 0}/${data.tokens?.auto_disabled ?? 0}`;
  const proxyText = `${data.proxy?.in_flight ?? 0}/${data.proxy?.max_concurrent ?? 0}`;
  const healthCheckEnabled = data.token_health_check?.config?.enabled !== false;
  const healthSummary = data.token_health_check?.lastRunSummary
    ? `最近巡检: ${data.token_health_check.lastRunSummary.successCount || 0}/${data.token_health_check.lastRunSummary.checked || 0}`
    : '最近巡检: 暂无';

  const runtimeStatus = document.getElementById('runtimeStatus');
  const runtimeTokens = document.getElementById('runtimeTokens');
  const runtimeProxy = document.getElementById('runtimeProxy');
  const runtimeUptime = document.getElementById('runtimeUptime');
  const runtimeStrategy = document.getElementById('runtimeStrategy');
  const runtimeUpdatedAt = document.getElementById('runtimeUpdatedAt');

  if (runtimeStatus) runtimeStatus.textContent = `${statusText}（HTTP ${response.status}）`;
  if (runtimeTokens) runtimeTokens.textContent = `活跃/冷却/总数：${tokenText} | 健康/异常/自动封停：${tokenHealthText}`;
  if (runtimeProxy) runtimeProxy.textContent = `当前/上限：${proxyText}`;
  if (runtimeUptime) runtimeUptime.textContent = formatUptime(data.uptime_seconds);
  if (runtimeStrategy) runtimeStrategy.textContent = `${data.load_balance_strategy || '-'} | 巡检:${healthCheckEnabled ? '开启' : '关闭'} | ${healthSummary}`;
  if (runtimeUpdatedAt) runtimeUpdatedAt.textContent = formatDateTime(data.timestamp);

  const settingsRuntimeStatus = document.getElementById('settingsRuntimeStatus');
  const settingsRuntimeTokens = document.getElementById('settingsRuntimeTokens');
  const settingsRuntimeProxy = document.getElementById('settingsRuntimeProxy');
  if (settingsRuntimeStatus) settingsRuntimeStatus.textContent = `${statusText}（HTTP ${response.status}）`;
  if (settingsRuntimeTokens) settingsRuntimeTokens.textContent = `${tokenText} | ${tokenHealthText}`;
  if (settingsRuntimeProxy) settingsRuntimeProxy.textContent = proxyText;
}

async function loadApiKeys() {
  const { data } = await apiRequest('/admin/api-keys');
  const allKeys = Array.isArray(data) ? data : [];
  const tbody = document.getElementById('apiKeysTable');
  const keyword = state.apiKeyFilters.keyword.trim().toLowerCase();
  const status = state.apiKeyFilters.status;
  const sortBy = state.apiKeyFilters.sort || 'traffic_desc';

  state.selectedApiKeys.clear();
  updateApiKeyBatchButtons();

  const list = allKeys.filter((key) => {
    if (status === 'active' && !key.is_active) {
      return false;
    }
    if (status === 'disabled' && key.is_active) {
      return false;
    }
    if (status === 'risk' && !key.is_risky) {
      return false;
    }

    if (!keyword) {
      return true;
    }

    const text = [
      key.name,
      key.key
    ].map((item) => String(item || '').toLowerCase()).join(' ');
    return text.includes(keyword);
  }).sort((a, b) => {
    const aReq24h = Number.parseInt(a.requests_24h, 10) || 0;
    const bReq24h = Number.parseInt(b.requests_24h, 10) || 0;
    const aToday = Number.parseInt(a.today_requests, 10) || 0;
    const bToday = Number.parseInt(b.today_requests, 10) || 0;
    const aSuccess = Number.parseInt(a.success_rate_24h, 10);
    const bSuccess = Number.parseInt(b.success_rate_24h, 10);
    const aRisk = Number.parseInt(a.risk_score, 10) || 0;
    const bRisk = Number.parseInt(b.risk_score, 10) || 0;
    const aRemaining = Number.isFinite(Number.parseInt(a.daily_remaining, 10)) ? Number.parseInt(a.daily_remaining, 10) : Number.MAX_SAFE_INTEGER;
    const bRemaining = Number.isFinite(Number.parseInt(b.daily_remaining, 10)) ? Number.parseInt(b.daily_remaining, 10) : Number.MAX_SAFE_INTEGER;

    if (sortBy === 'risk_desc') {
      if (bRisk !== aRisk) return bRisk - aRisk;
      return bReq24h - aReq24h;
    }
    if (sortBy === 'success_asc') {
      if ((aSuccess || 100) !== (bSuccess || 100)) return (aSuccess || 100) - (bSuccess || 100);
      return bReq24h - aReq24h;
    }
    if (sortBy === 'remaining_asc') {
      if (aRemaining !== bRemaining) return aRemaining - bRemaining;
      return bReq24h - aReq24h;
    }

    if (bReq24h !== aReq24h) {
      return bReq24h - aReq24h;
    }
    return bToday - aToday;
  });

  if (list.length === 0) {
    const selectAll = document.getElementById('selectAllApiKeys');
    if (selectAll) selectAll.checked = false;
    tbody.innerHTML = '<tr><td colspan="14" class="text-center py-8 text-gray-500">暂无符合条件的 API Key</td></tr>';
    return;
  }

  tbody.innerHTML = list.map((key) => {
    const encodedKey = encodeURIComponent(key.key || '');
    const rpmLimit = Number.parseInt(key.rpm_limit, 10);
    const dailyLimit = Number.parseInt(key.daily_limit, 10);
    const todayRequests = Number.parseInt(key.today_requests, 10) || 0;
    const requests24h = Number.parseInt(key.requests_24h, 10) || 0;
    const successRate24h = Number.parseInt(key.success_rate_24h, 10);
    const hasDailyLimit = Number.isFinite(dailyLimit) && dailyLimit > 0;
    const dailyRemaining = key.daily_remaining === null || key.daily_remaining === undefined
      ? null
      : Number.parseInt(key.daily_remaining, 10);
    const lastStatusCode = Number.parseInt(key.last_status_code, 10);
    const riskScore = Number.parseInt(key.risk_score, 10) || 0;

    let lastStatusBadge = '<span class="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-700">暂无</span>';
    if (Number.isFinite(lastStatusCode)) {
      if (lastStatusCode >= 200 && lastStatusCode < 400) {
        lastStatusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs bg-green-100 text-green-800">${lastStatusCode}</span>`;
      } else {
        lastStatusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs bg-red-100 text-red-800" title="${escapeHtml(key.last_error_message || '')}">${lastStatusCode}</span>`;
      }
    }

    return `
      <tr class="border-b border-gray-100 hover:bg-gray-50">
        <td class="py-4 px-4">
          <input type="checkbox" class="api-key-checkbox rounded border-gray-300 text-blue-600 focus:ring-blue-500" value="${key.id}" onchange="toggleApiKeySelection(${key.id})" />
        </td>
        <td class="py-4 px-4 text-sm text-gray-900">${escapeHtml(key.name || '-')}</td>
        <td class="py-4 px-4">
          <code class="text-xs bg-gray-100 px-2 py-1 rounded">${escapeHtml((key.key || '').substring(0, 20))}...</code>
          <button onclick="copyToClipboard(decodeURIComponent('${encodedKey}'))" class="ml-2 text-gray-400 hover:text-gray-600">
            <i class="fas fa-copy"></i>
          </button>
        </td>
        <td class="py-4 px-4 text-sm text-gray-600">${key.usage_count || 0}</td>
        <td class="py-4 px-4 text-sm text-gray-600">${todayRequests}</td>
        <td class="py-4 px-4 text-sm text-gray-600">${requests24h}</td>
        <td class="py-4 px-4 text-sm">
          <span class="font-medium ${successRate24h >= 95 ? 'text-green-600' : successRate24h >= 80 ? 'text-amber-600' : 'text-red-600'}">
            ${Number.isFinite(successRate24h) ? `${successRate24h}%` : '-'}
          </span>
        </td>
        <td class="py-4 px-4">
          <input id="rpmLimit-${key.id}" type="number" min="0" value="${Number.isFinite(rpmLimit) ? rpmLimit : 60}" class="w-24 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </td>
        <td class="py-4 px-4">
          <input id="dailyLimit-${key.id}" type="number" min="0" value="${Number.isFinite(dailyLimit) ? dailyLimit : 0}" class="w-24 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </td>
        <td class="py-4 px-4 text-sm text-gray-600">${hasDailyLimit ? (Number.isFinite(dailyRemaining) ? dailyRemaining : 0) : '-'}</td>
        <td class="py-4 px-4">${lastStatusBadge}</td>
        <td class="py-4 px-4 text-sm text-gray-600">${formatDateTime(key.last_request_at || key.last_used_at)}</td>
        <td class="py-4 px-4">
          ${riskScore > 0
            ? `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs ${riskScore >= 3 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'} mr-1" title="${escapeHtml(key.risk_reason || '')}">风险 ${riskScore}</span>`
            : ''}
          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${key.is_active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
            ${key.is_active ? '启用' : '禁用'}
          </span>
        </td>
        <td class="py-4 px-4 whitespace-nowrap">
          <button onclick="saveApiKeyLimits(${key.id})" class="text-sm text-blue-600 hover:text-blue-800 mr-2">保存</button>
          <button onclick="toggleApiKey(${key.id}, ${Boolean(key.is_active)})" class="text-sm text-gray-600 hover:text-gray-900 mr-2">
            ${key.is_active ? '禁用' : '启用'}
          </button>
          <button onclick="deleteApiKey(${key.id})" class="text-sm text-red-600 hover:text-red-800">删除</button>
        </td>
      </tr>
    `;
  }).join('');

  updateSelectAllApiKeyCheckbox();
}

function applyApiKeyFilters() {
  state.apiKeyFilters.keyword = String(document.getElementById('apiKeyKeywordFilter')?.value || '').trim();
  state.apiKeyFilters.status = document.getElementById('apiKeyStatusFilter')?.value || 'all';
  state.apiKeyFilters.sort = document.getElementById('apiKeySortFilter')?.value || 'traffic_desc';
  saveUiState();
  loadApiKeys().catch((error) => {
    showToast(`筛选失败：${error.message}`, 'error');
  });
}

function resetApiKeyFilters() {
  state.apiKeyFilters.keyword = '';
  state.apiKeyFilters.status = 'all';
  state.apiKeyFilters.sort = 'traffic_desc';

  const keywordInput = document.getElementById('apiKeyKeywordFilter');
  const statusSelect = document.getElementById('apiKeyStatusFilter');
  const sortSelect = document.getElementById('apiKeySortFilter');
  if (keywordInput) keywordInput.value = '';
  if (statusSelect) statusSelect.value = 'all';
  if (sortSelect) sortSelect.value = 'traffic_desc';

  saveUiState();
  loadApiKeys().catch((error) => {
    showToast(`重置筛选失败：${error.message}`, 'error');
  });
}

function toggleApiKeySelection(id) {
  if (state.selectedApiKeys.has(id)) {
    state.selectedApiKeys.delete(id);
  } else {
    state.selectedApiKeys.add(id);
  }
  updateApiKeyBatchButtons();
  updateSelectAllApiKeyCheckbox();
}

function toggleSelectAllApiKeys() {
  const checkbox = document.getElementById('selectAllApiKeys');
  const checkboxes = document.querySelectorAll('.api-key-checkbox');

  if (!checkbox) return;

  if (checkbox.checked) {
    checkboxes.forEach((cb) => {
      const id = Number.parseInt(cb.value, 10);
      state.selectedApiKeys.add(id);
      cb.checked = true;
    });
  } else {
    state.selectedApiKeys.clear();
    checkboxes.forEach((cb) => {
      cb.checked = false;
    });
  }

  updateApiKeyBatchButtons();
}

function updateSelectAllApiKeyCheckbox() {
  const checkbox = document.getElementById('selectAllApiKeys');
  const checkboxes = document.querySelectorAll('.api-key-checkbox');
  if (!checkbox || checkboxes.length === 0) {
    if (checkbox) checkbox.checked = false;
    return;
  }
  checkbox.checked = Array.from(checkboxes).every((cb) => cb.checked);
}

function updateApiKeyBatchButtons() {
  const enableBtn = document.getElementById('batchEnableApiKeyBtn');
  const disableBtn = document.getElementById('batchDisableApiKeyBtn');
  const deleteBtn = document.getElementById('batchDeleteApiKeyBtn');
  const hasSelected = state.selectedApiKeys.size > 0;

  [enableBtn, disableBtn, deleteBtn].forEach((btn) => {
    if (!btn) return;
    btn.classList.toggle('hidden', !hasSelected);
  });
}

async function batchToggleApiKeys(isActive) {
  if (state.selectedApiKeys.size === 0) {
    showToast('请先选择 API Key', 'warning');
    return;
  }

  const actionName = isActive ? '启用' : '禁用';
  if (!confirm(`确定要批量${actionName}选中的 ${state.selectedApiKeys.size} 个 API Key 吗？`)) return;

  const ids = Array.from(state.selectedApiKeys);
  const results = await Promise.allSettled(
    ids.map((id) => apiRequest(`/admin/api-keys/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: isActive })
    }))
  );

  const successCount = results.filter((item) => item.status === 'fulfilled').length;
  const failedCount = results.length - successCount;
  showToast(`批量${actionName}完成：成功 ${successCount}，失败 ${failedCount}`, failedCount > 0 ? 'warning' : 'success');

  state.selectedApiKeys.clear();
  await Promise.all([loadApiKeys(), loadStats()]);
}

async function batchDeleteApiKeys() {
  if (state.selectedApiKeys.size === 0) {
    showToast('请先选择 API Key', 'warning');
    return;
  }

  if (!confirm(`确定要删除选中的 ${state.selectedApiKeys.size} 个 API Key 吗？此操作不可恢复。`)) return;

  const ids = Array.from(state.selectedApiKeys);
  const results = await Promise.allSettled(
    ids.map((id) => apiRequest(`/admin/api-keys/${id}`, { method: 'DELETE' }))
  );

  const successCount = results.filter((item) => item.status === 'fulfilled').length;
  const failedCount = results.length - successCount;
  showToast(`批量删除完成：成功 ${successCount}，失败 ${failedCount}`, failedCount > 0 ? 'warning' : 'success');

  state.selectedApiKeys.clear();
  await Promise.all([loadApiKeys(), loadStats()]);
}

function showCreateApiKeyModal() {
  const modal = document.getElementById('createApiKeyModal');
  if (!modal) {
    return;
  }
  modal.classList.remove('hidden');
  const input = document.getElementById('apiKeyName');
  if (input) {
    input.focus();
  }
}

function closeCreateApiKeyModal() {
  const modal = document.getElementById('createApiKeyModal');
  if (modal) {
    modal.classList.add('hidden');
  }
  const nameInput = document.getElementById('apiKeyName');
  const rpmInput = document.getElementById('apiKeyRpmLimit');
  const dailyInput = document.getElementById('apiKeyDailyLimit');
  if (nameInput) nameInput.value = '';
  if (rpmInput) rpmInput.value = '60';
  if (dailyInput) dailyInput.value = '0';
}

async function handleCreateApiKey(event) {
  event.preventDefault();
  const name = document.getElementById('apiKeyName').value.trim();
  const rpmLimit = parseNonNegativeInt(document.getElementById('apiKeyRpmLimit').value, 60);
  const dailyLimit = parseNonNegativeInt(document.getElementById('apiKeyDailyLimit').value, 0);

  try {
    const { data } = await apiRequest('/admin/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rpm_limit: rpmLimit, daily_limit: dailyLimit })
    });

    closeCreateApiKeyModal();
    showToast('API Key 创建成功', 'success');
    window.prompt('请复制并保存 API Key（关闭后无法再次查看）', data.key);

    await Promise.all([loadApiKeys(), loadStats()]);
  } catch (error) {
    showToast(`创建失败：${error.message}`, 'error');
  }
}

async function saveApiKeyLimits(id) {
  const rpmInput = document.getElementById(`rpmLimit-${id}`);
  const dailyInput = document.getElementById(`dailyLimit-${id}`);

  const rpmLimit = parseNonNegativeInt(rpmInput?.value, NaN);
  const dailyLimit = parseNonNegativeInt(dailyInput?.value, NaN);

  if (!Number.isFinite(rpmLimit) || !Number.isFinite(dailyLimit)) {
    showToast('限流和配额必须是大于等于 0 的整数', 'warning');
    return;
  }

  try {
    await apiRequest(`/admin/api-keys/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rpm_limit: rpmLimit, daily_limit: dailyLimit })
    });
    showToast('API Key 限流配置已更新', 'success');
    await loadApiKeys();
  } catch (error) {
    showToast(`更新失败：${error.message}`, 'error');
  }
}

async function toggleApiKey(id, currentStatus) {
  try {
    await apiRequest(`/admin/api-keys/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !currentStatus })
    });
    showToast('状态已更新', 'success');
    await Promise.all([loadApiKeys(), loadStats()]);
  } catch (error) {
    showToast(`操作失败：${error.message}`, 'error');
  }
}

async function deleteApiKey(id) {
  if (!confirm('确定要删除此 API Key 吗？')) return;

  try {
    await apiRequest(`/admin/api-keys/${id}`, { method: 'DELETE' });
    showToast('API Key 已删除', 'success');
    await Promise.all([loadApiKeys(), loadStats()]);
  } catch (error) {
    showToast(`删除失败：${error.message}`, 'error');
  }
}

async function loadTokens(page = 1) {
  state.currentTokenPage = page;
  state.selectedTokens.clear();
  updateBatchDeleteButton();

  try {
    const query = new URLSearchParams({
      page: String(page),
      limit: String(state.tokenPageSize)
    });

    const keyword = state.tokenFilters.keyword.trim();
    const status = state.tokenFilters.status;
    if (keyword) {
      query.set('keyword', keyword);
    }
    if (status && status !== 'all') {
      query.set('status', status);
    }

    const { data } = await apiRequest(`/admin/tokens?${query.toString()}`);
    const list = data?.data || [];
    const pagination = data?.pagination || {};

    state.totalTokens = pagination.total || 0;
    const totalCountEl = document.getElementById('totalTokensCount');
    if (totalCountEl) totalCountEl.textContent = state.totalTokens;

    const tbody = document.getElementById('tokensTable');
    if (list.length === 0) {
      const selectAll = document.getElementById('selectAllTokens');
      if (selectAll) selectAll.checked = false;
      tbody.innerHTML = '<tr><td colspan="16" class="text-center py-8 text-gray-500">暂无符合条件的 Token</td></tr>';
      updateTokenPagination(0, 0);
      return;
    }

    tbody.innerHTML = list.map((token) => {
      const quotaTotal = token.quota_total || 0;
      const quotaUsed = token.quota_used || 0;
      const quotaRemaining = token.quota_remaining || 0;
      const quotaPercent = quotaTotal > 0 ? Math.round((quotaUsed / quotaTotal) * 100) : 0;
      const cooldownUntil = token.cooldown_until ? new Date(token.cooldown_until) : null;
      const healthNextCheck = token.health_next_check_at ? new Date(token.health_next_check_at) : null;
      const retryAt = healthNextCheck && !Number.isNaN(healthNextCheck.getTime())
        ? healthNextCheck
        : cooldownUntil;
      const isCooling = retryAt && retryAt.getTime() > Date.now();
      const isAutoDisabled = !token.is_active && Boolean(token.health_auto_disabled);
      const healthStatus = String(token.health_status || 'unknown').toLowerCase();
      const consecutiveFailures = token.consecutive_failures || 0;
      const totalRequests = Number.parseInt(token.total_requests, 10) || 0;
      const successRequests = Number.parseInt(token.success_requests, 10) || 0;
      const successRate = totalRequests > 0 ? Math.round((successRequests / totalRequests) * 100) : 100;
      const healthError = String(token.health_last_error || '-');
      const shortHealthError = healthError.length > 38 ? `${healthError.slice(0, 38)}...` : healthError;

      let healthBadgeClass = 'bg-gray-100 text-gray-700';
      let healthBadgeText = '未知';
      if (healthStatus === 'healthy') {
        healthBadgeClass = 'bg-green-100 text-green-700';
        healthBadgeText = '健康';
      } else if (healthStatus === 'unhealthy') {
        healthBadgeClass = 'bg-red-100 text-red-700';
        healthBadgeText = '异常';
      }

      let quotaColor = 'text-green-600';
      if (quotaPercent > 80) quotaColor = 'text-red-600';
      else if (quotaPercent > 50) quotaColor = 'text-amber-600';

      let quotaText = '-';
      if (quotaTotal > 0) {
        quotaText = `<div class="text-xs ${quotaColor}">
          <div class="font-medium">${quotaRemaining.toLocaleString()} / ${quotaTotal.toLocaleString()}</div>
          <div class="text-gray-500">${quotaPercent}% 已用</div>
        </div>`;
      }

      let statusClass = 'bg-green-100 text-green-800';
      let statusText = '启用';
      if (!token.is_active) {
        if (isAutoDisabled) {
          statusClass = 'bg-amber-100 text-amber-800';
          statusText = '自动封停';
        } else {
          statusClass = 'bg-red-100 text-red-800';
          statusText = '禁用';
        }
      } else if (isCooling) {
        statusClass = 'bg-amber-100 text-amber-800';
        statusText = '冷却中';
      }

      return `
        <tr class="border-b border-gray-100 hover:bg-gray-50">
          <td class="py-4 px-4">
            <input type="checkbox" class="token-checkbox rounded border-gray-300 text-blue-600 focus:ring-blue-500" value="${token.id}" onchange="toggleTokenSelection(${token.id})" />
          </td>
          <td class="py-4 px-4 text-sm text-gray-900">${escapeHtml(token.name || token.email || token.account_id || '-')}</td>
          <td class="py-4 px-4">${quotaText}</td>
          <td class="py-4 px-4 text-sm font-medium text-gray-900">${totalRequests}</td>
          <td class="py-4 px-4 text-sm text-green-600">${successRequests}</td>
          <td class="py-4 px-4 text-sm text-red-600">${token.failed_requests || 0}</td>
          <td class="py-4 px-4 text-sm">
            <span class="font-medium ${successRate >= 95 ? 'text-green-600' : successRate >= 80 ? 'text-amber-600' : 'text-red-600'}">${successRate}%</span>
          </td>
          <td class="py-4 px-4 text-sm text-amber-700">${consecutiveFailures}</td>
          <td class="py-4 px-4 text-xs text-gray-600">${isCooling ? formatDateTime(retryAt) : '-'}</td>
          <td class="py-4 px-4 text-sm">
            <span class="inline-flex items-center px-2 py-0.5 rounded text-xs ${healthBadgeClass}">${healthBadgeText}</span>
          </td>
          <td class="py-4 px-4 text-xs text-gray-600">${formatDateTime(token.health_next_check_at)}</td>
          <td class="py-4 px-4 text-xs text-gray-600" title="${escapeHtml(healthError)}">${escapeHtml(shortHealthError)}</td>
          <td class="py-4 px-4 text-sm text-gray-600">${formatDateTime(token.last_used_at)}</td>
          <td class="py-4 px-4 text-sm text-gray-600">${formatDateTime(token.expired_at)}</td>
          <td class="py-4 px-4">
            <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusClass}">
              ${statusText}
            </span>
          </td>
          <td class="py-4 px-4 whitespace-nowrap">
            <button onclick="refreshTokenQuota(${token.id})" class="text-sm text-blue-600 hover:text-blue-800 mr-2" title="刷新额度">
              <i class="fas fa-sync-alt"></i>
            </button>
            <button onclick="toggleToken(${token.id}, ${Boolean(token.is_active)})" class="text-sm text-gray-600 hover:text-gray-900 mr-2">
              ${token.is_active ? '禁用' : '启用'}
            </button>
            <button onclick="deleteToken(${token.id})" class="text-sm text-red-600 hover:text-red-800">删除</button>
          </td>
        </tr>
      `;
    }).join('');

    updateTokenPagination(pagination.page, pagination.totalPages);
  } catch (error) {
    console.error('加载 Tokens 失败:', error);
    showToast(`加载账号失败：${error.message}`, 'error');
  }
}

function updateTokenPagination(currentPage, totalPages) {
  const paginationEl = document.getElementById('tokenPagination');
  if (!paginationEl) return;

  if (totalPages <= 1) {
    paginationEl.innerHTML = '';
    return;
  }

  let html = '<div class="flex items-center justify-between mt-4">';
  html += `<div class="text-sm text-gray-600">共 ${state.totalTokens} 个账号，第 ${currentPage}/${totalPages} 页</div>`;
  html += '<div class="flex space-x-2">';

  if (currentPage > 1) {
    html += `<button onclick="loadTokens(${currentPage - 1})" class="px-3 py-1 border border-gray-300 rounded hover:bg-gray-50">上一页</button>`;
  } else {
    html += '<button disabled class="px-3 py-1 border border-gray-200 rounded text-gray-400 cursor-not-allowed">上一页</button>';
  }

  const maxPages = 5;
  let startPage = Math.max(1, currentPage - Math.floor(maxPages / 2));
  let endPage = Math.min(totalPages, startPage + maxPages - 1);
  if (endPage - startPage < maxPages - 1) {
    startPage = Math.max(1, endPage - maxPages + 1);
  }

  if (startPage > 1) {
    html += '<button onclick="loadTokens(1)" class="px-3 py-1 border border-gray-300 rounded hover:bg-gray-50">1</button>';
    if (startPage > 2) html += '<span class="px-2 py-1">...</span>';
  }

  for (let i = startPage; i <= endPage; i += 1) {
    if (i === currentPage) {
      html += `<button class="px-3 py-1 bg-blue-500 text-white rounded">${i}</button>`;
    } else {
      html += `<button onclick="loadTokens(${i})" class="px-3 py-1 border border-gray-300 rounded hover:bg-gray-50">${i}</button>`;
    }
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) html += '<span class="px-2 py-1">...</span>';
    html += `<button onclick="loadTokens(${totalPages})" class="px-3 py-1 border border-gray-300 rounded hover:bg-gray-50">${totalPages}</button>`;
  }

  if (currentPage < totalPages) {
    html += `<button onclick="loadTokens(${currentPage + 1})" class="px-3 py-1 border border-gray-300 rounded hover:bg-gray-50">下一页</button>`;
  } else {
    html += '<button disabled class="px-3 py-1 border border-gray-200 rounded text-gray-400 cursor-not-allowed">下一页</button>';
  }

  html += '</div></div>';
  paginationEl.innerHTML = html;
}

function applyTokenFilters() {
  state.tokenFilters.keyword = String(document.getElementById('tokenKeywordFilter')?.value || '').trim();
  state.tokenFilters.status = document.getElementById('tokenStatusFilter')?.value || 'all';
  saveUiState();
  loadTokens(1).catch((error) => {
    showToast(`筛选失败：${error.message}`, 'error');
  });
}

function resetTokenFilters() {
  state.tokenFilters.keyword = '';
  state.tokenFilters.status = 'all';

  const keywordInput = document.getElementById('tokenKeywordFilter');
  const statusSelect = document.getElementById('tokenStatusFilter');
  if (keywordInput) keywordInput.value = '';
  if (statusSelect) statusSelect.value = 'all';

  saveUiState();
  loadTokens(1).catch((error) => {
    showToast(`重置筛选失败：${error.message}`, 'error');
  });
}

function showCreateTokenModal() {
  const modal = document.getElementById('createTokenModal');
  if (!modal) {
    return;
  }
  modal.classList.remove('hidden');
  const input = document.getElementById('tokenName');
  if (input) {
    input.focus();
  }
}

function closeCreateTokenModal() {
  const modal = document.getElementById('createTokenModal');
  if (modal) {
    modal.classList.add('hidden');
  }
  const nameInput = document.getElementById('tokenName');
  const accessInput = document.getElementById('accessToken');
  const refreshInput = document.getElementById('refreshToken');
  if (nameInput) nameInput.value = '';
  if (accessInput) accessInput.value = '';
  if (refreshInput) refreshInput.value = '';
}

function showImportTokenModal() {
  document.getElementById('importTokenModal').classList.remove('hidden');
  const fileInput = document.getElementById('tokenFileInput');
  if (fileInput) fileInput.onchange = handleFileSelect;
}

function closeImportModal() {
  state.importData = null;
  document.getElementById('importTokenModal').classList.add('hidden');
  document.getElementById('tokenFileInput').value = '';
  document.getElementById('tokenJsonContent').value = '';
  document.getElementById('importPreview').classList.add('hidden');
}

function handleFileSelect(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;

  if (files.length === 1) {
    const reader = new FileReader();
    reader.onload = (e) => {
      document.getElementById('tokenJsonContent').value = e.target.result;
    };
    reader.onerror = () => {
      showToast('文件读取失败', 'error');
    };
    reader.readAsText(files[0]);
    return;
  }

  let allTokens = [];
  let filesRead = 0;
  const totalFiles = files.length;

  Array.from(files).forEach((file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (Array.isArray(parsed)) {
          allTokens = allTokens.concat(parsed);
        } else {
          allTokens.push(parsed);
        }
      } catch (error) {
        showToast(`文件解析失败：${file.name}`, 'error');
      }
      filesRead += 1;
      if (filesRead === totalFiles) {
        document.getElementById('tokenJsonContent').value = JSON.stringify(allTokens, null, 2);
      }
    };
    reader.onerror = () => {
      filesRead += 1;
      showToast(`文件读取失败：${file.name}`, 'error');
    };
    reader.readAsText(file);
  });
}

function previewImport() {
  const jsonContent = document.getElementById('tokenJsonContent').value.trim();
  if (!jsonContent) {
    showToast('请先选择文件或粘贴 JSON 内容', 'warning');
    return;
  }

  try {
    let parsed = JSON.parse(jsonContent);
    if (!Array.isArray(parsed)) parsed = [parsed];

    const valid = parsed.filter((token) => token.access_token && token.refresh_token);
    if (valid.length === 0) {
      showToast('未找到有效 token（必须含 access_token 和 refresh_token）', 'warning');
      return;
    }

    state.importData = valid;
    document.getElementById('importCount').textContent = valid.length;
    document.getElementById('importList').innerHTML = valid.map((token, index) => `
      <li class="flex items-center space-x-2">
        <i class="fas fa-check-circle text-green-500"></i>
        <span>${index + 1}. ${escapeHtml(token.name || token.email || token.account_id || `Token ${index + 1}`)}</span>
      </li>
    `).join('');
    document.getElementById('importPreview').classList.remove('hidden');
  } catch (error) {
    showToast(`JSON 解析失败：${error.message}`, 'error');
  }
}

async function handleImportTokens() {
  if (!state.importData || state.importData.length === 0) {
    showToast('请先预览导入数据', 'warning');
    return;
  }

  if (!confirm(`确定要导入 ${state.importData.length} 个账号吗？`)) return;

  try {
    const { data } = await apiRequest('/admin/tokens/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens: state.importData })
    });

    showToast(`导入完成：成功 ${data.successCount || 0}，失败 ${data.failedCount || 0}`, 'success');
    closeImportModal();
    await Promise.all([loadTokens(1), loadStats(), loadSystemHealth()]);
  } catch (error) {
    showToast(`导入失败：${error.message}`, 'error');
  }
}

async function handleCreateToken(event) {
  event.preventDefault();
  const name = document.getElementById('tokenName').value.trim();
  const accessToken = document.getElementById('accessToken').value.trim();
  const refreshToken = document.getElementById('refreshToken').value.trim();

  try {
    await apiRequest('/admin/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, access_token: accessToken, refresh_token: refreshToken })
    });

    closeCreateTokenModal();

    showToast('Token 添加成功', 'success');
    await Promise.all([loadTokens(1), loadStats(), loadSystemHealth()]);
  } catch (error) {
    showToast(`添加失败：${error.message}`, 'error');
  }
}

async function toggleToken(id, currentStatus) {
  try {
    await apiRequest(`/admin/tokens/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !currentStatus })
    });
    showToast('账号状态已更新', 'success');
    await Promise.all([loadTokens(state.currentTokenPage), loadStats(), loadSystemHealth()]);
  } catch (error) {
    showToast(`操作失败：${error.message}`, 'error');
  }
}

async function deleteToken(id) {
  if (!confirm('确定要删除此 Token 吗？')) return;

  try {
    await apiRequest(`/admin/tokens/${id}`, { method: 'DELETE' });
    showToast('Token 已删除', 'success');
    await Promise.all([loadTokens(state.currentTokenPage), loadStats(), loadSystemHealth()]);
  } catch (error) {
    showToast(`删除失败：${error.message}`, 'error');
  }
}

async function refreshTokenQuota(id) {
  try {
    const { data } = await apiRequest(`/admin/tokens/${id}/quota`, { method: 'POST' });
    showToast(data?.message || '额度已刷新', 'success');
    await loadTokens(state.currentTokenPage);
  } catch (error) {
    showToast(`刷新额度失败：${error.message}`, 'error');
  }
}

async function refreshAllQuotas() {
  if (!confirm('确定要刷新所有账号额度吗？')) return;

  try {
    const { data } = await apiRequest('/admin/tokens/quota/refresh-all', { method: 'POST' });
    showToast(`批量刷新完成：成功 ${data.successCount || 0}，失败 ${data.failedCount || 0}`, 'success');
    await loadTokens(state.currentTokenPage);
  } catch (error) {
    showToast(`批量刷新失败：${error.message}`, 'error');
  }
}

function toggleTokenSelection(id) {
  if (state.selectedTokens.has(id)) {
    state.selectedTokens.delete(id);
  } else {
    state.selectedTokens.add(id);
  }
  updateBatchDeleteButton();
  updateSelectAllCheckbox();
}

function toggleSelectAll() {
  const checkbox = document.getElementById('selectAllTokens');
  const checkboxes = document.querySelectorAll('.token-checkbox');
  if (checkbox.checked) {
    checkboxes.forEach((cb) => {
      const id = Number.parseInt(cb.value, 10);
      state.selectedTokens.add(id);
      cb.checked = true;
    });
  } else {
    state.selectedTokens.clear();
    checkboxes.forEach((cb) => {
      cb.checked = false;
    });
  }
  updateBatchDeleteButton();
}

function updateSelectAllCheckbox() {
  const checkbox = document.getElementById('selectAllTokens');
  const checkboxes = document.querySelectorAll('.token-checkbox');
  if (!checkbox || checkboxes.length === 0) {
    if (checkbox) checkbox.checked = false;
    return;
  }
  checkbox.checked = Array.from(checkboxes).every((cb) => cb.checked);
}

function updateBatchDeleteButton() {
  const btn = document.getElementById('batchDeleteBtn');
  const enableBtn = document.getElementById('batchEnableTokenBtn');
  const disableBtn = document.getElementById('batchDisableTokenBtn');
  const countSpan = document.getElementById('selectedCount');
  if (!btn || !countSpan) return;

  const hasSelected = state.selectedTokens.size > 0;
  if (hasSelected) {
    btn.classList.remove('hidden');
    if (enableBtn) enableBtn.classList.remove('hidden');
    if (disableBtn) disableBtn.classList.remove('hidden');
    countSpan.textContent = state.selectedTokens.size;
  } else {
    btn.classList.add('hidden');
    if (enableBtn) enableBtn.classList.add('hidden');
    if (disableBtn) disableBtn.classList.add('hidden');
  }
}

async function batchDeleteTokens() {
  if (state.selectedTokens.size === 0) {
    showToast('请先选择要删除的账号', 'warning');
    return;
  }

  if (!confirm(`确定要删除选中的 ${state.selectedTokens.size} 个账号吗？此操作不可恢复。`)) return;

  try {
    const ids = Array.from(state.selectedTokens);
    const { data } = await apiRequest('/admin/tokens/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    showToast(`批量删除完成：成功 ${data.successCount || 0}，失败 ${data.failedCount || 0}`, 'success');
    state.selectedTokens.clear();
    await Promise.all([loadTokens(state.currentTokenPage), loadStats(), loadSystemHealth()]);
  } catch (error) {
    showToast(`批量删除失败：${error.message}`, 'error');
  }
}

async function batchToggleTokens(isActive) {
  if (state.selectedTokens.size === 0) {
    showToast('请先选择要操作的账号', 'warning');
    return;
  }

  const actionName = isActive ? '启用' : '禁用';
  if (!confirm(`确定要批量${actionName}选中的 ${state.selectedTokens.size} 个账号吗？`)) return;

  const ids = Array.from(state.selectedTokens);
  const results = await Promise.allSettled(
    ids.map((id) => apiRequest(`/admin/tokens/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: isActive })
    }))
  );

  const successCount = results.filter((item) => item.status === 'fulfilled').length;
  const failedCount = results.length - successCount;
  showToast(`批量${actionName}完成：成功 ${successCount}，失败 ${failedCount}`, failedCount > 0 ? 'warning' : 'success');

  state.selectedTokens.clear();
  await Promise.all([loadTokens(state.currentTokenPage), loadStats(), loadSystemHealth()]);
}

async function loadAnalytics() {
  await Promise.all([
    loadAnalyticsStats(),
    loadCharts(),
    loadModelStats(),
    loadLogs()
  ]);
}

function changeTimeRange(range, event) {
  if (!AVAILABLE_TIME_RANGES.has(range)) {
    return;
  }
  state.currentTimeRange = range;
  setActiveTimeRangeButton(range);
  saveUiState();
  loadAnalytics();
}

async function loadAnalyticsStats() {
  const { data } = await apiRequest(`/admin/stats/analytics?range=${state.currentTimeRange}`);
  document.getElementById('totalRequests').textContent = data?.totalRequests || 0;
  document.getElementById('successRequests').textContent = data?.successRequests || 0;
  document.getElementById('failedRequests').textContent = data?.failedRequests || 0;
  document.getElementById('avgResponseTime').textContent = `${Math.round(data?.avgResponseTime || 0)}ms`;
  document.getElementById('throughputPerHour').textContent = `${data?.throughputPerHour || 0}/h`;
  document.getElementById('errorRate').textContent = `${data?.errorRate || 0}%`;
  document.getElementById('latencyP50').textContent = `${Math.round(data?.p50ResponseTime || 0)}ms`;
  document.getElementById('latencyP95').textContent = `${Math.round(data?.p95ResponseTime || 0)}ms`;
}

async function loadCharts() {
  const { data } = await apiRequest(`/admin/stats/charts?range=${state.currentTimeRange}`);

  const trendCtx = document.getElementById('requestTrendChart').getContext('2d');
  if (state.requestTrendChart) state.requestTrendChart.destroy();
  state.requestTrendChart = new Chart(trendCtx, {
    type: 'line',
    data: {
      labels: data?.trendLabels || [],
      datasets: [
        {
          label: '请求数',
          data: data?.trendData || [],
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.1)',
          tension: 0.35,
          fill: true,
          yAxisID: 'yCount'
        },
        {
          label: '失败数',
          data: data?.trendFailedData || [],
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239,68,68,0.08)',
          tension: 0.35,
          fill: false,
          yAxisID: 'yCount'
        },
        {
          type: 'bar',
          label: '平均响应(ms)',
          data: data?.trendLatencyData || [],
          yAxisID: 'yLatency',
          backgroundColor: 'rgba(139,92,246,0.25)',
          borderColor: '#8b5cf6',
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true } },
      scales: {
        yCount: { beginAtZero: true, position: 'left' },
        yLatency: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } }
      }
    }
  });

  const distCtx = document.getElementById('modelDistributionChart').getContext('2d');
  if (state.modelDistributionChart) state.modelDistributionChart.destroy();
  state.modelDistributionChart = new Chart(distCtx, {
    type: 'pie',
    data: {
      labels: data?.modelLabels || [],
      datasets: [{
        data: data?.modelData || [],
        backgroundColor: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899']
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'right' } }
    }
  });

  const endpointCtx = document.getElementById('endpointDistributionChart').getContext('2d');
  if (state.endpointDistributionChart) state.endpointDistributionChart.destroy();
  state.endpointDistributionChart = new Chart(endpointCtx, {
    type: 'bar',
    data: {
      labels: data?.endpointLabels || [],
      datasets: [{
        label: '请求数',
        data: data?.endpointData || [],
        backgroundColor: 'rgba(99,102,241,0.65)',
        borderColor: '#6366f1',
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true } }
    }
  });
}

async function loadModelStats() {
  const { data } = await apiRequest(`/admin/stats/accounts?range=${state.currentTimeRange}`);
  const list = Array.isArray(data) ? data : [];
  const tbody = document.getElementById('accountStatsTable');

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" class="text-center py-8 text-gray-500">暂无数据</td></tr>';
    return;
  }

  tbody.innerHTML = list.map((account) => {
    const successRate = account.successRate || 0;
    const successRateInWindow = account.successRateInWindow || 0;
    const rateClass = successRate >= 95 ? 'text-green-600' : successRate >= 80 ? 'text-amber-600' : 'text-red-600';
    const windowRateClass = successRateInWindow >= 95 ? 'text-green-600' : successRateInWindow >= 80 ? 'text-amber-600' : 'text-red-600';
    const healthStatus = String(account.healthStatus || 'unknown').toLowerCase();
    const healthBadgeClass = healthStatus === 'healthy'
      ? 'bg-green-100 text-green-700'
      : healthStatus === 'unhealthy'
        ? 'bg-red-100 text-red-700'
        : 'bg-gray-100 text-gray-700';
    const healthBadgeText = healthStatus === 'healthy'
      ? '健康'
      : healthStatus === 'unhealthy'
        ? '异常'
        : '未知';
    const healthError = String(account.healthLastError || '-');
    const shortHealthError = healthError.length > 36 ? `${healthError.slice(0, 36)}...` : healthError;
    return `
      <tr class="border-b border-gray-100 hover:bg-gray-50">
        <td class="py-4 px-4 text-sm font-medium text-gray-900">${escapeHtml(account.name)}</td>
        <td class="py-4 px-4 text-sm text-gray-600">${account.requests || 0}</td>
        <td class="py-4 px-4 text-sm text-gray-600">${account.requestsInWindow || 0}</td>
        <td class="py-4 px-4 text-sm text-indigo-700">${Number(account.estimatedConsumed || 0).toLocaleString('zh-CN')}</td>
        <td class="py-4 px-4"><span class="text-sm font-medium ${rateClass}">${successRate}%</span></td>
        <td class="py-4 px-4"><span class="text-sm font-medium ${windowRateClass}">${successRateInWindow}%</span></td>
        <td class="py-4 px-4 text-sm text-gray-600">${Math.round(account.avgResponseTime || 0)}ms</td>
        <td class="py-4 px-4 text-sm text-amber-700">${account.consecutiveFailures || 0}</td>
        <td class="py-4 px-4 text-sm"><span class="inline-flex items-center px-2 py-0.5 rounded text-xs ${healthBadgeClass}">${healthBadgeText}</span></td>
        <td class="py-4 px-4 text-sm text-gray-600">${formatDateTime(account.healthNextCheckAt)}</td>
        <td class="py-4 px-4 text-xs text-gray-600" title="${escapeHtml(healthError)}">${escapeHtml(shortHealthError)}</td>
        <td class="py-4 px-4 text-sm text-gray-500">${formatDateTime(account.lastUsed)}</td>
      </tr>
    `;
  }).join('');
}

async function loadLogs() {
  const query = new URLSearchParams({
    limit: '200'
  });
  if (state.logFilters.status && state.logFilters.status !== 'all') {
    query.set('status', state.logFilters.status);
  }
  if (state.logFilters.keyword.trim()) {
    query.set('keyword', state.logFilters.keyword.trim());
  }

  const { data } = await apiRequest(`/admin/stats/logs?${query.toString()}`);
  const list = Array.isArray(data) ? data : [];
  state.latestLogs = list;
  const tbody = document.getElementById('logsTable');

  if (list.length === 0) {
    state.latestLogs = [];
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-8 text-gray-500">暂无日志</td></tr>';
    return;
  }

  tbody.innerHTML = list.map((log) => {
    const statusCode = Number.parseInt(log.status_code, 10);
    const isSuccess = Number.isFinite(statusCode) && statusCode >= 200 && statusCode < 400;
    const errorMessage = String(log.error_message || '-');
    const shortError = errorMessage.length > 60 ? `${errorMessage.slice(0, 60)}...` : errorMessage;
    return `
      <tr class="border-b border-gray-100 hover:bg-gray-50">
        <td class="py-3 px-4 text-xs text-gray-600">${formatDateTime(log.created_at)}</td>
        <td class="py-3 px-4 text-xs text-gray-600">${escapeHtml(log.api_key_name || log.api_key_id || '-')}</td>
        <td class="py-3 px-4 text-xs text-gray-600">${escapeHtml(log.token_name || log.token_id || '-')}</td>
        <td class="py-3 px-4 text-xs text-gray-600">${escapeHtml(log.model || '-')}</td>
        <td class="py-3 px-4 text-xs text-gray-600">${escapeHtml(log.endpoint || '-')}</td>
        <td class="py-3 px-4">
          <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${isSuccess ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
            ${log.status_code || '-'}
          </span>
        </td>
        <td class="py-3 px-4 text-xs text-gray-600">${Number.isFinite(Number.parseInt(log.response_time, 10)) ? `${Number.parseInt(log.response_time, 10)}ms` : '-'}</td>
        <td class="py-3 px-4 text-xs text-gray-600" title="${escapeHtml(errorMessage)}">${escapeHtml(shortError)}</td>
      </tr>
    `;
  }).join('');
}

function applyLogFilters() {
  state.logFilters.keyword = String(document.getElementById('logsKeywordFilter')?.value || '').trim();
  state.logFilters.status = document.getElementById('logsStatusFilter')?.value || 'all';
  saveUiState();
  loadLogs().catch((error) => {
    showToast(`日志筛选失败：${error.message}`, 'error');
  });
}

function resetLogFilters() {
  state.logFilters.keyword = '';
  state.logFilters.status = 'all';
  const keywordInput = document.getElementById('logsKeywordFilter');
  const statusSelect = document.getElementById('logsStatusFilter');
  if (keywordInput) keywordInput.value = '';
  if (statusSelect) statusSelect.value = 'all';
  saveUiState();
  loadLogs().catch((error) => {
    showToast(`重置日志筛选失败：${error.message}`, 'error');
  });
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

async function exportLogsCsv() {
  const query = new URLSearchParams({
    limit: '5000'
  });
  if (state.logFilters.status && state.logFilters.status !== 'all') {
    query.set('status', state.logFilters.status);
  }
  if (state.logFilters.keyword.trim()) {
    query.set('keyword', state.logFilters.keyword.trim());
  }

  try {
    const response = await fetch(`/admin/stats/logs/export?${query.toString()}`);
    if (!response.ok) {
      throw new Error(`导出失败（HTTP ${response.status}）`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateTag = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `api-logs-${dateTag}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('日志 CSV 导出成功', 'success');
  } catch (error) {
    // 后端导出失败时，兜底使用前端缓存数据导出
    if (!state.latestLogs || state.latestLogs.length === 0) {
      showToast(`导出失败：${error.message}`, 'error');
      return;
    }

    const headers = ['time', 'api_key', 'token', 'model', 'endpoint', 'status_code', 'response_time_ms', 'error_message'];
    const rows = state.latestLogs.map((log) => [
      log.created_at,
      log.api_key_name,
      log.token_name,
      log.model,
      log.endpoint,
      log.status_code,
      Number.isFinite(Number.parseInt(log.response_time, 10)) ? Number.parseInt(log.response_time, 10) : '',
      log.error_message
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateTag = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `api-logs-fallback-${dateTag}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('后端导出不可用，已使用前端缓存导出', 'warning');
  }
}

async function handleLogout() {
  if (!confirm('确定要退出登录吗？')) return;
  try {
    await apiRequest('/admin/auth/logout', { method: 'POST', throwOnError: false });
  } finally {
    window.location.href = '/admin/login.html';
  }
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const temp = document.createElement('textarea');
      temp.value = text;
      temp.setAttribute('readonly', 'readonly');
      temp.style.position = 'fixed';
      temp.style.left = '-9999px';
      document.body.appendChild(temp);
      temp.select();
      const copied = document.execCommand('copy');
      temp.remove();
      if (!copied) {
        throw new Error('浏览器不支持自动复制');
      }
    }
    showToast('已复制到剪贴板', 'success');
  } catch {
    showToast('复制失败，请手动复制', 'error');
  }
}

async function loadLoadBalanceStrategy() {
  try {
    const { data } = await apiRequest('/admin/settings/load-balance-strategy');
    const select = document.getElementById('loadBalanceStrategy');
    if (select && data?.strategy) select.value = data.strategy;
    applyEnvWritableState(data?.envFileWritable);
  } catch (error) {
    showToast(`加载策略失败：${error.message}`, 'error');
  }
}

async function changeLoadBalanceStrategy() {
  if (!state.envFileWritable) {
    showToast('当前环境已禁用在线写入 .env，无法修改负载均衡策略', 'warning');
    return;
  }

  const select = document.getElementById('loadBalanceStrategy');
  const strategy = select?.value;
  if (!strategy) return;

  try {
    await apiRequest('/admin/settings/load-balance-strategy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy })
    });
    showToast('负载均衡策略已更新', 'success');
    await loadSystemHealth();
  } catch (error) {
    showToast(`更新失败：${error.message}`, 'error');
  }
}

async function loadRuntimeSettings() {
  try {
    const { data } = await apiRequest('/admin/settings/runtime');
    document.getElementById('settingApiKeyDefaultRpmLimit').value = data?.apiKeyDefaultRpmLimit ?? 60;
    document.getElementById('settingMaxConcurrentProxyRequests').value = data?.maxConcurrentProxyRequests ?? 100;
    document.getElementById('settingTokenCircuitBreakerThreshold').value = data?.tokenCircuitBreakerThreshold ?? 1;
    document.getElementById('settingTokenCooldownMinutes').value = data?.tokenCooldownMinutes ?? 10;
    document.getElementById('settingTokenHealthCheckEnabled').checked = data?.tokenHealthCheckEnabled !== false;
    document.getElementById('settingTokenHealthCheckIntervalSeconds').value = data?.tokenHealthCheckIntervalSeconds ?? 120;
    document.getElementById('settingTokenHealthCheckTimeoutMs').value = data?.tokenHealthCheckTimeoutMs ?? 15000;
    document.getElementById('settingTokenHealthCheckMaxCooldownMinutes').value = data?.tokenHealthCheckMaxCooldownMinutes ?? 720;
    applyEnvWritableState(data?.envFileWritable);
  } catch (error) {
    showToast(`加载运行参数失败：${error.message}`, 'error');
  }
}

async function saveRuntimeSettings(event) {
  event.preventDefault();

  if (!state.envFileWritable) {
    showToast('当前环境已禁用在线写入 .env，无法保存运行参数', 'warning');
    return;
  }

  const payload = {
    apiKeyDefaultRpmLimit: parseNonNegativeInt(document.getElementById('settingApiKeyDefaultRpmLimit').value, NaN),
    maxConcurrentProxyRequests: parseNonNegativeInt(document.getElementById('settingMaxConcurrentProxyRequests').value, NaN),
    tokenCircuitBreakerThreshold: parseNonNegativeInt(document.getElementById('settingTokenCircuitBreakerThreshold').value, NaN),
    tokenCooldownMinutes: parseNonNegativeInt(document.getElementById('settingTokenCooldownMinutes').value, NaN),
    tokenHealthCheckEnabled: document.getElementById('settingTokenHealthCheckEnabled').checked,
    tokenHealthCheckIntervalSeconds: parseNonNegativeInt(document.getElementById('settingTokenHealthCheckIntervalSeconds').value, NaN),
    tokenHealthCheckTimeoutMs: parseNonNegativeInt(document.getElementById('settingTokenHealthCheckTimeoutMs').value, NaN),
    tokenHealthCheckMaxCooldownMinutes: parseNonNegativeInt(document.getElementById('settingTokenHealthCheckMaxCooldownMinutes').value, NaN)
  };

  if (!Number.isFinite(payload.apiKeyDefaultRpmLimit) ||
      !Number.isFinite(payload.maxConcurrentProxyRequests) ||
      !Number.isFinite(payload.tokenCircuitBreakerThreshold) ||
      !Number.isFinite(payload.tokenCooldownMinutes) ||
      !Number.isFinite(payload.tokenHealthCheckIntervalSeconds) ||
      !Number.isFinite(payload.tokenHealthCheckTimeoutMs) ||
      !Number.isFinite(payload.tokenHealthCheckMaxCooldownMinutes) ||
      payload.maxConcurrentProxyRequests < 1 ||
      payload.tokenCircuitBreakerThreshold < 1 ||
      payload.tokenCooldownMinutes < 1 ||
      payload.tokenHealthCheckIntervalSeconds < 30 ||
      payload.tokenHealthCheckTimeoutMs < 1000 ||
      payload.tokenHealthCheckMaxCooldownMinutes < 10) {
    showToast('运行参数输入无效，请检查数值范围', 'warning');
    return;
  }

  try {
    await apiRequest('/admin/settings/runtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    showToast('运行参数已保存并生效', 'success');
    await Promise.all([loadRuntimeSettings(), loadSystemHealth(true)]);
  } catch (error) {
    showToast(`保存失败：${error.message}`, 'error');
  }
}

async function cleanupOldLogs() {
  const days = parseNonNegativeInt(document.getElementById('cleanupLogsDays')?.value, 30);
  if (!Number.isFinite(days) || days < 1) {
    showToast('清理天数必须是大于等于 1 的整数', 'warning');
    return;
  }

  if (!confirm(`确定要清理 ${days} 天前的历史日志吗？该操作不可恢复。`)) return;

  try {
    const { data } = await apiRequest('/admin/stats/logs/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days })
    });
    showToast(data?.message || '日志清理完成', 'success');
    if (state.currentPage === 'analytics') {
      await loadLogs();
    }
  } catch (error) {
    showToast(`日志清理失败：${error.message}`, 'error');
  }
}

function showChangePasswordModal() {
  document.getElementById('changePasswordModal').classList.remove('hidden');
}

function closeChangePasswordModal() {
  document.getElementById('changePasswordModal').classList.add('hidden');
  document.getElementById('currentPassword').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('confirmPassword').value = '';
}

async function handleChangePassword(event) {
  event.preventDefault();
  const currentPassword = document.getElementById('currentPassword').value;
  const newPassword = document.getElementById('newPassword').value;
  const confirmPassword = document.getElementById('confirmPassword').value;

  if (newPassword !== confirmPassword) {
    showToast('两次输入的新密码不一致', 'warning');
    return;
  }
  if (newPassword.length < 6) {
    showToast('密码长度至少 6 位', 'warning');
    return;
  }

  try {
    await apiRequest('/admin/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: currentPassword, newPassword })
    });
    showToast('密码修改成功，请重新登录', 'success');
    closeChangePasswordModal();
    setTimeout(() => {
      window.location.href = '/admin/login.html';
    }, 1000);
  } catch (error) {
    showToast(`修改失败：${error.message}`, 'error');
  }
}
