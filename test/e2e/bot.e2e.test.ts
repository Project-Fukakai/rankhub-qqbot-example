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
    '/bind：设备码 → 模拟批准 → 同一 msg_id 的 msg_seq=2 成功文案 + 加密入库',
    async () => {
      const manual = createManualSleep();
      harness = await startHarness({ sleep: manual.sleep });

      harness.emitGroup('/bind', 'msg-bind-1');
      const firstMessages = await harness.waitForMessages('msg-bind-1', 1);
      const first = firstMessages[0]!;
      expect(first.body.msg_seq).toBe(1);

      // 假 RankHub 在 device_authorization 时生成 user_code；回复里必须带上。
      const devices = [...harness.fakeRankHub.state.devices.values()];
      expect(devices).toHaveLength(1);
      const device = devices[0]!;
      const firstContent = String(first.body.content);
      expect(firstContent).toContain(device.userCode);
      expect(firstContent).toContain('/oauth/device');

      // 等后台轮询进入 sleep，再模拟用户在 App 内批准。
      await waitFor(() => manual.pending() >= 1, '后台设备码轮询进入等待');
      harness.fakeRankHub.setDeviceStatus(device.deviceCode, 'approved');
      manual.release();

      const allMessages = await harness.waitForMessages('msg-bind-1', 2);
      expect(allMessages).toHaveLength(2);
      const second = allMessages[1]!;
      expect(second.body.msg_id).toBe('msg-bind-1');
      expect(second.body.msg_seq).toBe(2);
      const secondContent = String(second.body.content);
      expect(secondContent).toContain('绑定成功');
      expect(secondContent).toContain('Fake User');

      // 入库：binding 存在，且令牌是密文（不是明文 at_/rt_）。
      const binding = await harness.store.getByQqUser('user-openid-1');
      expect(binding).not.toBeNull();
      expect(binding!.status).toBe('active');
      expect(binding!.rankhubName).toBe('Fake User');
      expect(binding!.refreshTokenEnc).toMatch(/^v1\./);
      expect(binding!.refreshTokenEnc).not.toContain('rt_');
      expect(binding!.accessTokenEnc ?? '').toMatch(/^v1\./);
      expect(binding!.accessTokenEnc ?? '').not.toContain('at_');

      // pending 已清理。
      expect(await harness.store.getPendingDevice('user-openid-1')).toBeNull();
    },
    20_000,
  );

  it(
    '/bind：slow_down 后继续轮询，仍能用 msg_seq=2 报绑定成功',
    async () => {
      const manual = createManualSleep();
      harness = await startHarness({ sleep: manual.sleep });

      harness.emitGroup('/bind', 'msg-bind-slow-1');
      await harness.waitForMessages('msg-bind-slow-1', 1);
      const device = [...harness.fakeRankHub.state.devices.values()][0]!;

      await waitFor(() => manual.pending() >= 1, '第一次设备码轮询等待');
      // 服务端第一次返回 slow_down（200 + error），客户端必须加间隔继续，而不是终止。
      device.slowDownPolls = 1;
      harness.fakeRankHub.setDeviceStatus(device.deviceCode, 'approved');
      manual.release();

      await waitFor(() => manual.pending() >= 1, 'slow_down 后第二次轮询等待');
      manual.release();

      const messages = await harness.waitForMessages('msg-bind-slow-1', 2);
      expect(messages[1]!.body.msg_seq).toBe(2);
      expect(String(messages[1]!.body.content)).toContain('绑定成功');
    },
    20_000,
  );

  it(
    '/bind：用户拒绝 → 明确文案 + 清理 pending',
    async () => {
      const manual = createManualSleep();
      harness = await startHarness({ sleep: manual.sleep });
      harness.emitGroup('/bind', 'msg-bind-denied-1');
      await harness.waitForMessages('msg-bind-denied-1', 1);
      const device = [...harness.fakeRankHub.state.devices.values()][0]!;

      await waitFor(() => manual.pending() >= 1, '设备码轮询等待');
      harness.fakeRankHub.setDeviceStatus(device.deviceCode, 'denied');
      manual.release();

      const messages = await harness.waitForMessages('msg-bind-denied-1', 2);
      expect(String(messages[1]!.body.content)).toContain('拒绝');
      expect(await harness.store.getPendingDevice('user-openid-1')).toBeNull();
    },
    20_000,
  );

  it(
    '/bind：设备码过期 → 明确文案 + 清理 pending',
    async () => {
      const manual = createManualSleep();
      harness = await startHarness({ sleep: manual.sleep });
      harness.emitGroup('/bind', 'msg-bind-expired-1');
      await harness.waitForMessages('msg-bind-expired-1', 1);
      const device = [...harness.fakeRankHub.state.devices.values()][0]!;

      await waitFor(() => manual.pending() >= 1, '设备码轮询等待');
      harness.fakeRankHub.setDeviceStatus(device.deviceCode, 'expired');
      manual.release();

      const messages = await harness.waitForMessages('msg-bind-expired-1', 2);
      expect(String(messages[1]!.body.content)).toContain('过期');
      expect(await harness.store.getPendingDevice('user-openid-1')).toBeNull();
    },
    20_000,
  );

  it(
    '/bind：超过轮询上限 → 超时文案 + 清理 pending',
    async () => {
      const manual = createManualSleep();
      let clock = 1_700_000_000_000;
      harness = await startHarness({ sleep: manual.sleep, now: () => clock });

      harness.emitGroup('/bind', 'msg-bind-timeout-1');
      await harness.waitForMessages('msg-bind-timeout-1', 1);
      expect([...harness.fakeRankHub.state.devices.values()]).toHaveLength(1);

      await waitFor(() => manual.pending() >= 1, '设备码轮询等待');
      // 跳过 RANKHUB_DEVICE_POLL_MAX_SECONDS（240s）后再放行一次轮询。
      clock += 241_000;
      manual.release();

      const messages = await harness.waitForMessages('msg-bind-timeout-1', 2);
      expect(String(messages[1]!.body.content)).toContain('绑定超时');
      expect(await harness.store.getPendingDevice('user-openid-1')).toBeNull();
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

      expect(imageMessage.body.msg_id).toBe('msg-b50-1');
      expect(imageMessage.body.msg_seq).toBe(1);
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
