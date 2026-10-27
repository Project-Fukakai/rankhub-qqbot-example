import { describe, expect, it } from 'vitest';

import { fetchImage, fetchImages } from '../../../src/rankhub/assets.js';

function response(body: BodyInit | null, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

describe('fetchImage', () => {
  it('非 http(s) / 空 URL 直接返回 null，不发请求', async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return response(new Uint8Array([1]));
    }) as unknown as typeof fetch;
    expect(await fetchImage('rankhub://user/1', { fetchImpl })).toBeNull();
    expect(await fetchImage('data:image/png;base64,AA', { fetchImpl })).toBeNull();
    expect(await fetchImage(null, { fetchImpl })).toBeNull();
    expect(called).toBe(0);
  });

  it('只接受 image/*，非图片返回 null', async () => {
    const fetchImpl = (async () =>
      response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    expect(await fetchImage('https://assets.test/a.png', { fetchImpl })).toBeNull();
  });

  it('超长 content-length / 超限 body / 非 2xx 都返回 null', async () => {
    const big = (async () =>
      response(new Uint8Array([1]), {
        headers: { 'content-type': 'image/png', 'content-length': '99999999' },
      })) as unknown as typeof fetch;
    expect(await fetchImage('https://assets.test/a.png', { fetchImpl: big })).toBeNull();

    const huge = (async () =>
      response(new Uint8Array(11), { headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;
    expect(await fetchImage('https://assets.test/a.png', { fetchImpl: huge, maxBytes: 10 })).toBeNull();

    const notFound = (async () =>
      response('nope', { status: 404, headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;
    expect(await fetchImage('https://assets.test/a.png', { fetchImpl: notFound })).toBeNull();
  });

  it('正常图片返回 Buffer；网络异常返回 null', async () => {
    const ok = (async () =>
      response(new Uint8Array([9, 8, 7]), { headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;
    const buffer = await fetchImage('https://assets.test/a.png', { fetchImpl: ok });
    expect(buffer?.length).toBe(3);

    const boom = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await fetchImage('https://assets.test/a.png', { fetchImpl: boom })).toBeNull();
  });
});

describe('fetchImages', () => {
  it('保持顺序，失败项为 null', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('bad')) throw new Error('x');
      return response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    const result = await fetchImages(
      ['https://assets.test/a.png', 'https://assets.test/bad.png', null],
      { fetchImpl },
    );
    expect(result[0]?.length).toBe(1);
    expect(result[1]).toBeNull();
    expect(result[2]).toBeNull();
  });
});
