import { describe, expect, it } from 'vitest';

import {
  ARC_ASSET_ORIGIN,
  arcaeaJacketCandidates,
  prefetchArcaeaCovers,
} from '../../../src/rankhub/arc-assets.js';

function jpeg(bytes = 4): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, ...Array.from({ length: bytes }, () => 0)]);
}

describe('arcaeaJacketCandidates', () => {
  it('按 App _imagePriority 顺序给出 CDN 候选（含 dl_ 变体）', () => {
    const urls = arcaeaJacketCandidates('testify');
    expect(urls[0]).toBe(`${ARC_ASSET_ORIGIN}/arcaea/asset/songs/testify/base_256.jpg`);
    expect(urls[1]).toBe(`${ARC_ASSET_ORIGIN}/arcaea/asset/songs/dl_testify/base_256.jpg`);
    expect(urls[2]).toBe(`${ARC_ASSET_ORIGIN}/arcaea/asset/songs/testify/1080_base_256.jpg`);
    expect(urls[4]).toBe(`${ARC_ASSET_ORIGIN}/arcaea/asset/songs/testify/base.jpg`);
    expect(urls[6]).toBe(`${ARC_ASSET_ORIGIN}/arcaea/asset/songs/testify/1080_base.jpg`);
    expect(urls).toHaveLength(8);
  });

  it('空 id 返回空数组；特殊字符按路径段编码', () => {
    expect(arcaeaJacketCandidates('  ')).toEqual([]);
    expect(arcaeaJacketCandidates('a b/c')[0]).toContain('/songs/a%20b%2Fc/base_256.jpg');
  });
});

describe('prefetchArcaeaCovers', () => {
  it('首个成功的候选转成 data URL；全部 404 的曲目不进 map', async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/songs/testify/base_256.jpg')) {
        return new Response(new Uint8Array(jpeg()), {
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response('nope', { status: 404, headers: { 'content-type': 'image/jpeg' } });
    }) as unknown as typeof fetch;

    const covers = await prefetchArcaeaCovers(['testify', 'missing-song'], { fetchImpl });
    expect(covers.has('testify')).toBe(true);
    expect(covers.get('testify')).toMatch(/^data:image\/jpeg;base64,/);
    expect(covers.has('missing-song')).toBe(false);
    // 命中第一候选后不再请求后续候选。
    expect(requested.filter((url) => url.includes('songs/testify')).length).toBe(1);
  });

  it('去重 songId，并发完成', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(new Uint8Array(jpeg()), {
        headers: { 'content-type': 'image/jpeg' },
      });
    }) as unknown as typeof fetch;
    const covers = await prefetchArcaeaCovers(['a', 'a', 'b', 'b'], { fetchImpl, concurrency: 2 });
    expect(covers.size).toBe(2);
    expect(calls).toBe(2);
  });
});
