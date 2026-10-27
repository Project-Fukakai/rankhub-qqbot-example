/** 单条文本消息的安全上限（中文按字符数粗略估计，留出协议开销余量）。 */
export const DEFAULT_TEXT_CHUNK_SIZE = 1500;

/**
 * 按「字符」（Unicode 码点）切分文本，避免把 emoji/生僻字的代理对切成两半。
 *
 * 空串返回空数组（调用方据此跳过发送）。
 */
export function splitText(text: string, limit: number = DEFAULT_TEXT_CHUNK_SIZE): string[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`文本切分长度必须是正整数，收到 ${String(limit)}`);
  }
  if (text.length === 0) return [];

  const points = Array.from(text);
  if (points.length <= limit) return [text];

  const chunks: string[] = [];
  for (let index = 0; index < points.length; index += limit) {
    chunks.push(points.slice(index, index + limit).join(''));
  }
  return chunks;
}
