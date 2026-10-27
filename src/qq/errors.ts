/**
 * QQ 传输层错误类型。
 *
 * 官方 API 的错误有两层：
 * - HTTP 状态码（非 2xx）；
 * - HTTP 200 + body.code（业务错误，例如 100016 = appid/secret 无效）。
 * 两者都归一成 QQApiError，`code` 保留原始业务码，`status` 保留 HTTP 状态。
 */
export class QQApiError extends Error {
  readonly code: number | null;
  readonly status: number;
  readonly body: unknown;

  constructor(
    message: string,
    options: { code?: number | null; status?: number; body?: unknown; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'QQApiError';
    this.code = options.code ?? null;
    this.status = options.status ?? 0;
    this.body = options.body;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** 网关协议层错误（握手 / READY / 会话失效等）。 */
export class QQGatewayError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'QQGatewayError';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** 从响应体里读取业务错误码：兼容 number / 数字字符串；没有 code 字段返回 null。 */
export function readBusinessCode(body: unknown): number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>).code;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return null;
}

/** 从响应体里读取错误描述（不同接口字段名不一致）。 */
export function readBusinessMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  for (const key of ['message', 'msg', 'err_msg'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
