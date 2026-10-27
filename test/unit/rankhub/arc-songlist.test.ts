import { describe, expect, it } from 'vitest';

import {
  ArcaeaSongTitleCache,
  fetchArcaeaSongTitles,
  parseSongTitles,
} from '../../../src/rankhub/arc-songlist.js';

const SONGLIST = {
  songs: [
    { id: 'testify', title_localized: { en: 'Testify', ja: 'テスト' } },
    { id: 'abstrusedilemma', title_localized: { en: 'Abstruse Dilemma' } },
    { id: 'no-en', title_localized: { ja: '日本語のみ' } },
    { id: 'no-title' },
    { title_localized: { en: 'missing id' } },
    'not-an-object',
  ],
};

describe('parseSongTitles', () => {
  it('按 id 提取 en 标题，缺失时回落其它语言 / id', () => {
    const titles = parseSongTitles(SONGLIST);
    expect(titles.get('testify')).toBe('Testify');
    expect(titles.get('abstrusedilemma')).toBe('Abstruse Dilemma');
    expect(titles.get('no-en')).toBe('日本語のみ');
    expect(titles.get('no-title')).toBe('no-title');
    expect(titles.has('missing id')).toBe(false);
    expect(titles.size).toBe(4);
  });

  it('非法 payload 返回空 map', () => {
    expect(parseSongTitles(null).size).toBe(0);
    expect(parseSongTitles({ songs: 'nope' }).size).toBe(0);
    expect(parseSongTitles({}).size).toBe(0);
  });
});

describe('fetchArcaeaSongTitles', () => {
  it('拼官方 songlist URL，http 失败返回空 map', async () => {
    const urls: string[] = [];
    const ok = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify(SONGLIST), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const titles = await fetchArcaeaSongTitles({ apiBase: 'https://api.rankhub.cc/', fetchImpl: ok });
    expect(urls[0]).toBe('https://api.rankhub.cc/v0/games/arcaea/resources/songlist');
    expect(titles.get('testify')).toBe('Testify');

    const bad = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect((await fetchArcaeaSongTitles({ apiBase: 'https://x', fetchImpl: bad })).size).toBe(0);
  });
});

describe('ArcaeaSongTitleCache', () => {
  it('TTL 内复用；拉取失败（空结果）保留旧缓存', async () => {
    let calls = 0;
    let now = 1_000;
    const cache = new ArcaeaSongTitleCache(
      async () => {
        calls += 1;
        return calls === 1 ? new Map([['a', 'A']]) : new Map();
      },
      1_000,
      () => now,
    );
    expect((await cache.get()).titles.get('a')).toBe('A');
    expect(calls).toBe(1);
    now += 500;
    await cache.get();
    expect(calls).toBe(1);
    // 过期后重新拉取失败：旧缓存保留。
    now += 2_000;
    const value = await cache.get();
    expect(calls).toBe(2);
    expect(value.titles.get('a')).toBe('A');
  });

  it('并发 get 只触发一次 loader', async () => {
    let calls = 0;
    const cache = new ArcaeaSongTitleCache(async () => {
      calls += 1;
      return new Map([['a', 'A']]);
    });
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(calls).toBe(1);
  });
});
