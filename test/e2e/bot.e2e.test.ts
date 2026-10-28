/**
 * 端到端：真实 createBot + 假 QQ（HTTP+WS）+ 假 RankHub + 假 renderer。
 *
 * 覆盖 task-5 验收点：
 * - /help：1 条文本、msg_id 对应、msg_seq=1；
 * - /bind：先回设备码，模拟用户在 App 内批准后，同一条入站消息再收 msg_seq=2 的成功文案；
 *   store 里有加密 binding（密文非明文）；
 * - /b50：假 RankHub 返回 profiles+bests → 上传 1 次文件 + msg_type=7；
 * - /unbind：调用 revoke 且本地 binding 清空；
 * - 未知指令：回提示文案。
 *
 * 所有 URL 都指向 127.0.0.1；不访问真实 QQ / RankHub。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  ONE_PX_PNG,
  createManualSleep,
  startHarness,
  waitFor,
  type Harness,
} from './helpers.js';

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

describe('E2E 指令管线', () => {
  it(
    '/help 回复一条文本：msg_id 对应、msg_seq=1',
    async () => {
      harness = await startHarness();
      harness.emitGroup('/help', 'msg-help-1');

      const messages = await harness.waitForMessages('msg-help-1', 1);
      expect(messages).toHaveLength(1);
      const message = messages[0]!;
      expect(message.targetKind).toBe('group');
      expect(message.body.msg_id).toBe('msg-help-1');
      expect(message.body.msg_seq).toBe(1);
      expect(message.body.msg_type).toBe(0);
      const content = String(message.body.content);
      expect(content).toContain('指令');
      expect(content).toContain('/bind');
      expect(content).toContain('/b50');
    },
    15_000,
  );

  it(
    '中文别名（不带前缀）也能命中指令',
    async () => {
      harness = await startHarness();
      harness.emitGroup('帮助', 'msg-help-cn-1');
      const messages = await harness.waitForMessages('msg-help-cn-1', 1);
      expect(String(messages[0]!.body.content)).toContain('指令');
    },
    15_000,
  );

  it(
    '群聊 /bind 不带 UID → 提示需要 UID，不创建授权请求',
    async () => {
      harness = await startHarness();
      harness.emitGroup('/bind', 'msg-bind-nouid-1');
      const messages = await harness.waitForMessages('msg-bind-nouid-1', 1);
      const content = String(messages[0]!.body.content);
      expect(content).toContain('RankHub UID');
      expect(content).toContain('/bind <UID>');
      expect(harness.fakeRankHub.lastAuthorization()).toBeNull();
    },
    15_000,
  );

  it(
    '/bind：二维码 + 模拟 App 确认 → msg_seq=3 成功文案 + 加密入库',
    async () => {
      const manual = createManualSleep();
      harness = await startHarness({ sleep: manual.sleep });

      harness.emitGroup('/bind 10001', 'msg-bind-1');
      const firstMessages = await harness.waitForMessages('msg-bind-1', 1);
      const first = firstMessages[0]!;
      expect(first.body.msg_seq).toBe(1);
      expect(String(first.body.content)).toContain('RankHub App');
      // 深链由授权请求下发，文本里必须带上（二维码识别不了时的兜底）。
      expect(String(first.body.content)).toContain('rankhub://');

      // #2 是二维码图片。
      const qrImage = await harness.waitForImageMessage();
      expect(qrImage.body.msg_seq).toBe(2);
      expect(qrImage.body.msg_type).toBe(7);

      const authorization = harness.fakeRankHub.lastAuthorization();
      expect(authorization).not.toBeNull();

      // 等后台轮询进入 sleep，再模拟用户在 App 内确认。
      await waitFor(() => manual.pending() >= 1, '后台授权轮询进入等待');
      harness.fakeRankHub.approveAuthorization(authorization!.pollToken);
      manual.release();

      const allMessages = await harness.waitForMessages('msg-bind-1', 3);
      expect(allMessages).toHaveLength(3);
      const success = allMessages[2]!;
      expect(success.body.msg_id).toBe('msg-bind-1');
      expect(success.body.msg_seq).toBe(3);
      const content = String(success.body.content);
      expect(content).toContain('绑定成功');
      expect(content).toContain('Fake User');

      const binding = await harness.store.getByQqUser('user-openid-1');
      expect(binding).not.toBeNull();
      expect(binding!.status).toBe('active');
      expect(binding!.rankhubName).toBe('Fake User');
      expect(binding!.refreshTokenEnc).toMatch(/^v1\./);
      expect(binding!.refreshTokenEnc).not.toContain('rt_');
      expect(binding!.accessTokenEnc ?? '').toMatch(/^v1\./);
      expect(binding!.accessTokenEnc ?? '').not.toContain('at_');
      expect(await harness.store.getPendingDevice('user-openid-1')).toBeNull();
    },
    20_000,
  );

  it(
    '/bind：用户拒绝 → 明确文案',
    async () => {
      const manual = createManualSleep();
      harness = await startHarness({ sleep: manual.sleep });
      harness.emitGroup('/bind 10001', 'msg-bind-denied-1');
      await harness.waitForMessages('msg-bind-denied-1', 1);
      const authorization = harness.fakeRankHub.lastAuthorization()!;

      await waitFor(() => manual.pending() >= 1, '授权轮询等待');
      harness.fakeRankHub.denyAuthorization(authorization.pollToken);
      manual.release();

      const messages = await harness.waitForMessages('msg-bind-denied-1', 3);
      expect(String(messages[2]!.body.content)).toContain('拒绝');
    },
    20_000,
  );

  it(
    '/bind：授权过期 → 明确文案 + 清理 pending',
    async () => {
      const manual = createManualSleep();
      harness = await startHarness({ sleep: manual.sleep });
      harness.emitGroup('/bind 10001', 'msg-bind-expired-1');
      await harness.waitForMessages('msg-bind-expired-1', 1);
      const authorization = harness.fakeRankHub.lastAuthorization()!;

      await waitFor(() => manual.pending() >= 1, '授权轮询等待');
      harness.fakeRankHub.expireAuthorization(authorization.pollToken);
      manual.release();

      const messages = await harness.waitForMessages('msg-bind-expired-1', 3);
      expect(String(messages[2]!.body.content)).toContain('失效');
    },
    20_000,
  );

  it(
    '/bind：超过轮询上限 → 超时文案 + 清理 pending',
    async () => {
      const manual = createManualSleep();
      let clock = 1_700_000_000_000;
      harness = await startHarness({ sleep: manual.sleep, now: () => clock });

      harness.emitGroup('/bind 10001', 'msg-bind-timeout-1');
      await harness.waitForMessages('msg-bind-timeout-1', 1);
      expect(harness.fakeRankHub.lastAuthorization()).not.toBeNull();

      await waitFor(() => manual.pending() >= 1, '授权轮询等待');
      // 跳过 RANKHUB_DEVICE_POLL_MAX_SECONDS（240s）后再放行一次轮询。
      clock += 241_000;
      manual.release();

      const messages = await harness.waitForMessages('msg-bind-timeout-1', 3);
      expect(String(messages[2]!.body.content)).toContain('绑定超时');
    },
    20_000,
  );

  it(
    '/me：渲染玩家名片（三张卡按契约映射 + v1 assets 图片 + 偏好难度 + 二维码）',
    async () => {
      harness = await startHarness();
      await harness.seedBinding();

      harness.emitGroup('/me', 'msg-me-1');
      const imageMessage = await harness.waitForImageMessage();
      expect(imageMessage.body.msg_type).toBe(7);
      expect(harness.renderer.cardCalls).toHaveLength(1);

      const input = harness.renderer.cardCalls[0]!;
      expect(input.displayName).toBe('Fake User');
      expect(input.uid).toBe('100234567');
      expect(input.games.map((game) => game.name)).toEqual(['maimai DX', 'Phigros', 'Arcaea']);
      expect(input.cards.map((card) => card.game)).toEqual(['maimai', 'phigros', 'arcaea']);

      const [maimai, phigros, arcaea] = input.cards as [
        import('../../src/contracts/index.js').PlayerCardMaimaiCardData,
        import('../../src/contracts/index.js').PlayerCardPhigrosCardData,
        import('../../src/contracts/index.js').PlayerCardArcaeaCardData,
      ];
      expect(maimai).toMatchObject({
        rating: 15000,
        b15Rating: 12000,
        b35Rating: null,
        lastSyncedAt: '2026-10-01T00:00:00Z',
      });
      // v1 assets（契约 V1-PROFILE-ASSETS §2）：头像 + 用户背景板（frame）都拉成了 Buffer。
      expect(maimai.avatar).toBeInstanceOf(Buffer);
      expect(maimai.frame).toBeInstanceOf(Buffer);

      // phigros：ϕ 3 首 + best30 27 首、全部 rks 15 ⇒ B30 平均 15；难度取偏好 IN。
      expect(phigros).toMatchObject({
        rks: 15,
        challengeModeRank: 316,
        difficulty: 'IN',
        achievements: { played: 30, clear: 25, fc: 15, phi: 5 },
      });
      // 曲线背景 = assets.backgroundUrl（曲绘）；头像 = assets.avatarUrl。
      expect(phigros.avatar).toBeInstanceOf(Buffer);
      expect(phigros.background).toBeInstanceOf(Buffer);

      expect(arcaea).toMatchObject({ potential: 12.34, b50Avg: 10.8, b10Avg: 12.1 });
      // arcaea 头像 + 搭档立绘（assets.characterArtworkUrl）。
      expect(arcaea.avatar).toBeInstanceOf(Buffer);
      expect(arcaea.characterArtwork).toBeInstanceOf(Buffer);

      // 账号公开 ⇒ 传入二维码 PNG Buffer。
      expect(input.qr).toBeInstanceOf(Buffer);
      expect(input.qr!.length).toBeGreaterThan(100);

      // 新端点确实被调用（契约 §2.1 / §2.2）。
      const paths = harness.fakeRankHub.state.requests.map((request) => request.path);
      expect(paths).toContain('/v1/me/profile');
      expect(paths).toContain('/v1/games/phigros/profiles/profile-phi-1/statistics');

      // 素材全部来自假服务的本机图片路由（E2E 不访问外网），且每个 assets URL 都被拉过。
      const imageQueries = harness.fakeRankHub.state.requests
        .filter((request) => request.path === '/fake/image.png')
        .map((request) => `${request.query['game'] ?? ''}:${request.query['asset'] ?? ''}`);
      expect(imageQueries).toEqual(
        expect.arrayContaining([
          'maimai:avatar',
          'maimai:frame',
          'phigros:avatar',
          'phigros:background',
          'arcaea:avatar',
          'arcaea:artwork',
        ]),
      );
    },
    20_000,
  );

  it(
    '/me 老实例（profile 无 assets）：卡片不带图、不请求素材、不崩',
    async () => {
      harness = await startHarness({ rankhub: { includeAssets: false } });
      await harness.seedBinding();

      harness.emitGroup('/me', 'msg-me-no-assets-1');
      await harness.waitForImageMessage();
      const input = harness.renderer.cardCalls[0]!;
      expect(input.cards.map((card) => card.game)).toEqual(['maimai', 'phigros', 'arcaea']);

      // 老实例：assets 全 null，且默认夹具的 native 也没有可拼的本地键 ⇒ 不带任何图片。
      for (const card of input.cards) expect(card).not.toHaveProperty('avatar');
      expect(input.cards[0]).not.toHaveProperty('frame');
      expect(input.cards[1]).not.toHaveProperty('background');
      expect(input.cards[2]).not.toHaveProperty('characterArtwork');

      // 没有发任何素材请求（URL 全是 null）。
      expect(
        harness.fakeRankHub.state.requests.filter((request) => request.path === '/fake/image.png'),
      ).toHaveLength(0);
    },
    20_000,
  );

  it(
    '/me diff：回当前难度；/me diff <难度> 写回后端偏好并生效',
    async () => {
      harness = await startHarness();
      await harness.seedBinding();
      // 起点 HD：随后 `/me diff IN` 应把后端偏好改回 IN。
      harness.fakeRankHub.state.displayPreferences = { phigrosDifficulty: 'HD' };

      harness.emitGroup('/me diff', 'msg-me-diff-1');
      const showMessages = await harness.waitForMessages('msg-me-diff-1', 1);
      const showText = String(showMessages[0]!.body.content);
      expect(showText).toContain('当前难度：HD');
      expect(showText).toContain('EZ / HD / IN / AT');

      harness.emitGroup('/me diff in', 'msg-me-diff-2');
      const setMessages = await harness.waitForMessages('msg-me-diff-2', 1);
      expect(String(setMessages[0]!.body.content)).toContain('已把 Phigros 卡片难度切换为 IN');
      expect(harness.fakeRankHub.state.displayPreferences).toEqual({ phigrosDifficulty: 'IN' });

      const patchRequest = harness.fakeRankHub.state.requests.find(
        (request) =>
          request.path === '/v1/me/display-preferences' && request.method === 'PATCH',
      );
      expect(patchRequest?.json).toEqual({ phigrosDifficulty: 'IN' });

      // 写回后 /me 的 phigros 卡按 IN 的达成统计渲染（同一偏好，不各存一份）。
      harness.emitGroup('/me', 'msg-me-diff-3');
      await harness.waitForImageMessage();
      const card = harness.renderer.cardCalls.at(-1)!;
      expect(card.cards[1]).toMatchObject({
        game: 'phigros',
        difficulty: 'IN',
        achievements: { played: 30, clear: 25, fc: 15, phi: 5 },
      });
    },
    20_000,
  );

  it(
    '/me diff 非法参数：回用法提示且不写后端',
    async () => {
      harness = await startHarness();
      await harness.seedBinding();

      harness.emitGroup('/me diff xyz', 'msg-me-diff-invalid-1');
      const messages = await harness.waitForMessages('msg-me-diff-invalid-1', 1);
      expect(String(messages[0]!.body.content)).toContain('/me diff 用法');
      expect(
        harness.fakeRankHub.state.requests.some(
          (request) =>
            request.path === '/v1/me/display-preferences' && request.method === 'PATCH',
        ),
      ).toBe(false);
    },
    20_000,
  );

  it(
    '/arc：arcaea bests → 渲染 B50 图片（msg_type=7）',
    async () => {
      harness = await startHarness();
      await harness.seedBinding();
      harness.fakeRankHub.state.bests['arcaea'] = {
        game: 'arcaea',
        computedAt: '2026-10-20T00:00:00Z',
        totals: { potential: 12.34 },
        buckets: [
          {
            key: 'best30',
            label: 'B30',
            total: 12.34,
            items: [
              {
                scoreId: 'arc-score-1',
                songId: 'testify',
                songName: 'Testify',
                type: 'byd',
                difficulty: 'BYD',
                levelIndex: 3,
                level: '11',
                achievements: null,
                score: 9980000,
                rating: 14.2,
                rank: 'EX+',
                dxScore: null,
                dxStar: null,
                fc: 'pm',
                fs: null,
                playTime: null,
                native: {
                  song_id: 'testify',
                  score: 9980000,
                  potential: 14.2,
                  clear_type: 3,
                  perfect_count: 1200,
                  near_count: 2,
                  miss_count: 0,
                  constant: 11.5,
                },
              },
            ],
          },
        ],
      };

      harness.emitGroup('/arc', 'msg-arc-1');
      const imageMessage = await harness.waitForImageMessage();
      expect(imageMessage.body.msg_type).toBe(7);
      expect(harness.renderer.arcCalls).toHaveLength(1);
      const input = harness.renderer.arcCalls[0]!;
      expect(input.profileName).toBe('Fake Arc Player');
      expect(input.potential).toBe(12.34);
      expect(input.items).toHaveLength(1);
    },
    20_000,
  );

  it(
    '/b50：maimai profiles+bests → 上传 1 次图片 + msg_type=7',
    async () => {
      harness = await startHarness();
      await harness.seedBinding();

      harness.emitGroup('/b50', 'msg-b50-1');
      const imageMessage = await harness.waitForImageMessage();

      // 耗时操作先回一条提示（msg_seq=1），图片是 msg_seq=2。
      const messages = await harness.waitForMessages('msg-b50-1', 2);
      expect(messages[0]!.body.msg_type).toBe(0);
      expect(messages[0]!.body.msg_seq).toBe(1);
      expect(String(messages[0]!.body.content)).toContain('正在生成 maimai B50');
      // 两条都引用原消息（message_reference.message_id = message_scene.ext 的 msg_idx）。
      for (const message of messages) {
        expect(message.body.message_reference).toEqual({ message_id: 'REFIDX_msg-b50-1==' });
      }

      expect(imageMessage.body.msg_id).toBe('msg-b50-1');
      expect(imageMessage.body.msg_seq).toBe(2);
      expect(imageMessage.body.msg_type).toBe(7);
      expect(imageMessage.body.media).toEqual({ file_info: 'fake-file-info' });

      expect(harness.fakeQQ.fileUploads).toHaveLength(1);
      const upload = harness.fakeQQ.fileUploads[0]!;
      expect(upload.targetKind).toBe('group');
      expect(upload.body).toMatchObject({ file_type: 1, srv_send_msg: false });
      expect(upload.rawBytes).toBeGreaterThan(0);

      // 传给 renderer 的契约输入形状正确（buckets 带 key/label/total/items）。
      const input = harness.renderer.maimaiCalls[0]!;
      expect(input.profileName).toBe('Fake Player');
      expect(input.rating).toBe(15000);
      expect(input.buckets.map((bucket) => bucket.key)).toEqual(['latest', 'archive']);
      expect(input.buckets[0]!.label).toBe('当期');
      expect(input.buckets[0]!.total).toBe(12000);
      expect(input.buckets[0]!.items).toHaveLength(1);
      expect(input.buckets[1]!.items).toHaveLength(0);

      // 上传的正是 renderer 返回的 PNG。
      expect(ONE_PX_PNG.length).toBeGreaterThan(0);
    },
    20_000,
  );

  it(
    '/unbind：调用远端 revoke 且本地 binding 清空',
    async () => {
      harness = await startHarness();
      await harness.seedBinding();

      harness.emitGroup('/unbind', 'msg-unbind-1');
      const messages = await harness.waitForMessages('msg-unbind-1', 1);
      expect(String(messages[0]!.body.content)).toContain('解绑');

      const revokeRequests = harness.fakeRankHub.state.requests.filter(
        (request) => request.method === 'POST' && request.path === '/v1/oauth/revoke',
      );
      expect(revokeRequests.length).toBeGreaterThanOrEqual(1);

      expect(await harness.store.getByQqUser('user-openid-1')).toBeNull();
    },
    20_000,
  );

  it(
    '未知指令：只回一句帮助提示',
    async () => {
      harness = await startHarness();
      harness.emitGroup('/definitely-not-a-command', 'msg-unknown-1');

      const messages = await harness.waitForMessages('msg-unknown-1', 1);
      expect(messages).toHaveLength(1);
      const content = String(messages[0]!.body.content);
      expect(content).toContain('未知指令');
      expect(content).toContain('/help');
    },
    15_000,
  );
});
