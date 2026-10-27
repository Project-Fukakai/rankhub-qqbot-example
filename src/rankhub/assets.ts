/**
 * 名片素材下载：只允许 http(s)，带超时与体积上限，失败返回 null（名片降级为无图，不报错）。
 *
 * 素材 URL 来自 RankHub v1 API（头像 / 背景板 / 曲绘），域名不固定，所以这里不维护白名单；
 * 安全边界是"只下载图片、限大小、限时"，而不是"只信任某个域"。
 */
export interface FetchImageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;

/** 下载单张图片；非 http(s)、非图片、超限、超时都返回 null。 */
export async function fetchImage(
  url: string | null | undefined,
  options: FetchImageOptions = {},
): Promise<Buffer | null> {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(trimmed, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;
    const length = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > maxBytes) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > maxBytes) return null;
    return buffer;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 并发下载多张图片（保持输入顺序；失败项为 null）。 */
export async function fetchImages(
  urls: (string | null | undefined)[],
  options: FetchImageOptions = {},
): Promise<(Buffer | null)[]> {
  return Promise.all(urls.map((url) => fetchImage(url, options)));
}
