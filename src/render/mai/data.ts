/**
 * 曲目定数 / 满 DX 分索引（songId-levelIndex → level_value / maxDxScore）。
 *
 * 数据来源：https://maimai.lxns.net/api/v0/maimai/song/list?notes=true
 *   → scripts/fetch-assets-mai.mjs 裁剪后写入 vendor/mai/data.json
 *
 * 口径对齐 maimaiDX core/merge/__init__.py：dx_score = notes.total * 3；
 * song_id 约定：standard 用曲目 id，dx 用 id + 10000。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface MaiChartInfo {
  levelValue: number | null;
  /** 该难度满 DX 分（notes.total * 3）；缺 notes 时为 null。 */
  maxDxScore: number | null;
  level: string | null;
}

interface RawDifficulty {
  type?: string;
  difficulty?: number;
  level?: string | null;
  level_value?: number | null;
  notes_total?: number | null;
}

interface RawSong {
  id?: number;
  title?: string;
  difficulties?: RawDifficulty[];
}

interface RawData {
  songs?: RawSong[];
}

export class MaiSongData {
  private readonly byKey = new Map<string, MaiChartInfo>();
  private readonly titles = new Map<number, string>();
  readonly source: string;
  readonly size: number;

  private constructor(source: string, entries: Map<string, MaiChartInfo>, titles: Map<number, string>) {
    this.source = source;
    this.byKey = entries;
    this.titles = titles;
    this.size = entries.size;
  }

  /** 读取 data.json；文件不存在时返回空表（渲染退化为 `? -> rating`，不抛错）。 */
  static load(dir?: string): MaiSongData {
    const root = dir ?? resolve(process.cwd(), 'vendor', 'mai');
    const file = join(root, 'data.json');
    if (!existsSync(file)) {
      return new MaiSongData(`missing:${file}`, new Map(), new Map());
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as RawData;
    const entries = new Map<string, MaiChartInfo>();
    const titles = new Map<number, string>();
    for (const song of raw.songs ?? []) {
      const id = Number(song.id);
      if (!Number.isFinite(id)) continue;
      if (song.title) titles.set(id, song.title);
      for (const diff of song.difficulties ?? []) {
        const idx = Number(diff.difficulty);
        if (!Number.isFinite(idx)) continue;
        const songId = diff.type === 'dx' ? id + 10000 : id;
        const maxDx = diff.notes_total == null ? null : Number(diff.notes_total) * 3;
        entries.set(`${songId}-${idx}`, {
          levelValue: diff.level_value == null ? null : Number(diff.level_value),
          maxDxScore: maxDx,
          level: diff.level ?? null,
        });
      }
    }
    return new MaiSongData(file, entries, titles);
  }

  /** 取单谱面信息（无数据返回 null）。 */
  get(songId: number, levelIndex: number): MaiChartInfo | null {
    return this.byKey.get(`${songId}-${levelIndex}`) ?? null;
  }

  levelValue(songId: number, levelIndex: number): number | null {
    return this.get(songId, levelIndex)?.levelValue ?? null;
  }

  maxDxScore(songId: number, levelIndex: number): number | null {
    return this.get(songId, levelIndex)?.maxDxScore ?? null;
  }

  title(songId: number): string | null {
    return this.titles.get(songId) ?? null;
  }
}

const cache = new Map<string, MaiSongData>();

/** 按目录缓存，避免每次渲染重复解析 500KB JSON。 */
export function loadSongData(dir?: string): MaiSongData {
  const key = dir ?? resolve(process.cwd(), 'vendor', 'mai');
  const hit = cache.get(key);
  if (hit) return hit;
  const data = MaiSongData.load(key);
  cache.set(key, data);
  return data;
}

/** 测试用：清空缓存。 */
export function resetSongDataCache(): void {
  cache.clear();
}
