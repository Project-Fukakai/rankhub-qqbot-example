import { QQApiError, readBusinessCode, readBusinessMessage } from './errors.js';

export interface HttpRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** 以 JSON 序列化发送的 body（自动设置 content-type）。 */
  json?: unknown;
  /** 原始 body（二进制 PUT / multipart 等），与 json 互斥。 */
  body?: BodyInit;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  text: string;
  json: unknown;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export function parseJsonSafe(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let body: BodyInit | undefined = options.body;
  if (options.json !== undefined) {
    if (headers['content-type'] === undefined && headers['Content-Type'] === undefined) {
      headers['content-type'] = 'application/json';
    }
    body = JSON.stringify(options.json);
  }

  let response: Response;
  try {
    response = await fetchImpl(options.url, {
      method: options.method ?? 'GET',
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new QQApiError(`请求 ${redactUrl(options.url)} 失败：${describeFetchError(error)}`, {
      cause: error,
    });
  }

  const text = await response.text();
  return { status: response.status, ok: response.ok, text, json: parseJsonSafe(text) };
}

/**
 * 校验「HTTP 状态 + 业务 code」两种错误，成功时返回解析后的响应体。
 *
 * 注意：QQ 的 access token 接口在成功时不返回 code 字段，失败时却是
 * HTTP 200 + code（例如 100016），所以不能只看 HTTP 状态。
 */
export function assertBusinessOk(response: HttpResponse, label: string): unknown {
  const code = readBusinessCode(response.json);

  if (!response.ok) {
    throw new QQApiError(`${label}失败（HTTP ${response.status}${code === null ? '' : `，code=${code}`}）`, {
      code,
      status: response.status,
      body: response.json,
    });
  }

  if (code !== null && code !== 0) {
    const message = readBusinessMessage(response.json);
    throw new QQApiError(
      `${label}失败（code=${code}${message === null ? '' : `：${message}`}）`,
      { code, status: response.status, body: response.json },
    );
  }

  return response.json;
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) return `${error.message}（${cause.message}）`;
    return error.message;
  }
  return String(error);
}

/** 日志/错误信息里去掉 query，避免把预签名 URL 的凭证带进日志。 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    const index = url.indexOf('?');
    return index === -1 ? url : url.slice(0, index);
  }
}
