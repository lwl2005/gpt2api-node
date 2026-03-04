import axios from 'axios';
import { randomUUID } from 'crypto';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_CLIENT_VERSION = '0.101.0';
const CODEX_USER_AGENT = 'codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464';
const REQUEST_TIMEOUT_MS = 300000;

function getDefaultCodexModel() {
  return String(process.env.DEFAULT_CODEX_MODEL || process.env.DEFAULT_MODEL || 'gpt-5-codex').trim() || 'gpt-5-codex';
}

// 清理终端颜色码与控制字符，避免出现 gpt-5.3-codex[1m 这类污染模型名
const ANSI_ESCAPE_SEQUENCE_REGEX = /[\u001b\u009b][[\\]()#;?]*(?:(?:\d{1,4}(?:;\d{0,4})*)?\d?[A-ORZcf-nqry=><~])/g;
const TRAILING_ANSI_MARKER_REGEX = /(?:\[(?:\d{1,3}(?:;\d{1,3})*)m)+$/gi;
const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F]/g;

/**
 * 代理处理器
 */
class ProxyHandler {
  constructor(tokenManager) {
    this.tokenManager = tokenManager;
    this.httpClient = axios.create({
      baseURL: CODEX_BASE_URL,
      timeout: REQUEST_TIMEOUT_MS
    });
  }

  /**
   * 生成会话 ID
   */
  generateSessionId() {
    return randomUUID();
  }

  createHeaders(accessToken, acceptStream = false) {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': CODEX_USER_AGENT,
      Version: CODEX_CLIENT_VERSION,
      'Openai-Beta': 'responses=experimental',
      Session_id: this.generateSessionId(),
      ...(acceptStream ? { Accept: 'text/event-stream' } : {})
    };
  }

  createHttpError(message, statusCode = 500, type = 'proxy_error', extra = {}) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.type = type;
    if (extra.param !== undefined) {
      error.param = extra.param;
    }
    if (extra.code !== undefined) {
      error.code = extra.code;
    }
    return error;
  }

  normalizeStatusCode(candidate, fallback = 502) {
    const parsed = Number.parseInt(candidate, 10);
    if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 599) {
      return parsed;
    }
    return fallback;
  }

  extractStreamFailure(parsed) {
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const eventType = typeof parsed.type === 'string' ? parsed.type : '';
    const errorPayload = parsed.error || parsed.response?.error;
    const failedByType = eventType === 'response.failed' || eventType === 'response.error' || eventType === 'error';
    const failedByErrorPayload = Boolean(errorPayload);

    if (!failedByType && !failedByErrorPayload) {
      return null;
    }

    const message = this.normalizeTextContent(
      errorPayload?.message
      || parsed.message
      || parsed.response?.status
      || '上游返回失败事件'
    );

    const statusCode = this.normalizeStatusCode(
      errorPayload?.status
      || errorPayload?.status_code
      || parsed.status
      || parsed.status_code
      || 502,
      502
    );

    return { message, statusCode };
  }

  extractErrorMessage(error) {
    let message = '';
    if (typeof error?.response?.data?.error?.message === 'string') {
      message = error.response.data.error.message;
    } else if (typeof error?.response?.data === 'string') {
      message = error.response.data;
    } else {
      message = error?.message || '代理请求失败';
    }

    // 对常见模型不可用错误补充可执行建议，便于客户端快速自救
    if (/selected model|model .*not exist|may not exist|no access|没有权限|模型不存在/i.test(message)) {
      return `${message}（建议改用 ${getDefaultCodexModel()}，或先调用 /v1/models 确认可用模型）`;
    }

    return message;
  }

  /**
   * 校验 OpenAI 请求，尽早返回 4xx，避免无意义的上游请求
   */
  validateRequest(openaiRequest) {
    if (!openaiRequest || typeof openaiRequest !== 'object') {
      throw this.createHttpError('请求体必须是 JSON 对象', 400, 'invalid_request_error');
    }

    if (!Array.isArray(openaiRequest.messages) || openaiRequest.messages.length === 0) {
      throw this.createHttpError('messages 必须是非空数组', 400, 'invalid_request_error', {
        param: 'messages'
      });
    }

    if (openaiRequest.n !== undefined) {
      const nValue = Number.parseInt(openaiRequest.n, 10);
      if (!Number.isFinite(nValue) || Number.isNaN(nValue) || nValue < 1) {
        throw this.createHttpError('n 必须是大于等于 1 的整数', 400, 'invalid_request_error', {
          param: 'n'
        });
      }
      if (nValue > 1) {
        throw this.createHttpError('当前后端仅支持 n=1', 400, 'invalid_request_error', {
          param: 'n',
          code: 'unsupported_parameter'
        });
      }
    }
  }

  /**
   * 校验 Responses API 请求
   */
  validateResponsesRequest(openaiRequest) {
    if (!openaiRequest || typeof openaiRequest !== 'object') {
      throw this.createHttpError('请求体必须是 JSON 对象', 400, 'invalid_request_error');
    }

    const hasMessages = Array.isArray(openaiRequest.messages) && openaiRequest.messages.length > 0;
    const hasInput = openaiRequest.input !== undefined && openaiRequest.input !== null;

    if (!hasMessages && !hasInput) {
      throw this.createHttpError('input 或 messages 至少需要提供一个', 400, 'invalid_request_error');
    }
  }

  /**
   * 校验 Completions API 请求
   */
  validateCompletionsRequest(openaiRequest) {
    if (!openaiRequest || typeof openaiRequest !== 'object') {
      throw this.createHttpError('请求体必须是 JSON 对象', 400, 'invalid_request_error');
    }

    if (openaiRequest.prompt === undefined || openaiRequest.prompt === null) {
      throw this.createHttpError('prompt 不能为空', 400, 'invalid_request_error', {
        param: 'prompt'
      });
    }

    const nValue = openaiRequest.n === undefined ? 1 : Number.parseInt(openaiRequest.n, 10);
    if (!Number.isFinite(nValue) || Number.isNaN(nValue) || nValue < 1) {
      throw this.createHttpError('n 必须是大于等于 1 的整数', 400, 'invalid_request_error', {
        param: 'n'
      });
    }
    if (nValue > 1) {
      throw this.createHttpError('当前后端仅支持 n=1', 400, 'invalid_request_error', {
        param: 'n',
        code: 'unsupported_parameter'
      });
    }

    if (openaiRequest.best_of !== undefined) {
      const bestOf = Number.parseInt(openaiRequest.best_of, 10);
      if (!Number.isFinite(bestOf) || Number.isNaN(bestOf) || bestOf < 1) {
        throw this.createHttpError('best_of 必须是大于等于 1 的整数', 400, 'invalid_request_error', {
          param: 'best_of'
        });
      }
      if (bestOf > 1) {
        throw this.createHttpError('当前后端暂不支持 best_of>1', 400, 'invalid_request_error', {
          param: 'best_of',
          code: 'unsupported_parameter'
        });
      }
    }

    if (openaiRequest.suffix !== undefined && openaiRequest.suffix !== null && String(openaiRequest.suffix) !== '') {
      throw this.createHttpError('当前后端暂不支持 suffix 参数', 400, 'invalid_request_error', {
        param: 'suffix',
        code: 'unsupported_parameter'
      });
    }

    if (openaiRequest.stream === true && openaiRequest.echo === true) {
      throw this.createHttpError('stream=true 时暂不支持 echo=true', 400, 'invalid_request_error', {
        param: 'echo',
        code: 'unsupported_parameter'
      });
    }
  }

  normalizeTextContent(content) {
    if (typeof content === 'string') {
      return content;
    }
    if (content === null || content === undefined) {
      return '';
    }
    return String(content);
  }

  normalizeMessageContent(content, contentType) {
    if (Array.isArray(content)) {
      const normalized = content.map((part) => {
        if (!part || typeof part !== 'object') {
          return { type: contentType, text: this.normalizeTextContent(part) };
        }

        if (part.type === 'text') {
          return { type: contentType, text: this.normalizeTextContent(part.text) };
        }

        if (part.type === 'image_url') {
          return {
            type: 'input_image',
            image_url: part.image_url?.url || part.image_url || ''
          };
        }

        return part;
      });

      return normalized.length > 0 ? normalized : [{ type: contentType, text: '' }];
    }

    return [{ type: contentType, text: this.normalizeTextContent(content) }];
  }

  normalizeResponsesInput(input) {
    if (Array.isArray(input)) {
      return input.length > 0
        ? input
        : [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '' }]
        }];
    }

    if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
      return [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: this.normalizeTextContent(input) }]
      }];
    }

    if (input && typeof input === 'object') {
      if (input.type) {
        return [input];
      }

      return [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: JSON.stringify(input) }]
      }];
    }

    return [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '' }]
    }];
  }

  normalizeCompletionPrompt(prompt) {
    if (typeof prompt === 'string') {
      return prompt;
    }

    if (typeof prompt === 'number' || typeof prompt === 'boolean') {
      return String(prompt);
    }

    if (Array.isArray(prompt)) {
      return prompt
        .map((item) => {
          if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
            return String(item);
          }
          if (Array.isArray(item)) {
            return item.map((token) => this.normalizeTextContent(token)).join(' ');
          }
          if (item && typeof item === 'object') {
            return JSON.stringify(item);
          }
          return '';
        })
        .join('\n');
    }

    if (prompt && typeof prompt === 'object') {
      return JSON.stringify(prompt);
    }

    return '';
  }

  applyCommonOptionalParams(source, target) {
    if (!source || typeof source !== 'object') {
      return;
    }

    const maxTokens = source.max_tokens ?? source.max_completion_tokens ?? source.max_output_tokens;
    if (maxTokens !== undefined) {
      target.max_tokens = maxTokens;
    }

    const passthroughFields = [
      'temperature',
      'top_p',
      'stop',
      'presence_penalty',
      'frequency_penalty',
      'response_format',
      'tools',
      'tool_choice',
      'parallel_tool_calls',
      'reasoning',
      'metadata',
      'user',
      'seed',
      'stream_options'
    ];

    for (const field of passthroughFields) {
      if (source[field] !== undefined) {
        target[field] = source[field];
      }
    }
  }

  normalizeModelName(model) {
    let normalized = typeof model === 'string' ? model : '';
    normalized = normalized
      .replace(ANSI_ESCAPE_SEQUENCE_REGEX, '')
      .replace(CONTROL_CHAR_REGEX, '')
      .trim();

    // 一些客户端会遗留纯文本后缀（例如 [1m）
    normalized = normalized.replace(TRAILING_ANSI_MARKER_REGEX, '').trim();

    return normalized || getDefaultCodexModel();
  }

  /**
   * 转换 OpenAI 格式请求到 Codex 格式
   */
  transformRequest(openaiRequest) {
    const { model, messages, stream = true, ...rest } = openaiRequest;
    const normalizedModel = this.normalizeModelName(model);

    // 提取 system 消息作为 instructions
    let instructions = '';
    const userMessages = [];

    for (const msg of messages) {
      const role = msg?.role;
      if (!role) {
        continue;
      }

      if (role === 'system') {
        const instructionText = Array.isArray(msg.content)
          ? msg.content.map((part) => this.normalizeTextContent(part?.text ?? part)).join('\n')
          : this.normalizeTextContent(msg.content);
        instructions += (instructions ? '\n' : '') + instructionText;
      } else {
        userMessages.push(msg);
      }
    }

    // 转换消息格式
    const input = userMessages.map((msg) => {
      const contentType = msg.role === 'assistant' ? 'output_text' : 'input_text';

      return {
        type: 'message',
        role: msg.role,
        content: this.normalizeMessageContent(msg.content, contentType)
      };
    });

    const codexRequest = {
      model: normalizedModel,
      input,
      instructions: instructions || '',
      stream,
      store: false // 必须设置为 false
    };

    this.applyCommonOptionalParams(rest, codexRequest);

    return codexRequest;
  }

  /**
   * 转换 Responses API 请求到 Codex 格式
   */
  transformResponsesRequest(openaiRequest) {
    const {
      model,
      input,
      messages,
      stream = false,
      ...rest
    } = openaiRequest;
    const normalizedModel = this.normalizeModelName(model);

    // 兼容部分客户端只会发送 chat-completions 的 messages 字段
    if (Array.isArray(messages) && messages.length > 0) {
      const chatCompatibleRequest = {
        ...rest,
        model: normalizedModel,
        messages,
        stream
      };

      return this.transformRequest(chatCompatibleRequest);
    }

    const codexRequest = {
      model: normalizedModel,
      input: this.normalizeResponsesInput(input),
      stream: stream === true,
      store: false
    };

    this.applyCommonOptionalParams(rest, codexRequest);

    return codexRequest;
  }

  /**
   * 转换 Completions API 请求到 Codex 格式
   */
  transformCompletionsRequest(openaiRequest) {
    const {
      model,
      prompt,
      stream = false,
      ...rest
    } = openaiRequest;
    const normalizedModel = this.normalizeModelName(model);
    const normalizedPrompt = this.normalizeCompletionPrompt(prompt);

    const codexRequest = {
      model: normalizedModel,
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: normalizedPrompt }]
      }],
      stream: stream === true,
      store: false
    };

    this.applyCommonOptionalParams(rest, codexRequest);

    return codexRequest;
  }

  /**
   * 解析并转换单行 SSE 数据
   */
  transformStreamLine(line, fallbackModel, state) {
    const trimmed = line.toString().trim();
    if (!trimmed.startsWith('data:')) {
      return null;
    }

    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') {
      if (data === '[DONE]') {
        state.doneEmitted = true;
      }
      return 'data: [DONE]\n\n';
    }

    try {
      const parsed = JSON.parse(data);
      const now = Math.floor(Date.now() / 1000);

      if (parsed.type === 'response.created') {
        state.responseId = parsed.response?.id;
        state.createdAt = parsed.response?.created_at || now;
        state.model = parsed.response?.model || fallbackModel;
        return null;
      }

      const failure = this.extractStreamFailure(parsed);
      if (failure) {
        state.failed = true;
        state.errorMessage = failure.message;
        state.errorStatusCode = failure.statusCode;
        return null;
      }

      const responseId = state.responseId || `chatcmpl-${Date.now()}`;
      const createdAt = state.createdAt || now;
      const modelName = state.model || fallbackModel;

      if (parsed.type === 'response.output_text.delta') {
        return `data: ${JSON.stringify({
          id: responseId,
          object: 'chat.completion.chunk',
          created: createdAt,
          model: modelName,
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: parsed.delta || '' },
            finish_reason: null
          }]
        })}\n\n`;
      }

      if (parsed.type === 'response.reasoning_summary_text.delta') {
        return `data: ${JSON.stringify({
          id: responseId,
          object: 'chat.completion.chunk',
          created: createdAt,
          model: modelName,
          choices: [{
            index: 0,
            delta: { role: 'assistant', reasoning_content: parsed.delta || '' },
            finish_reason: null
          }]
        })}\n\n`;
      }

      if (parsed.type === 'response.completed') {
        state.completed = true;
        const usage = parsed.response?.usage || {};
        return `data: ${JSON.stringify({
          id: parsed.response?.id || responseId,
          object: 'chat.completion.chunk',
          created: parsed.response?.created_at || now,
          model: parsed.response?.model || modelName,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: usage.total_tokens || 0
          }
        })}\n\n`;
      }
    } catch {
      // 忽略不完整或非 JSON 行
      return null;
    }

    return null;
  }

  /**
   * 解析并转换 Completions API 的 SSE 数据
   */
  transformCompletionsStreamLine(line, fallbackModel, state) {
    const trimmed = line.toString().trim();
    if (!trimmed.startsWith('data:')) {
      return null;
    }

    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') {
      if (data === '[DONE]') {
        state.doneEmitted = true;
      }
      return 'data: [DONE]\n\n';
    }

    try {
      const parsed = JSON.parse(data);
      const now = Math.floor(Date.now() / 1000);

      if (parsed.type === 'response.created') {
        state.responseId = parsed.response?.id;
        state.createdAt = parsed.response?.created_at || now;
        state.model = parsed.response?.model || fallbackModel;
        return null;
      }

      const failure = this.extractStreamFailure(parsed);
      if (failure) {
        state.failed = true;
        state.errorMessage = failure.message;
        state.errorStatusCode = failure.statusCode;
        return null;
      }

      const responseId = state.responseId || `cmpl-${Date.now()}`;
      const createdAt = state.createdAt || now;
      const modelName = state.model || fallbackModel;

      if (parsed.type === 'response.output_text.delta') {
        return `data: ${JSON.stringify({
          id: responseId,
          object: 'text_completion',
          created: createdAt,
          model: modelName,
          choices: [{
            text: parsed.delta || '',
            index: 0,
            logprobs: null,
            finish_reason: null
          }]
        })}\n\n`;
      }

      if (parsed.type === 'response.completed') {
        state.completed = true;
        const usage = parsed.response?.usage || {};
        return `data: ${JSON.stringify({
          id: parsed.response?.id || responseId,
          object: 'text_completion',
          created: parsed.response?.created_at || now,
          model: parsed.response?.model || modelName,
          choices: [{
            text: '',
            index: 0,
            logprobs: null,
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: usage.total_tokens || 0
          }
        })}\n\n`;
      }
    } catch {
      return null;
    }

    return null;
  }

  /**
   * 解析并透传 Responses API 的 SSE 行
   */
  transformResponsesStreamLine(line, state) {
    const trimmed = line.toString().trim();
    if (!trimmed.startsWith('data:')) {
      return null;
    }

    const data = trimmed.slice(5).trim();
    if (!data) {
      return null;
    }

    if (data === '[DONE]') {
      state.doneEmitted = true;
      return 'data: [DONE]\n\n';
    }

    try {
      const parsed = JSON.parse(data);
      const failure = this.extractStreamFailure(parsed);
      if (failure) {
        state.failed = true;
        state.errorMessage = failure.message;
        state.errorStatusCode = failure.statusCode;
      }
      if (parsed.type === 'response.completed') {
        state.completed = parsed;
      }
      return `data: ${JSON.stringify(parsed)}\n\n`;
    } catch {
      // 兼容上游偶发非 JSON 文本行，直接透传
      return `data: ${data}\n\n`;
    }
  }

  /**
   * 转换 Codex 非流式响应到 OpenAI 格式
   */
  extractResponseOutputText(response) {
    const output = Array.isArray(response?.output) ? response.output : [];
    let content = '';

    for (const item of output) {
      if (item?.type !== 'message' || !Array.isArray(item.content)) {
        continue;
      }

      for (const part of item.content) {
        if (part?.type === 'output_text' || part?.type === 'text') {
          content += this.normalizeTextContent(part.text);
        }
      }
    }

    return content;
  }

  transformNonStreamResponse(codexResponse, model) {
    try {
      const response = codexResponse?.response || codexResponse || {};
      const content = this.extractResponseOutputText(response);

      const usage = response.usage || {};

      return {
        id: response.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: response.created_at || Math.floor(Date.now() / 1000),
        model: response.model || model || getDefaultCodexModel(),
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: usage.input_tokens || 0,
          completion_tokens: usage.output_tokens || 0,
          total_tokens: usage.total_tokens || 0
        }
      };
    } catch (error) {
      throw this.createHttpError(`转换响应失败: ${error.message}`, 500);
    }
  }

  transformNonStreamCompletionResponse(codexResponse, model, options = {}) {
    try {
      const response = codexResponse?.response || codexResponse || {};
      const usage = response.usage || {};
      const promptText = options.promptText || '';
      const completionText = this.extractResponseOutputText(response);
      const text = options.echo === true ? `${promptText}${completionText}` : completionText;

      return {
        id: response.id || `cmpl-${Date.now()}`,
        object: 'text_completion',
        created: response.created_at || Math.floor(Date.now() / 1000),
        model: response.model || model || getDefaultCodexModel(),
        choices: [{
          text,
          index: 0,
          logprobs: null,
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: usage.input_tokens || 0,
          completion_tokens: usage.output_tokens || 0,
          total_tokens: usage.total_tokens || 0
        }
      };
    } catch (error) {
      throw this.createHttpError(`转换 completions 响应失败: ${error.message}`, 500);
    }
  }

  transformNonStreamResponsesResponse(completedEvent, model) {
    const response = completedEvent?.response || {};
    const usage = response.usage || {};
    const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
    const outputTokens = usage.output_tokens || usage.completion_tokens || 0;

    return {
      id: response.id || `resp_${Date.now()}`,
      object: 'response',
      created_at: response.created_at || Math.floor(Date.now() / 1000),
      model: response.model || model || getDefaultCodexModel(),
      status: response.status || 'completed',
      output: Array.isArray(response.output) ? response.output : [],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: usage.total_tokens || (inputTokens + outputTokens)
      }
    };
  }

  /**
   * 从 SSE 文本中提取 response.completed 事件
   */
  extractCompletedEvent(payload) {
    if (!payload) {
      return null;
    }

    if (typeof payload === 'object') {
      if (payload.type === 'response.completed') {
        return payload;
      }
      if (payload.response) {
        return { type: 'response.completed', response: payload.response };
      }
      return null;
    }

    if (typeof payload !== 'string') {
      return null;
    }

    const lines = payload.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }

      const raw = trimmed.slice(5).trim();
      if (!raw || raw === '[DONE]') {
        continue;
      }

      try {
        const parsed = JSON.parse(raw);
        if (parsed.type === 'response.completed') {
          return parsed;
        }
      } catch {
        // 忽略解析失败
      }
    }

    return null;
  }

  /**
   * 处理流式请求
   */
  async handleStreamRequest(req, res) {
    this.validateRequest(req.body);
    const openaiRequest = req.body;
    const codexRequest = this.transformRequest(openaiRequest);
    const accessToken = await this.tokenManager.getValidToken();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const response = await this.httpClient.post('/responses', codexRequest, {
        headers: this.createHeaders(accessToken, true),
        responseType: 'stream'
      });

      const state = {};

      await new Promise((resolve, reject) => {
        let buffer = '';
        let streamClosed = false;

        const onStreamError = (error) => {
          if (streamClosed) {
            return;
          }
          streamClosed = true;
          reject(error);
        };

        response.data.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) {
              continue;
            }
            const transformed = this.transformStreamLine(line, codexRequest.model, state);
            if (transformed) {
              res.write(transformed);
            }
          }
        });

        response.data.on('end', () => {
          if (streamClosed) {
            return;
          }
          streamClosed = true;

          if (buffer.trim()) {
            const transformed = this.transformStreamLine(buffer, codexRequest.model, state);
            if (transformed) {
              res.write(transformed);
            }
          }

          if (!state.doneEmitted) {
            res.write('data: [DONE]\n\n');
          }
          res.end();
          resolve();
        });

        response.data.on('error', onStreamError);
      });

      // 识别上游在 SSE 内返回的失败事件，避免被误记为成功调用
      if (state.failed) {
        throw this.createHttpError(state.errorMessage || '流式响应失败', state.errorStatusCode || 502);
      }
    } catch (error) {
      const statusCode = Number.parseInt(error?.response?.status, 10) || error.statusCode || 502;
      const errorMessage = this.extractErrorMessage(error);
      console.error('流式代理请求失败:', errorMessage);
      if (!res.writableEnded) {
        res.end();
      }
      throw this.createHttpError(errorMessage, statusCode);
    }
  }

  /**
   * 处理非流式请求
   */
  async handleNonStreamRequest(req, res) {
    this.validateRequest(req.body);
    const openaiRequest = req.body;
    const codexRequest = this.transformRequest({ ...openaiRequest, stream: false });
    const accessToken = await this.tokenManager.getValidToken();

    try {
      const response = await this.httpClient.post('/responses', codexRequest, {
        headers: this.createHeaders(accessToken),
        responseType: 'text'
      });

      const finalResponse = this.extractCompletedEvent(response.data);
      if (!finalResponse) {
        throw this.createHttpError('未收到完整响应', 502);
      }

      const transformed = this.transformNonStreamResponse(finalResponse, codexRequest.model);
      res.json(transformed);
    } catch (error) {
      const statusCode = Number.parseInt(error?.response?.status, 10) || error.statusCode || 500;
      const errorMessage = this.extractErrorMessage(error);
      console.error('非流式代理请求失败:', errorMessage);
      throw this.createHttpError(errorMessage, statusCode);
    }
  }

  /**
   * 处理 Responses API 请求
   */
  async handleResponsesRequest(req, res) {
    this.validateResponsesRequest(req.body);
    const openaiRequest = req.body;
    const codexRequest = this.transformResponsesRequest(openaiRequest);
    const accessToken = await this.tokenManager.getValidToken();

    if (codexRequest.stream === true) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
    }

    try {
      if (codexRequest.stream === true) {
        const response = await this.httpClient.post('/responses', codexRequest, {
          headers: this.createHeaders(accessToken, true),
          responseType: 'stream'
        });

        const state = {};

        await new Promise((resolve, reject) => {
          let buffer = '';
          let streamClosed = false;

          const onStreamError = (error) => {
            if (streamClosed) {
              return;
            }
            streamClosed = true;
            reject(error);
          };

          response.data.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) {
                continue;
              }
              const transformed = this.transformResponsesStreamLine(line, state);
              if (transformed) {
                res.write(transformed);
              }
            }
          });

          response.data.on('end', () => {
            if (streamClosed) {
              return;
            }
            streamClosed = true;

            if (buffer.trim()) {
              const transformed = this.transformResponsesStreamLine(buffer, state);
              if (transformed) {
                res.write(transformed);
              }
            }

            if (!state.doneEmitted) {
              res.write('data: [DONE]\n\n');
            }
            res.end();
            resolve();
          });

          response.data.on('error', onStreamError);
        });

        // 上游可能以 SSE 事件返回失败；此处显式转为失败，避免日志统计为成功
        if (state.failed) {
          throw this.createHttpError(state.errorMessage || 'Responses 流式响应失败', state.errorStatusCode || 502);
        }

        return null;
      }

      // Codex 可能返回 SSE 文本，即使 stream=false，因此统一提取 completed 事件
      const response = await this.httpClient.post('/responses', codexRequest, {
        headers: this.createHeaders(accessToken),
        responseType: 'text'
      });

      const completedEvent = this.extractCompletedEvent(response.data);
      if (!completedEvent) {
        throw this.createHttpError('未收到完整响应', 502);
      }

      const transformed = this.transformNonStreamResponsesResponse(completedEvent, codexRequest.model);
      res.json(transformed);
      return transformed;
    } catch (error) {
      const statusCode = Number.parseInt(error?.response?.status, 10) || error.statusCode || 500;
      const errorMessage = this.extractErrorMessage(error);
      console.error('Responses 代理请求失败:', errorMessage);

      if (codexRequest.stream === true && !res.writableEnded) {
        res.end();
      }

      throw this.createHttpError(errorMessage, statusCode);
    }
  }

  /**
   * 处理 Completions API 请求（legacy）
   */
  async handleCompletionsRequest(req, res, forcedModel = null) {
    const mergedRequest = {
      ...(req.body || {}),
      model: req.body?.model || forcedModel || getDefaultCodexModel()
    };

    this.validateCompletionsRequest(mergedRequest);

    const codexRequest = this.transformCompletionsRequest(mergedRequest);
    const promptText = this.normalizeCompletionPrompt(mergedRequest.prompt);
    const accessToken = await this.tokenManager.getValidToken();

    if (codexRequest.stream === true) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
    }

    try {
      if (codexRequest.stream === true) {
        const response = await this.httpClient.post('/responses', codexRequest, {
          headers: this.createHeaders(accessToken, true),
          responseType: 'stream'
        });

        const state = {};

        await new Promise((resolve, reject) => {
          let buffer = '';
          let streamClosed = false;

          const onStreamError = (error) => {
            if (streamClosed) {
              return;
            }
            streamClosed = true;
            reject(error);
          };

          response.data.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) {
                continue;
              }
              const transformed = this.transformCompletionsStreamLine(line, codexRequest.model, state);
              if (transformed) {
                res.write(transformed);
              }
            }
          });

          response.data.on('end', () => {
            if (streamClosed) {
              return;
            }
            streamClosed = true;

            if (buffer.trim()) {
              const transformed = this.transformCompletionsStreamLine(buffer, codexRequest.model, state);
              if (transformed) {
                res.write(transformed);
              }
            }

            if (!state.doneEmitted) {
              res.write('data: [DONE]\n\n');
            }
            res.end();
            resolve();
          });

          response.data.on('error', onStreamError);
        });

        if (state.failed) {
          throw this.createHttpError(state.errorMessage || 'Completions 流式响应失败', state.errorStatusCode || 502);
        }

        return null;
      }

      const response = await this.httpClient.post('/responses', codexRequest, {
        headers: this.createHeaders(accessToken),
        responseType: 'text'
      });

      const completedEvent = this.extractCompletedEvent(response.data);
      if (!completedEvent) {
        throw this.createHttpError('未收到完整响应', 502);
      }

      const transformed = this.transformNonStreamCompletionResponse(
        completedEvent,
        codexRequest.model,
        {
          promptText,
          echo: mergedRequest.echo === true
        }
      );
      res.json(transformed);
      return transformed;
    } catch (error) {
      const statusCode = Number.parseInt(error?.response?.status, 10) || error.statusCode || 500;
      const errorMessage = this.extractErrorMessage(error);
      console.error('Completions 代理请求失败:', errorMessage);

      if (codexRequest.stream === true && !res.writableEnded) {
        res.end();
      }

      throw this.createHttpError(errorMessage, statusCode);
    }
  }
}

export default ProxyHandler;
