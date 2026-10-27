import { describe, expect, it } from 'vitest';

import { DEFAULT_TEXT_CHUNK_SIZE, splitText } from '../../../src/qq/index.js';

describe('splitText', () => {
  it('短文本原样返回', () => {
    expect(splitText('你好')).toEqual(['你好']);
  });

  it('空串返回空数组（调用方据此跳过发送）', () => {
    expect(splitText('')).toEqual([]);
  });

  it('默认按 1500 字符切分', () => {
    const text = 'a'.repeat(DEFAULT_TEXT_CHUNK_SIZE * 2 + 7);
    const chunks = splitText(text);
    expect(chunks.map((chunk) => chunk.length)).toEqual([1500, 1500, 7]);
    expect(chunks.join('')).toBe(text);
  });

  it('自定义上限', () => {
    expect(splitText('abcdef', 2)).toEqual(['ab', 'cd', 'ef']);
  });

  it('不切断 emoji 代理对', () => {
    const text = '🎵'.repeat(1401);
    const chunks = splitText(text, 1500);
    expect(chunks).toHaveLength(1);
    const longer = '🎵'.repeat(1601);
    const split = splitText(longer, 1500);
    expect(split).toHaveLength(2);
    for (const chunk of split) {
      // 每个分片都不能以孤立代理项开头/结尾。
      expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
      expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
      expect(Array.from(chunk)).toHaveLength(Array.from(chunk).length);
    }
    expect(split.join('')).toBe(longer);
  });

  it('非法上限抛错', () => {
    expect(() => splitText('x', 0)).toThrow(RangeError);
    expect(() => splitText('x', 1.5)).toThrow(RangeError);
  });
});
