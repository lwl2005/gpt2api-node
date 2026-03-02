import axios from 'axios';
import { randomUUID } from 'crypto';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_CLIENT_VERSION = '0.101.0';
const CODEX_USER_AGENT = 'codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464';
const REQUEST_TIMEOUT_MS = 300000;

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

  createHttpError(message, statusCode = 500) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  extractErrorMessage(error) {
    if (typeof error?.response?.data?.error?.message === 'string') {
      return error.response.data.error.message;
    }

    if (typeof error?.response?.data === 'string') {
      return error.response.data;
    }

    return error?.message || '代理请求失败';
  }

  /**
   * 校验 OpenAI 请求，尽早返回 4xx，避免无意义的上游请求
   */
  validateRequest(openaiRequest) {
    if (!openaiRequest || typeof openaiRequest !== 'object') {
      throw this.createHttpError('请求体必须是 JSON 对象', 400);
    }

    if (!Array.isArray(openaiRequest.messages) || openaiRequest.messages.length === 0) {
      throw this.createHttpError('messages 必须是非空数组', 400);
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

  /**
   * 转换 OpenAI 格式请求到 Codex 格式
   */
  transformRequest(openaiRequest) {
    const { model, messages, stream = true, stream_options, ...rest } = openaiRequest;

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
      model: model || 'gpt-5.3-codex',
      input,
      instructions: instructions || '',
      stream,
      store: false // 必须设置为 false
    };

    // 只保留 Codex 支持的参数
    if (rest.temperature !== undefined) codexRequest.temperature = rest.temperature;
    if (rest.max_tokens !== undefined) codexRequest.max_tokens = rest.max_tokens;
    if (rest.top_p !== undefined) codexRequest.top_p = rest.top_p;

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
   * 转换 Codex 非流式响应到 OpenAI 格式
   */
  transformNonStreamResponse(codexResponse, model) {
    try {
      const response = codexResponse?.response || codexResponse || {};
      const output = response.output || [];
      let content = '';

      for (const item of output) {
        if (item.type !== 'message' || !Array.isArray(item.content)) {
          continue;
        }
        for (const part of item.content) {
          if (part.type === 'output_text') {
            content += part.text || '';
          }
        }
      }

      const usage = response.usage || {};

      return {
        id: response.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: response.created_at || Math.floor(Date.now() / 1000),
        model: response.model || model || 'gpt-5.3-codex',
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
            const transformed = this.transformStreamLine(line, openaiRequest.model, state);
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
            const transformed = this.transformStreamLine(buffer, openaiRequest.model, state);
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

      const transformed = this.transformNonStreamResponse(finalResponse, openaiRequest.model);
      res.json(transformed);
    } catch (error) {
      const statusCode = Number.parseInt(error?.response?.status, 10) || error.statusCode || 500;
      const errorMessage = this.extractErrorMessage(error);
      console.error('非流式代理请求失败:', errorMessage);
      throw this.createHttpError(errorMessage, statusCode);
    }
  }
}

export default ProxyHandler;
