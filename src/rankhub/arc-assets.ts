/**
 * Arcaea 曲绘（jacket）对齐 App：
 *
 * App 从资源索引按 `songs/<songId>/` 下挑图（`RankHub/lib/modules/arcaea/models/arcaea_models.dart:469-487`
 * 的 `_songJacket` / `_imagePriority`），资源地址经 `GameAssetsConfig.resolve('arcaea', '/asset/<path>')`
 * （`lib/config/game_assets_config.dart:5-20`），即：
 *
 *   https://static.rankhub.cc/arcaea/asset/songs/<songId>/base_256.jpg
 *
 * 首选顺序与 `_imagePriority` 一致：`base_256.jpg` → `1080_base_256.jpg` → `base.jpg` →
 * `1080_base.jpg` → 其它含 base 的图。`remote_dl` 歌曲目录带 `dl_` 前缀，这里两种都试。
 * 全部失败时返回 null，由渲染层回落到本地 best-posters 索引 / 占位图。
 */
import { fetchImage } from './assets.js';

/** RankHub 游戏资源 CDN（App `GameAssetsConfig.origin`）。 */
export const ARC_ASSET_ORIGIN = 'https://static.rankhub.cc';

const JACKET_FILES = ['base_256.jpg', '1080_base_256.jpg', 'base.jpg', '1080_base.jpg'] as const;

/** 按 App 的优先级给出某首歌的曲绘候选 URL。 */
export function arcaeaJacketCandidates(songId: string): string[] {
  const id = songId.trim();
  if (id === '') return [];
  // song id 是单一路径段：整体编码（含 `/` 也编码成 %2F），与 App 的 Uri.encodeComponent 一致。
  const dirs = [`songs/${encodeURIComponent(id)}`, `songs/${encodeURIComponent(`dl_${id}`)}`];
  const urls: string[] = [];
  for (const file of JACKET_FILES) {
    for (const dir of dirs) urls.push(`${ARC_ASSET_ORIGIN}/arcaea/asset/${dir}/${file}`);
  }
  return urls;
}

export interface PrefetchCoversOptions {
  concurrency?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** 总预算（毫秒）；超时后未完成的条目返回 null。 */
  budgetMs?: number;
  fetchImpl?: typeof fetch;
}

/** 逐首预取官方曲绘，返回 `songId → data URL`；抓不到的曲目不在 map 里。 */
export async function prefetchArcaeaCovers(
  songIds: readonly string[],
  options: PrefetchCoversOptions = {},
): Promise<Map<string, string>> {
  const unique = [...new Set(songIds.map((id) => id.trim()).filter((id) => id !== ''))];
  const result = new Map<string, string>();
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const deadline = Date.now() + (options.budgetMs ?? 15_000);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < unique.length) {
      const index = cursor;
      cursor += 1;
      const songId = unique[index]!;
      if (Date.now() > deadline) continue;
      for (const url of arcaeaJacketCandidates(songId)) {
        const buffer = await fetchImage(url, {
          timeoutMs: options.timeoutMs ?? 4_000,
          maxBytes: options.maxBytes ?? 3 * 1024 * 1024,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        });
        if (buffer !== null) {
          const mime = sniffImageMime(buffer);
          result.set(songId, `data:${mime};base64,${buffer.toString('base64')}`);
          break;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));
  return result;
}

function sniffImageMime(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF') {
    return 'image/webp';
  }
  return 'image/jpeg';
}
