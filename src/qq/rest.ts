import { createHash } from 'node:crypto';

import type { Logger } from '../logger/index.js';
import { QQApiError } from './errors.js';
import { assertBusinessOk, httpRequest, redactUrl, type HttpResponse } from './http.js';

/** 被动回复目标：群聊或单聊。 */
export type QQMessageTarget =
  | { kind: 'group'; openid: string }
  | { kind: 'c2c'; openid: string };

/**
 * `file_data` 的编码方式。
 *
 * 官方文档只写「二进制数据」，未说明 JSON 里如何承载；lead 会在 live 阶段实测。
 * - base64（默认）：JSON body 里放 base64 字符串；
 * - binary：multipart/form-data，file_data 作为二进制 part。
 */
export type FileDataEncoding = 'base64' | 'binary';

/** 超过 4.5MB 走分片上传。 */
export const DEFAULT_SHARD_THRESHOLD_BYTES = Math.floor(4.5 * 1024 * 1024);

/** prepare 的 `md5_10m`：文件前 10002432 字节的 MD5。 */
export const MD5_10M_PREFIX_BYTES = 10_002_432;

/** 单个分片 PUT 的默认重试次数（官方 upload_config.retry_timeout 语义未在实现中使用）。 */
export const DEFAULT_PART_RETRY_ATTEMPTS = 3;

export interface AccessTokenProvider {
  get(): Promise<string>;
  invalidate(): void;
}

export interface QQMessageAck {
  id: string | null;
  timestamp: string | null;
}

export interface UploadedFile {
  fileInfo: string;
}

export interface ShardUploadPaths {
  /** 1. 预上传：返回 upload_id / block_size / parts[].presigned_url。 */
  prepare(target: QQMessageTarget): string;
  /** 3. 每个分片 PUT 成功后的确认（按片调用）。 */
  partFinish(target: QQMessageTarget): string;
  /** 4. 带 upload_id 调 /files 合并成 file_info。 */
  files(target: QQMessageTarget): string;
}

/**
 * 分片上传路径。
 *
 * 官方规格（retrieved_at 2026-10-27）：
 * - 群聊预上传 POST /v2/groups/{group_id}/upload_prepare
 *   https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_id_upload_prepare.post.html
 * - 群聊分片完成 POST /v2/groups/{group_id}/upload_part_finish
 *   https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_id_upload_part_finish.post.html
 * - 单聊预上传 POST /v2/users/{user_id}/upload_prepare
 *   https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_id_upload_prepare.post.html
 * - 单聊分片完成 POST /v2/users/{user_id}/upload_part_finish
 *   https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_id_upload_part_finish.post.html
 * - 合并 POST /v2/{groups|users}/{openid}/files（群聊富媒体上传页）
 *
 * 注意：upload_prepare / upload_part_finish 不与 /files 同级，而是 /v2/{groups|users}/{openid}/ 下一级；
 * 路径参数官方写作 group_id / user_id，语义即 OpenID。
 */
export const DEFAULT_SHARD_UPLOAD_PATHS: ShardUploadPaths = {
  prepare: (target) => `${targetBasePath(target)}/upload_prepare`,
  partFinish: (target) => `${targetBasePath(target)}/upload_part_finish`,
  files: (target) => filesPath(target),
};

export interface QQRestOptions {
  apiBase: string;
  tokenProvider: AccessTokenProvider;
  logger: Logger;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  fileDataEncoding?: FileDataEncoding;
  shardThresholdBytes?: number;
  shardPaths?: ShardUploadPaths;
}

interface AuthorizedInit {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  label: string;
  retryOn401?: boolean;
}

interface ShardPart {
  index: number;
  url: string;
  blockSize: number;
}

interface PlannedShardPart {
  index: number;
  url: string;
  chunk: Buffer;
}

interface ShardRuntimeConfig {
  concurrency: number;
  retryDelayMs: number;
  retryAttempts: number;
}

/** QQ 官方 API v2 的 REST 封装（被动回复 + 富媒体）。 */
export class QQRESTClient {
  private readonly apiBase: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly timeoutMs: number;
  private readonly fileDataEncoding: FileDataEncoding;
  private readonly shardThresholdBytes: number;
  private readonly shardPaths: ShardUploadPaths;

  constructor(private readonly options: QQRestOptions) {
    this.apiBase = options.apiBase.replace(/\/+$/, '');
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.requestTimeoutMs ?? 15_000;
    this.fileDataEncoding = options.fileDataEncoding ?? 'base64';
    this.shardThresholdBytes = options.shardThresholdBytes ?? DEFAULT_SHARD_THRESHOLD_BYTES;
    this.shardPaths = options.shardPaths ?? DEFAULT_SHARD_UPLOAD_PATHS;
  }

  /** 发送文本消息（msg_type=0），被动回复带 msg_id + msg_seq。 */
  async sendText(
    target: QQMessageTarget,
    input: { content: string; messageId: string; messageSeq: number },
  ): Promise<QQMessageAck> {
    const json = await this.requestJson(this.messagePath(target), {
      method: 'POST',
      label: '发送 QQ 文本消息',
      json: {
        content: input.content,
        msg_type: 0,
        msg_id: input.messageId,
        msg_seq: input.messageSeq,
      },
    });
    return toAck(json);
  }

  /** 上传图片并发送（msg_type=7），同样占用该 msg_id 的一个 msg_seq。 */
  async sendImage(
    target: QQMessageTarget,
    input: { buffer: Buffer; filename: string; messageId: string; messageSeq: number },
  ): Promise<QQMessageAck> {
    const uploaded = await this.uploadFile(target, {
      buffer: input.buffer,
      filename: input.filename,
      fileType: 1,
    });

    const json = await this.requestJson(this.messagePath(target), {
      method: 'POST',
      label: '发送 QQ 图片消息',
      json: {
        msg_type: 7,
        media: { file_info: uploaded.fileInfo },
        msg_id: input.messageId,
        msg_seq: input.messageSeq,
      },
    });
    return toAck(json);
  }

  /** 上传文件（file_type=1 图片），返回 file_info。 */
  async uploadFile(
    target: QQMessageTarget,
    input: { buffer: Buffer; filename: string; fileType?: number },
  ): Promise<UploadedFile> {
    if (input.buffer.length === 0) {
      throw new QQApiError('上传 QQ 图片失败：图片内容为空');
    }
    const fileType = input.fileType ?? 1;
    if (input.buffer.length > this.shardThresholdBytes) {
      return this.uploadFileInParts(target, { ...input, fileType });
    }
    return this.uploadFileSingle(target, { ...input, fileType });
  }

  /**
   * 一次性上传（≤4.5MB）。
   *
   * `srv_send_msg` 固定 false：文件只上传，不当主动消息发出去（避免占用主动消息频次）。
   */
  private async uploadFileSingle(
    target: QQMessageTarget,
    input: { buffer: Buffer; filename: string; fileType: number },
  ): Promise<UploadedFile> {
    const baseFields: Record<string, unknown> = {
      file_type: input.fileType,
      file_name: input.filename,
      srv_send_msg: false,
    };

    let json: unknown;
    if (this.fileDataEncoding === 'base64') {
      json = await this.requestJson(this.shardPaths.files(target), {
        method: 'POST',
        label: '上传 QQ 图片',
        json: { ...baseFields, file_data: input.buffer.toString('base64') },
      });
    } else {
      const form = new FormData();
      form.append('file_type', String(input.fileType));
      form.append('file_name', input.filename);
      form.append('srv_send_msg', 'false');
      form.append('file_data', new Blob([new Uint8Array(input.buffer)]), input.filename);
      json = await this.requestJson(this.shardPaths.files(target), {
        method: 'POST',
        label: '上传 QQ 图片（binary）',
        body: form,
      });
    }

    const fileInfo = readFileInfo(json);
    if (fileInfo === null) {
      throw new QQApiError('上传 QQ 图片失败：响应缺少 file_info', { body: json });
    }
    this.logger.debug('QQ 图片上传完成', { bytes: input.buffer.length, encoding: this.fileDataEncoding });
    return { fileInfo };
  }

  /**
   * 分片上传（>4.5MB），按官方规格：
   * upload_prepare → 逐片 PUT 预签名 URL → 每片 upload_part_finish → 带 upload_id 调 /files 合并。
   *
   * 官方规格（retrieved_at 2026-10-27）：
   * - 群聊预上传/分片完成：/v2/groups/{group_id}/upload_prepare、/v2/groups/{group_id}/upload_part_finish
   *   https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_id_upload_prepare.post.html
   *   https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_id_upload_part_finish.post.html
   * - 单聊预上传/分片完成：/v2/users/{user_id}/upload_prepare、/v2/users/{user_id}/upload_part_finish
   *   https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_id_upload_prepare.post.html
   *   https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_id_upload_part_finish.post.html
   * - 合并：POST /v2/{groups|users}/{openid}/files
   *
   * 要点：
   * - prepare 的 file_size / block_size 是字符串；file_size 传字符串，md5_10m 是前 10002432 字节的 MD5；
   * - 分片大小以 parts[].block_size 为准（不自行按 4.5MB 切、不用顶层 block_size）；
   * - 并发 / 重试间隔取自 upload_config.concurrency / upload_config.retry_delay；
   * - part_finish 按片调用（part_index / block_size / md5，block_size 为该片实际字节数，字符串）；
   * - 合并体只需要 file_type / file_name / upload_id / srv_send_msg=false。
   */
  private async uploadFileInParts(
    target: QQMessageTarget,
    input: { buffer: Buffer; filename: string; fileType: number },
  ): Promise<UploadedFile> {
    const md5 = md5Hex(input.buffer);
    const sha1 = sha1Hex(input.buffer);
    const md5Of10m = md5Hex(input.buffer.subarray(0, MD5_10M_PREFIX_BYTES));

    const prepared = await this.requestJson(this.shardPaths.prepare(target), {
      method: 'POST',
      label: '申请 QQ 图片分片上传',
      json: {
        file_type: input.fileType,
        file_size: String(input.buffer.length),
        file_name: input.filename,
        md5,
        sha1,
        md5_10m: md5Of10m,
      },
    });

    const record = isRecord(prepared) ? prepared : {};
    const uploadId = typeof record.upload_id === 'string' ? record.upload_id : '';
    if (uploadId === '') {
      throw new QQApiError('申请 QQ 图片分片上传失败：响应缺少 upload_id', { body: prepared });
    }

    const parts = readShardParts(prepared, input.buffer.length);
    const { planned, coveredBytes } = planShardChunks(input.buffer, parts);
    if (planned.length === 0 || coveredBytes !== input.buffer.length) {
      throw new QQApiError('申请 QQ 图片分片上传失败：分片信息不完整', {
        body: prepared,
        status: 0,
      });
    }

    const config = readShardRuntimeConfig(prepared);
    this.logger.debug('QQ 图片分片上传开始', {
      bytes: input.buffer.length,
      parts: planned.length,
      concurrency: config.concurrency,
    });

    await runWithConcurrency(
      planned.map((part) => async () => {
        await this.putPartWithRetry(part.url, part.chunk, config);
        await this.requestJson(this.shardPaths.partFinish(target), {
          method: 'POST',
          label: '确认 QQ 图片分片上传',
          json: {
            upload_id: uploadId,
            part_index: part.index,
            block_size: String(part.chunk.length),
            md5: md5Hex(part.chunk),
          },
        });
      }),
      config.concurrency,
    );

    const merged = await this.requestJson(this.shardPaths.files(target), {
      method: 'POST',
      label: '合并 QQ 图片分片',
      json: {
        file_type: input.fileType,
        file_name: input.filename,
        upload_id: uploadId,
        srv_send_msg: false,
      },
    });

    const fileInfo = readFileInfo(merged);
    if (fileInfo === null) {
      throw new QQApiError('合并 QQ 图片分片失败：响应缺少 file_info', { body: merged });
    }

    this.logger.info('QQ 图片分片上传完成', {
      bytes: input.buffer.length,
      parts: planned.length,
      concurrency: config.concurrency,
    });
    return { fileInfo };
  }

  /** PUT 一个分片到预签名 URL（不加 Authorization，避免把 token 发给对象存储）。 */
  private async putPart(url: string, chunk: Buffer, timeoutMs: number): Promise<void> {
    const response = await httpRequest({
      url,
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      // Buffer<ArrayBufferLike> 与 DOM BodyInit 的 ArrayBuffer 约束不兼容，运行时等价。
      body: chunk as unknown as BodyInit,
      timeoutMs,
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });
    if (!response.ok) {
      throw new QQApiError(`上传 QQ 图片分片失败（HTTP ${response.status}）`, {
        status: response.status,
        body: response.json,
      });
    }
  }

  /** 分片 PUT 失败按 upload_config.retry_delay 退避重试。 */
  private async putPartWithRetry(
    url: string,
    chunk: Buffer,
    config: ShardRuntimeConfig,
  ): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= config.retryAttempts; attempt += 1) {
      try {
        await this.putPart(url, chunk, this.timeoutMs);
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= config.retryAttempts) break;
        this.logger.warn('QQ 图片分片上传失败，准备重试', {
          attempt,
          attempts: config.retryAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
        if (config.retryDelayMs > 0) await delay(config.retryDelayMs);
      }
    }
    throw lastError instanceof Error ? lastError : new QQApiError(String(lastError));
  }

  private messagePath(target: QQMessageTarget): string {
    return `${targetBasePath(target)}/messages`;
  }

  private async requestJson(path: string, init: AuthorizedInit): Promise<unknown> {
    const response = await this.authorized(path, init);
    return assertBusinessOk(response, init.label);
  }

  private async authorized(path: string, init: AuthorizedInit): Promise<HttpResponse> {
    const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${this.apiBase}${path}`;
    const headers: Record<string, string> = { ...(init.headers ?? {}) };

    const token = await this.options.tokenProvider.get();
    headers.authorization = `QQBot ${token}`;

    const response = await httpRequest({
      url,
      method: init.method ?? 'POST',
      headers,
      ...(init.json === undefined ? {} : { json: init.json }),
      ...(init.body === undefined ? {} : { body: init.body }),
      timeoutMs: this.timeoutMs,
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
    });

    if (response.status === 401 && init.retryOn401 !== false) {
      this.logger.warn('QQ REST 返回 401，刷新 AccessToken 后重试一次', { path: redactUrl(url) });
      this.options.tokenProvider.invalidate();
      return this.authorized(path, { ...init, retryOn401: false });
    }

    return response;
  }
}

function targetBasePath(target: QQMessageTarget): string {
  const openid = encodeURIComponent(target.openid);
  return target.kind === 'group' ? `/v2/groups/${openid}` : `/v2/users/${openid}`;
}

function filesPath(target: QQMessageTarget): string {
  return `${targetBasePath(target)}/files`;
}

function toAck(json: unknown): QQMessageAck {
  const record = isRecord(json) ? json : {};
  return {
    id: typeof record.id === 'string' ? record.id : null,
    timestamp:
      typeof record.timestamp === 'string'
        ? record.timestamp
        : typeof record.timestamp === 'number'
          ? String(record.timestamp)
          : null,
  };
}

function readFileInfo(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const value = json.file_info;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 解析 prepare 响应的分片列表。
 *
 * 官方形态：`parts: [{ index, presigned_url, block_size(字符串) }]`
 * （兼容早期实现里的 part_urls / url 字段与字符串元素）。
 */
function readShardParts(json: unknown, totalBytes: number): ShardPart[] {
  if (!isRecord(json)) return [];

  const collected: Array<{ index: number; url: string; blockSize: number | null }> = [];
  const raw = json.parts;

  if (Array.isArray(raw)) {
    for (let position = 0; position < raw.length; position += 1) {
      const item = raw[position];
      if (typeof item === 'string' && item !== '') {
        collected.push({ index: position, url: item, blockSize: null });
        continue;
      }
      if (!isRecord(item)) continue;
      const url =
        typeof item.presigned_url === 'string'
          ? item.presigned_url
          : typeof item.url === 'string'
            ? item.url
            : '';
      if (url === '') continue;
      collected.push({
        index: readInteger(item.index) ?? position,
        url,
        blockSize: readPositiveInteger(item.block_size),
      });
    }
  }

  if (collected.length === 0) {
    // 极早期实现只有 URL 列表；保留兼容，避免 prepare 形态变化时直接崩。
    readUrlList(json).forEach((url, position) => {
      collected.push({ index: position, url, blockSize: null });
    });
  }

  if (collected.length === 0) return [];

  const fallbackBlock =
    readPositiveInteger(json.block_size) ?? Math.max(1, Math.ceil(totalBytes / collected.length));

  return collected
    .map((part) => ({
      index: part.index,
      url: part.url,
      blockSize: part.blockSize ?? fallbackBlock,
    }))
    .sort((left, right) => left.index - right.index);
}

/** 按分片顺序切字节；返回实际覆盖的字节数供完整性校验。 */
function planShardChunks(
  buffer: Buffer,
  parts: ShardPart[],
): { planned: PlannedShardPart[]; coveredBytes: number } {
  const planned: PlannedShardPart[] = [];
  let offset = 0;

  for (const part of parts) {
    if (offset >= buffer.length) break;
    const end = Math.min(offset + part.blockSize, buffer.length);
    planned.push({ index: part.index, url: part.url, chunk: buffer.subarray(offset, end) });
    offset = end;
  }

  return { planned, coveredBytes: offset };
}

function readShardRuntimeConfig(json: unknown): ShardRuntimeConfig {
  const config =
    isRecord(json) && isRecord(json.upload_config) ? json.upload_config : {};
  return {
    concurrency: Math.min(8, Math.max(1, readPositiveInteger(config.concurrency) ?? 1)),
    retryDelayMs: Math.round((readNonNegativeNumber(config.retry_delay) ?? 0) * 1000),
    retryAttempts: DEFAULT_PART_RETRY_ATTEMPTS,
  };
}

function readUrlList(json: Record<string, unknown>): string[] {
  for (const key of ['part_urls', 'upload_urls', 'urls'] as const) {
    const value = json[key];
    if (!Array.isArray(value)) continue;
    const urls: string[] = [];
    for (const item of value) {
      if (typeof item === 'string' && item !== '') urls.push(item);
      else if (isRecord(item) && typeof item.url === 'string' && item.url !== '') urls.push(item.url);
    }
    if (urls.length > 0) return urls;
  }
  return [];
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), tasks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      const task = tasks[index];
      if (task !== undefined) await task();
    }
  });
  await Promise.all(workers);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function md5Hex(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

function sha1Hex(buffer: Buffer): string {
  return createHash('sha1').update(buffer).digest('hex');
}

function readInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  return null;
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
