/**
 * Arcaea 曲名目录（id → 标题），对齐 App 的数据来源。
 *
 * App 的曲名取自官方 `songlist.json`（`ArcaeaResourceIndex`，字段 `title_localized.en`），
 * RankHub 后端把同一份资源公开在 `GET {RANKHUB_API_BASE}/v0/games/arcaea/resources/songlist`
 * （`apps/backend/src/arcaea-resources/arcaea-resources.controller.ts:14-18`，无需鉴权，实测 200）。
 *
 * 为什么要它：v1 的 arcaea 成绩只有 `songId`，没有 `songName`（`arcaea.adapter.ts` 的
 * `buildScore` 未带 songName），而本地 best-posters 索引只覆盖部分曲目 —— 不查目录就会
 * 显示 `TRACK n`。目录按 id 精确映射，命中率 100%（含新曲）。
 */
import type { Logger } from '../logger/index.js';

const SONGLIST_PATH = '/v0/games/arcaea/resources/songlist';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ArcaeaSongTitles {
  /** `song_id` → 展示标题。 */
  titles: Map<string, string>;
  fetchedAt: number;
}

interface RawSong {
  id?: unknown;
  title_localized?: unknown;
}

/** 从 songlist JSON 里提取 id → 标题（`title_localized.en`，缺失时回落到其它语言/ id）。 */
export function parseSongTitles(payload: unknown): Map<string, string> {
  const titles = new Map<string, string>();
  const songs = (payload as { songs?: unknown } | null)?.songs;
  if (!Array.isArray(songs)) return titles;
  for (const raw of songs) {
    if (raw === null || typeof raw !== 'object') continue;
    const song = raw as RawSong;
    const id = typeof song.id === 'string' ? song.id.trim() : '';
    if (id === '') continue;
    const localized = song.title_localized;
    let title: string | null = null;
    if (localized !== null && typeof localized === 'object') {
      const record = localized as Record<string, unknown>;
      for (const key of ['en', 'ja', 'zh-Hans', 'zh-Hant', 'ko']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim() !== '') {
          title = value.trim();
          break;
        }
      }
    }
    titles.set(id, title ?? id);
  }
  return titles;
}

/** 拉一次曲名目录；失败返回空 map（渲染层回落到本地索引 / TRACK n）。 */
export async function fetchArcaeaSongTitles(options: {
  apiBase: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Map<string, string>> {
  const url = `${options.apiBase.replace(/\/+$/, '')}${SONGLIST_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { signal: controller.signal });
    if (!response.ok) {
      options.logger?.warn('Arcaea 曲名目录拉取失败', { status: response.status });
      return new Map();
    }
    return parseSongTitles(await response.json());
  } catch (error) {
    options.logger?.warn('Arcaea 曲名目录拉取异常', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

/** 进程内缓存（曲名目录一天更新一次足够）。 */
export class ArcaeaSongTitleCache {
  private current: ArcaeaSongTitles | null = null;
  private inflight: Promise<ArcaeaSongTitles> | null = null;

  constructor(
    private readonly loader: () => Promise<Map<string, string>>,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<ArcaeaSongTitles> {
    const current = this.current;
    if (current !== null && this.now() - current.fetchedAt < this.ttlMs) return current;
    if (this.inflight !== null) return this.inflight;
    this.inflight = (async () => {
      const titles = await this.loader();
      const value = { titles, fetchedAt: this.now() };
      // 空结果不覆盖已有缓存（网络抖动时保留旧目录）。
      if (titles.size > 0 || this.current === null) this.current = value;
      return this.current ?? value;
    })();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }
}
