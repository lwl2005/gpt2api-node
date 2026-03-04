// 全局变量
let messages = [];
let currentModel = 'gpt-5-codex';
let currentRequestController = null;
let isSending = false;

const MODEL_STORAGE_KEY = 'gpt2api_chat_model';
const API_KEY_STORAGE_KEY = 'gpt2api_chat_api_key';

function getElement(id) {
  return document.getElementById(id);
}

function getApiKeyInput() {
  return getElement('apiKeyInput');
}

function getSendButton() {
  return getElement('sendBtn');
}

function getStopButton() {
  return getElement('stopBtn');
}

function setSendingState(sending) {
  isSending = sending;
  const sendBtn = getSendButton();
  const stopBtn = getStopButton();

  if (sendBtn) {
    if (!sendBtn.dataset.idleText) {
      sendBtn.dataset.idleText = sendBtn.innerHTML;
    }
    sendBtn.disabled = sending;
    sendBtn.classList.toggle('opacity-60', sending);
    sendBtn.classList.toggle('cursor-not-allowed', sending);
    sendBtn.innerHTML = sending
      ? '<i class="fas fa-spinner fa-spin mr-2"></i>生成中'
      : sendBtn.dataset.idleText;
  }

  if (stopBtn) {
    stopBtn.classList.toggle('hidden', !sending);
  }
}

function getConfiguredApiKey() {
  const input = getApiKeyInput();
  if (input && input.value.trim()) {
    return input.value.trim();
  }
  return localStorage.getItem(API_KEY_STORAGE_KEY) || '';
}

function persistApiKeyFromInput() {
  const input = getApiKeyInput();
  if (!input) {
    return;
  }
  const value = input.value.trim();
  if (value) {
    localStorage.setItem(API_KEY_STORAGE_KEY, value);
  } else {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
  }
}

function setStoredModel(modelId) {
  if (typeof modelId === 'string' && modelId.trim()) {
    localStorage.setItem(MODEL_STORAGE_KEY, modelId.trim());
  }
}

function getStoredModel() {
  return localStorage.getItem(MODEL_STORAGE_KEY) || '';
}

function removeMessageIfExists(messageId) {
  if (!messageId) {
    return;
  }
  const el = getElement(messageId);
  if (el) {
    el.remove();
  }
}

function parseSseData(rawEvent) {
  const lines = String(rawEvent || '').split('\n');
  const dataLines = [];

  for (const line of lines) {
    if (!line.startsWith('data:')) {
      continue;
    }
    dataLines.push(line.slice(5).trimStart());
  }

  return dataLines.join('\n').trim();
}

async function consumeSseStream(readableStream, onData) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');

    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const data = parseSseData(rawEvent);
      if (data) {
        onData(data);
      }
      separatorIndex = buffer.indexOf('\n\n');
    }
  }

  const finalData = parseSseData(buffer);
  if (finalData) {
    onData(finalData);
  }
}

function bindInputEvents() {
  const messageInput = getElement('messageInput');
  if (messageInput) {
    messageInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
  }

  const apiKeyInput = getApiKeyInput();
  if (apiKeyInput) {
    const stored = localStorage.getItem(API_KEY_STORAGE_KEY);
    if (stored) {
      apiKeyInput.value = stored;
    }
    apiKeyInput.addEventListener('change', persistApiKeyFromInput);
    apiKeyInput.addEventListener('blur', persistApiKeyFromInput);
  }

  const stopBtn = getStopButton();
  if (stopBtn) {
    stopBtn.addEventListener('click', stopGenerating);
  }
}

function stopGenerating() {
  if (currentRequestController) {
    currentRequestController.abort();
    currentRequestController = null;
  }
}

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', async () => {
  bindInputEvents();
  await loadStatus();
  await loadModels();
});

// 加载服务状态
async function loadStatus() {
  try {
    const response = await fetch('/v1/health');
    const data = await response.json();

    const statusEl = getElement('serviceStatus');
    const accountEl = getElement('accountEmail');
    const expireEl = getElement('tokenExpire');

    if (statusEl) {
      statusEl.textContent = data.status === 'ok' ? '运行中' : '异常';
      statusEl.classList.remove('text-error', 'text-success', 'text-primary');
      statusEl.classList.add(data.status === 'ok' ? 'text-success' : 'text-error');
    }

    if (accountEl) {
      accountEl.textContent = data.token?.email || data.token?.account_id || '未知';
    }

    if (expireEl && data.token?.expired) {
      const expireDate = new Date(data.token.expired);
      expireEl.textContent = Number.isNaN(expireDate.getTime()) ? '未知' : expireDate.toLocaleString('zh-CN');
    }
  } catch (error) {
    console.error('加载状态失败:', error);
    const statusEl = getElement('serviceStatus');
    if (statusEl) {
      statusEl.textContent = '离线';
      statusEl.classList.remove('text-primary', 'text-success');
      statusEl.classList.add('text-error');
    }
  }
}

// 加载模型列表
async function loadModels() {
  try {
    const response = await fetch('/v1/models');
    const data = await response.json();

    const select = getElement('modelSelect');
    if (!select) {
      return;
    }

    select.innerHTML = '';
    const models = Array.isArray(data.data) ? data.data : [];

    models.forEach((model) => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.id;
      select.appendChild(option);
    });

    if (models.length > 0) {
      const storedModel = getStoredModel();
      const matched = models.find((item) => item.id === storedModel);
      currentModel = matched ? matched.id : models[0].id;
      select.value = currentModel;
      setStoredModel(currentModel);
    }

    select.addEventListener('change', (e) => {
      currentModel = e.target.value;
      setStoredModel(currentModel);
    });
  } catch (error) {
    console.error('加载模型失败:', error);
  }
}

// 发送消息
async function sendMessage() {
  if (isSending) {
    stopGenerating();
    return;
  }

  const input = getElement('messageInput');
  if (!input) {
    return;
  }

  const message = input.value.trim();
  if (!message) return;

  // 添加用户消息
  messages.push({ role: 'user', content: message });
  appendMessage('user', message);
  input.value = '';

  // 显示加载状态
  const loadingId = appendMessage('assistant', '思考中...', true);
  setSendingState(true);

  currentRequestController = new AbortController();

  try {
    const headers = {
      'Content-Type': 'application/json'
    };

    const apiKey = getConfiguredApiKey();
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers,
      signal: currentRequestController.signal,
      body: JSON.stringify({
        model: currentModel,
        messages,
        stream: true
      })
    });

    if (!response.ok) {
      let errMsg = `HTTP error! status: ${response.status}`;
      try {
        const errData = await response.json();
        errMsg = errData?.error?.message || errData?.error || errData?.message || errMsg;
      } catch {
        // 忽略 JSON 解析失败
      }

      if (response.status === 401) {
        errMsg = `${errMsg}（请检查 API Key）`;
      }
      throw new Error(errMsg);
    }

    // 移除加载消息
    removeMessageIfExists(loadingId);

    // 处理流式响应
    let assistantMessage = '';
    let messageId = null;

    await consumeSseStream(response.body, (data) => {
      if (data === '[DONE]') {
        return;
      }

      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }

      if (json?.error?.message) {
        throw new Error(json.error.message);
      }

      const content = json.choices?.[0]?.delta?.content;
      const reasoningContent = json.choices?.[0]?.delta?.reasoning_content;
      const patch = typeof content === 'string' && content
        ? content
        : (typeof reasoningContent === 'string' ? reasoningContent : '');

      if (!patch) {
        return;
      }

      assistantMessage += patch;

      if (!messageId) {
        messageId = appendMessage('assistant', assistantMessage);
      } else {
        updateMessage(messageId, assistantMessage);
      }
    });

    // 保存助手消息
    if (assistantMessage) {
      messages.push({ role: 'assistant', content: assistantMessage });
    } else {
      appendMessage('system', '未收到有效内容');
    }
  } catch (error) {
    console.error('发送消息失败:', error);
    removeMessageIfExists(loadingId);

    if (error?.name === 'AbortError') {
      appendMessage('system', '已停止生成');
    } else {
      appendMessage('system', `错误: ${error.message}`);
    }
  } finally {
    currentRequestController = null;
    setSendingState(false);
  }
}

// 添加消息到聊天区域
function appendMessage(role, content, isLoading = false) {
  const container = getElement('chatMessages');
  if (!container) {
    return '';
  }

  // 首次添加消息时清除欢迎文本
  if (container.children.length === 1 && container.children[0].classList.contains('text-center')) {
    container.innerHTML = '';
  }

  const messageId = `msg-${Date.now()}-${Math.random()}`;
  const messageDiv = document.createElement('div');
  messageDiv.id = messageId;
  messageDiv.className = `chat chat-message ${role === 'user' ? 'chat-end' : 'chat-start'}`;

  let avatarClass = 'bg-primary';
  let avatarText = 'U';

  if (role === 'assistant') {
    avatarClass = 'bg-secondary';
    avatarText = 'AI';
  } else if (role === 'system') {
    avatarClass = 'bg-error';
    avatarText = '!';
  }

  messageDiv.innerHTML = `
    <div class="chat-image avatar">
      <div class="w-10 rounded-full ${avatarClass} flex items-center justify-center text-white font-bold">
        ${avatarText}
      </div>
    </div>
    <div class="chat-bubble ${role === 'user' ? 'chat-bubble-primary' : role === 'system' ? 'chat-bubble-error' : ''}">
      ${isLoading ? '<span class="loading loading-dots loading-sm"></span>' : escapeHtml(content)}
    </div>
  `;

  container.appendChild(messageDiv);
  container.scrollTop = container.scrollHeight;

  return messageId;
}

// 更新消息内容
function updateMessage(messageId, content) {
  const messageDiv = getElement(messageId);
  if (messageDiv) {
    const bubble = messageDiv.querySelector('.chat-bubble');
    if (bubble) {
      bubble.textContent = content;
    }
  }

  const container = getElement('chatMessages');
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

// 清空聊天
function clearChat() {
  stopGenerating();
  messages = [];
  const container = getElement('chatMessages');
  if (container) {
    container.innerHTML = '<div class="text-center text-base-content/50 py-8">开始对话吧！</div>';
  }
}

// HTML 转义
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 显示设置
function showSettings() {
  alert('设置功能开发中...');
}

// 显示状态
async function showStatus() {
  await loadStatus();
  alert('状态已刷新！');
}

// 显示模型列表
async function showModels() {
  try {
    const response = await fetch('/v1/models');
    const data = await response.json();
    const modelList = Array.isArray(data.data) ? data.data.map((m) => m.id).join('\n') : '暂无模型';
    alert(`可用模型:\n\n${modelList}`);
  } catch (error) {
    alert(`获取模型列表失败: ${error.message}`);
  }
}
