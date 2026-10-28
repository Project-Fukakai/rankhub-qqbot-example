import { describe, expect, it } from 'vitest';

import type { GameProfile } from '../../../src/contracts/index.js';
import {
  arcaeaCharacterArtworkUrl,
  DEFAULT_ASSET_BASE_URL,
  DEFAULT_GAME_ASSET_ORIGIN,
  describeProfile,
  gatewayPathOf,
  normalizeAssetUrl,
  originOf,
} from '../../../src/rankhub/profile.js';
import {
  arcaeaFormat,
  arcaeaProfileEmptyAssets,
  arcaeaProfileV1,
  arcaeaProfileV1Assets,
  arcaeaProfileWithAssets,
  bareProfile,
  maimaiFormat,
  maimaiFormatNarrow,
  maimaiProfile,
  maimaiProfileV1Assets,
  phigrosFormat,
  phigrosProfileAbsoluteAvatar,
  phigrosProfileSnakeCase,
  phigrosProfileV0Shape,
  phigrosProfileV1,
  phigrosProfileV1Assets,
  phigrosProfileWithAssets,
  unknownGameProfile,
} from './profile.fixtures.js';

/** 只取 `label/value`，断言时不必反复写 schema。 */
function pairs(view: { fields: { label: string; value: string }[] }): [string, string][] {
  return view.fields.map((field) => [field.label, field.value]);
}

describe('describeProfile / maimai', () => {
  it('按 v1 adapter 输出的原生键映射段位、CLASS、星级、机台 ID、好友码', () => {
    const view = describeProfile('maimai', maimaiProfile);
    expect(view.game).toBe('maimai');
    expect(view.rating).toBe(15370);
    expect(view.isPublic).toBe(true);
    // maimai 没有头像/背景概念：类型里 `name_plate` 是收藏品对象，不是图片地址。
    expect(view.avatarUrl).toBeNull();
    expect(view.backgroundUrl).toBeNull();
    expect(pairs(view)).toEqual([
      ['段位', '12'],
      ['CLASS', '5'],
      ['星级', '3'],
      ['机台 userId', '12345678'],
      ['好友码', '123456789012345'],
    ]);
  });

  it('提供线上 format 时字段不变（它声明的正是 adapter 输出的那批键）', () => {
    expect(pairs(describeProfile('maimai', maimaiProfile, maimaiFormat))).toEqual(
      pairs(describeProfile('maimai', maimaiProfile)),
    );
  });

  it('format 只声明一个字段时，只展示该字段（声明即过滤）', () => {
    const view = describeProfile('maimai', maimaiProfile, maimaiFormatNarrow);
    expect(pairs(view)).toEqual([['段位', '12']]);
  });

  it('native.avatar_url 存在时按 App 资产规则归一（绝对直通 / 相对拼主机）', () => {
    const absolute = describeProfile('maimai', {
      ...maimaiProfile,
      player: {
        ...maimaiProfile.player,
        native: { avatar_url: 'https://cdn.example.com/me.png' },
      },
    });
    expect(absolute.avatarUrl).toBe('https://cdn.example.com/me.png');

    const relative = describeProfile('maimai', {
      ...maimaiProfile,
      player: {
        ...maimaiProfile.player,
        native: { avatar_url: '/v0/assets/asset-1/content?v=1779000000000' },
      },
    });
    expect(relative.avatarUrl).toBe(
      'https://net.rankhub.cc/api/v0/assets/asset-1/content?v=1779000000000',
    );
  });
});

describe('describeProfile / phigros', () => {
  it('v1 真实形状不带头像/背景 ⇒ 两者为 null，但字段齐全', () => {
    const view = describeProfile('phigros', phigrosProfileV1, phigrosFormat);
    expect(view.game).toBe('phigros');
    expect(view.rating).toBe(15.43);
    expect(view.isPublic).toBe(false);
    expect(view.avatarUrl).toBeNull();
    expect(view.backgroundUrl).toBeNull();
    expect(pairs(view)).toEqual([
      // challengeModeRank 316 ⇒ 段位等级 3（红）+ 总难度 16（App 的解法：player_summary.dart:35-70）
      ['课题模式', '红 16'],
      ['游戏版本', '25'],
      ['Object ID', 'a1b2c3d4-0000-4000-8000-000000000000'],
      ['Short ID', 'P123456'],
    ]);
  });

  it('avatar_asset_key / background_song_id 存在时按 App 规则拼 static.rankhub.cc', () => {
    const view = describeProfile('phigros', phigrosProfileWithAssets);
    expect(view.avatarUrl).toBe('https://static.rankhub.cc/phigros/asset/avatar.Introduction.jpg');
    // 曲绘：最后一段无条件追加后缀 ⇒ Illustration.jpg.jpg（App 单测与 CDN 实测都如此）
    expect(view.backgroundUrl).toBe(
      'https://static.rankhub.cc/phigros/asset/Assets/Tracks/' +
        'Glaciaxion.SunsetRay.0/Illustration.jpg.jpg',
    );
    expect(view.isPublic).toBe(true);
  });

  it('兼容 v0 形状：顶层 background_song_id 也能拼出曲绘', () => {
    const view = describeProfile('phigros', phigrosProfileV0Shape);
    expect(view.backgroundUrl).toBe(
      'https://static.rankhub.cc/phigros/asset/Assets/Tracks/' +
        'Glaciaxion.SunsetRay.0/Illustration.jpg.jpg',
    );
  });

  it('avatar 是绝对 URL 时不采信（与 App publicAvatarUrl 一致）', () => {
    const view = describeProfile('phigros', phigrosProfileAbsoluteAvatar);
    expect(view.avatarUrl).toBeNull();
  });

  it('snake_case 兜底（v0 / display 键）也能读出字段', () => {
    const view = describeProfile('phigros', phigrosProfileSnakeCase);
    expect(pairs(view)).toEqual([
      // 102 ⇒ 段位等级 1（绿）+ 总难度 2
      ['课题模式', '绿 2'],
      ['游戏版本', '24'],
      ['Object ID', 'a1b2c3d4-0000-4000-8000-000000000000'],
    ]);
  });

  it('课题模式 0 显示「未参与」（App 同口径）', () => {
    const view = describeProfile('phigros', {
      ...phigrosProfileV1,
      player: { ...phigrosProfileV1.player, native: { challengeModeRank: 0 } },
    });
    expect(pairs(view)).toEqual([['课题模式', '未参与']]);
  });
});

describe('describeProfile / arcaea', () => {
  it('v1 真实形状没有 avatar ⇒ 回落到搭档图标，背景为 null', () => {
    const view = describeProfile('arcaea', arcaeaProfileV1, arcaeaFormat);
    expect(view.game).toBe('arcaea');
    expect(view.rating).toBe(12.34);
    expect(view.isPublic).toBe(true);
    expect(view.avatarUrl).toBe('https://static.rankhub.cc/arcaea/asset/char/0_icon.png');
    expect(view.backgroundUrl).toBeNull();
    expect(pairs(view)).toEqual([
      ['搭档', '0'],
      ['Course', '6'],
      ['Best 30 均值', '12.5'],
      ['Best 50 均值', '12.11'],
      ['Arcaea ID', '123456789'],
      ['好友码', '123456789'],
    ]);
  });

  it('avatar / nameplate 存在时去掉 assets/ 前缀再拼 static.rankhub.cc', () => {
    const view = describeProfile('arcaea', arcaeaProfileWithAssets);
    expect(view.avatarUrl).toBe('https://static.rankhub.cc/arcaea/asset/char/0_icon.png');
    expect(view.backgroundUrl).toBe(
      'https://static.rankhub.cc/arcaea/asset/img/nameplate/sample.png',
    );
    expect(view.isPublic).toBe(false);
  });

  it('avatar 与 character 都为空时头像为 null，不编造 URL', () => {
    const view = describeProfile('arcaea', arcaeaProfileEmptyAssets);
    expect(view.avatarUrl).toBeNull();
    expect(view.backgroundUrl).toBeNull();
    expect(view.rating).toBeNull();
    expect(pairs(view)).toEqual([
      ['Course', '0'],
      ['Arcaea ID', '1'],
    ]);
  });
});

describe('describeProfile / 边界与未知游戏', () => {
  it('native 为 null、rating 为 null 时不崩，返回空字段', () => {
    const view = describeProfile('phigros', bareProfile);
    expect(view).toMatchObject({
      game: 'phigros',
      avatarUrl: null,
      backgroundUrl: null,
      rating: null,
      fields: [],
      isPublic: false,
    });
  });

  it('未知游戏给空字段，rating / isPublic 仍透传', () => {
    const view = describeProfile('chunithm', unknownGameProfile);
    expect(view).toMatchObject({
      game: 'chunithm',
      avatarUrl: null,
      backgroundUrl: null,
      rating: 16.5,
      fields: [],
      isPublic: true,
    });
  });

  it('profile 结构残缺（无 player）时不抛异常', () => {
    const view = describeProfile('maimai', {} as unknown as GameProfile);
    expect(view.fields).toEqual([]);
    expect(view.avatarUrl).toBeNull();
    expect(view.rating).toBeNull();
    expect(view.isPublic).toBe(false);
  });

  it('不修改传入的 profile（纯函数）', () => {
    const before = JSON.stringify(phigrosProfileWithAssets);
    describeProfile('phigros', phigrosProfileWithAssets, phigrosFormat);
    expect(JSON.stringify(phigrosProfileWithAssets)).toBe(before);
  });

  it('format 声明了但 native 里没有的字段不展示', () => {
    const view = describeProfile('maimai', maimaiProfile, {
      profile: { identityFields: [{ name: 'userId' }], nativeFields: [{ name: 'courseRank' }] },
    });
    // native 里还有 classRank/star/friendCode，但 format 没声明 ⇒ 只展示声明的两个
    expect(pairs(view)).toEqual([
      ['段位', '12'],
      ['机台 userId', '12345678'],
    ]);
  });

  it('可覆盖游戏静态资源 origin（测试/自建 CDN）', () => {
    const view = describeProfile('phigros', phigrosProfileWithAssets, null, {
      gameAssetOrigin: 'https://assets.test',
    });
    expect(view.avatarUrl).toBe('https://assets.test/phigros/asset/avatar.Introduction.jpg');
  });
});

describe('资产 URL 归一（镜像 App _normalizeAssetUrl）', () => {
  it('常量与 App 默认值一致', () => {
    expect(DEFAULT_ASSET_BASE_URL).toBe('https://net.rankhub.cc/api/v0');
    expect(DEFAULT_GAME_ASSET_ORIGIN).toBe('https://static.rankhub.cc');
  });

  it('originOf / gatewayPathOf 与 App 文档示例一致', () => {
    expect(originOf('https://net.rankhub.cc/api/v0')).toBe('https://net.rankhub.cc');
    expect(originOf('http://127.0.0.1:9528/v0')).toBe('http://127.0.0.1:9528');
    expect(gatewayPathOf('https://net.rankhub.cc/api/v0')).toBe('/api');
    expect(gatewayPathOf('http://127.0.0.1:9528/v0')).toBe('');
    expect(gatewayPathOf('https://net.rankhub.cc')).toBe('');
    expect(gatewayPathOf('https://net.rankhub.cc/api')).toBe('/api');
  });

  it('四支分支：绝对直通、/vN 拼网管、/ 拼主机、相对路径补 /', () => {
    expect(normalizeAssetUrl('https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png',
    );
    expect(normalizeAssetUrl('/v0/assets/abc/content?v=1')).toBe(
      'https://net.rankhub.cc/api/v0/assets/abc/content?v=1',
    );
    expect(normalizeAssetUrl('/static/x.png')).toBe('https://net.rankhub.cc/static/x.png');
    expect(normalizeAssetUrl('static/x.png')).toBe('https://net.rankhub.cc/static/x.png');
  });

  it('自定义基址：带端口 + 无网关前缀 / 带 /api 前缀', () => {
    expect(normalizeAssetUrl('/v0/assets/x', { assetBaseUrl: 'http://127.0.0.1:9528/v0' })).toBe(
      'http://127.0.0.1:9528/v0/assets/x',
    );
    expect(
      normalizeAssetUrl('/v1/assets/x', { assetBaseUrl: 'https://net.rankhub.cc/api/v1' }),
    ).toBe('https://net.rankhub.cc/api/v1/assets/x');
  });

  it('缺失值统一为 null，字符串先 trim', () => {
    expect(normalizeAssetUrl(null)).toBeNull();
    expect(normalizeAssetUrl(undefined)).toBeNull();
    expect(normalizeAssetUrl('')).toBeNull();
    expect(normalizeAssetUrl('   ')).toBeNull();
    expect(normalizeAssetUrl('null')).toBeNull();
    expect(normalizeAssetUrl('  https://a.example/b.png  ')).toBe('https://a.example/b.png');
  });
});

describe('describeProfile / v1 assets 优先与老实例回退', () => {
  it('maimai：assets 提供头像 + 背景板（frame），优先于 native', () => {
    const view = describeProfile('maimai', maimaiProfileV1Assets);
    expect(view.avatarUrl).toBe('https://cdn.test/maimai/avatar.png');
    // v1 assets.backgroundUrl = 用户背景板（frame）URL（契约 §3.1）。
    expect(view.backgroundUrl).toBe('https://cdn.test/maimai/frame.png');
    expect(view.characterArtworkUrl).toBeNull();
    // 字段映射不受 assets 影响。
    expect(view.rating).toBe(15370);
  });

  it('maimai 老实例（无 assets）保持本地规则：头像来自 native.avatarUrl、背景为 null', () => {
    const view = describeProfile('maimai', {
      ...maimaiProfile,
      player: {
        ...maimaiProfile.player,
        native: { avatar_url: 'https://cdn.example.com/mai.png' },
      },
    });
    expect(view.avatarUrl).toBe('https://cdn.example.com/mai.png');
    expect(view.backgroundUrl).toBeNull();
    expect(view.characterArtworkUrl).toBeNull();
  });

  it('phigros：assets 覆盖本地 avatarAssetKey / backgroundSongId 规则', () => {
    const view = describeProfile('phigros', phigrosProfileV1Assets);
    expect(view.avatarUrl).toBe('https://cdn.test/phigros/avatar.png');
    expect(view.backgroundUrl).toBe('https://cdn.test/phigros/background.png');
    expect(view.characterArtworkUrl).toBeNull();
  });

  it('phigros 老实例（无 assets）回退本地规则，URL 不变（不回归）', () => {
    const view = describeProfile('phigros', phigrosProfileWithAssets);
    expect(view.avatarUrl).toBe(
      'https://static.rankhub.cc/phigros/asset/avatar.Introduction.jpg',
    );
    expect(view.backgroundUrl).toBe(
      'https://static.rankhub.cc/phigros/asset/Assets/Tracks/Glaciaxion.SunsetRay.0/Illustration.jpg.jpg',
    );
    expect(view.characterArtworkUrl).toBeNull();
  });

  it('assets 字段是空串时按缺失处理，仍回退本地规则', () => {
    const view = describeProfile('phigros', {
      ...phigrosProfileWithAssets,
      assets: { avatarUrl: '', backgroundUrl: '  ', characterArtworkUrl: '' },
    });
    expect(view.avatarUrl).toBe(
      'https://static.rankhub.cc/phigros/asset/avatar.Introduction.jpg',
    );
    expect(view.backgroundUrl).toBe(
      'https://static.rankhub.cc/phigros/asset/Assets/Tracks/Glaciaxion.SunsetRay.0/Illustration.jpg.jpg',
    );
  });

  it('arcaea：assets 提供头像 / 名片板 / 立绘，优先于 native', () => {
    const view = describeProfile('arcaea', arcaeaProfileV1Assets);
    expect(view.avatarUrl).toBe('https://cdn.test/arcaea/avatar.png');
    expect(view.backgroundUrl).toBe('https://cdn.test/arcaea/nameplate.png');
    expect(view.characterArtworkUrl).toBe('https://cdn.test/arcaea/char/1080/0.png');
  });

  it('arcaea 老实例（无 assets）：立绘回退 App 的 char/1080 规则', () => {
    const view = describeProfile('arcaea', arcaeaProfileV1);
    expect(view.avatarUrl).toBe('https://static.rankhub.cc/arcaea/asset/char/0_icon.png');
    expect(view.characterArtworkUrl).toBe(
      'https://static.rankhub.cc/arcaea/asset/char/1080/0.png',
    );

    const empty = describeProfile('arcaea', arcaeaProfileEmptyAssets);
    expect(empty.characterArtworkUrl).toBeNull();
  });

  it('未知游戏：服务端给 assets 就照用，不给保持空（不猜）', () => {
    const withAssets = describeProfile('chunithm', {
      ...unknownGameProfile,
      assets: {
        avatarUrl: 'https://cdn.test/chuni/avatar.png',
        backgroundUrl: 'https://cdn.test/chuni/background.png',
        characterArtworkUrl: null,
      },
    });
    expect(withAssets.avatarUrl).toBe('https://cdn.test/chuni/avatar.png');
    expect(withAssets.backgroundUrl).toBe('https://cdn.test/chuni/background.png');

    const withoutAssets = describeProfile('chunithm', unknownGameProfile);
    expect(withoutAssets.avatarUrl).toBeNull();
    expect(withoutAssets.backgroundUrl).toBeNull();
    expect(withoutAssets.characterArtworkUrl).toBeNull();
  });

  it('arcaeaCharacterArtworkUrl 对空/缺失搭档返回 null，对有效值做百分号编码', () => {
    expect(arcaeaCharacterArtworkUrl(null)).toBeNull();
    expect(arcaeaCharacterArtworkUrl('  ')).toBeNull();
    expect(arcaeaCharacterArtworkUrl('1080')).toBe(
      'https://static.rankhub.cc/arcaea/asset/char/1080/1080.png',
    );
    expect(arcaeaCharacterArtworkUrl('a/b c')).toBe(
      'https://static.rankhub.cc/arcaea/asset/char/1080/a%2Fb%20c.png',
    );
  });
});
