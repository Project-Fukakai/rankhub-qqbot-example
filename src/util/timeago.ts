/**
 * 相对时间：把时间戳/ISO 串转成「多久以前」。
 *
 * 两个出口：
 * - `formatTimeAgo()`：中文（`3 天前`），用于文字消息与名片副标题；
 * - `formatTimeAgoCompact()`：紧凑英文单位（`3d` / `5h` / `2mo`），用于海报窄列。
 *
 * 数据口径：接受毫秒时间戳、秒时间戳（< 1e12 视为秒）、ISO 字符串、`Date`；
 * 未来时间统一显示 `刚刚` / `0s`（不出现负数）。
 */

type TimeInput = string | number | Date | null | undefined;

function toMs(value: TimeInput): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // 秒级时间戳（< 1e12）换算成毫秒；毫秒时间戳直接使用。
    return value < 1e12 ? value * 1000 : value;
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

interface Bucket {
  seconds: number;
  zh: (n: number) => string;
  compact: string;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function bucketOf(seconds: number): Bucket {
  const n = Math.max(0, Math.floor(seconds));
  if (n < MINUTE) return { seconds: n, zh: (v) => `${v} 秒前`, compact: `${n}s` };
  if (n < HOUR) {
    const v = Math.floor(n / MINUTE);
    return { seconds: v, zh: (x) => `${x} 分钟前`, compact: `${v}m` };
  }
  if (n < DAY) {
    const v = Math.floor(n / HOUR);
    return { seconds: v, zh: (x) => `${x} 小时前`, compact: `${v}h` };
  }
  if (n < MONTH) {
    const v = Math.floor(n / DAY);
    return { seconds: v, zh: (x) => `${x} 天前`, compact: `${v}d` };
  }
  if (n < YEAR) {
    const v = Math.floor(n / MONTH);
    return { seconds: v, zh: (x) => `${x} 个月前`, compact: `${v}mo` };
  }
  const v = Math.floor(n / YEAR);
  return { seconds: v, zh: (x) => `${x} 年前`, compact: `${v}y` };
}

/** 中文相对时间；无法解析返回 null。 */
export function formatTimeAgo(value: TimeInput, now: number = Date.now()): string | null {
  const ms = toMs(value);
  if (ms === null) return null;
  const diff = (now - ms) / 1000;
  if (diff <= 0) return '刚刚';
  const bucket = bucketOf(diff);
  return bucket.zh(bucket.seconds);
}

/** 紧凑相对时间（`3d` / `5h` / `2mo`）；无法解析返回 null。 */
export function formatTimeAgoCompact(value: TimeInput, now: number = Date.now()): string | null {
  const ms = toMs(value);
  if (ms === null) return null;
  const diff = (now - ms) / 1000;
  if (diff <= 0) return '0s';
  return bucketOf(diff).compact;
}
