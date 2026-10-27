/**
 * /bind /绑定：设备码 OAuth 绑定。
 *
 * 流程：
 * 1. `deviceStart(RANKHUB_SCOPES)` → 立即被动回复 user_code + verification_uri_complete（msg_seq=1）；
 * 2. 后台按服务端 `interval` 轮询（slow_down 加间隔），总时长 ≤ RANKHUB_DEVICE_POLL_MAX_SECONDS；
 * 3. 成功：加密入库 + 用**同一入站消息**再发一条“绑定成功：<name>”（传输层 msg_seq 自增 = 2）；
 * 4. denied / expired / 超时分别给明确文案；每个 QQ 用户只保留一个 pending（新 /bind 覆盖并 abort 旧的）。
 *
 * `services.sleep` 可注入：E2E 用可控的 sleep 把“等用户批准”变成确定性步骤。
 */
import { RankHubError, type DeviceAuthorization } from '../contracts/index.js';
import { UNKNOWN_SUBJECT } from '../rankhub/index.js';

import type { CommandContext, CommandHandler, CommandServices } from './common.js';
import { safeSendText, sendText, timed } from './common.js';

/** 可重试的轮询错误：网络抖动 / 服务端异常 / 限流都不终止 10 分钟窗口。 */
const RETRYABLE_POLL_CODES = new Set(['network_error', 'server_error', 'rate_limited']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 返回 false 表示被 abort 打断（停机 / 新 /bind 覆盖）。 */
async function sleepOrAbort(
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal,
  ms: number,
): Promise<boolean> {
  if (signal.aborted) return false;
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const slept = await Promise.race([sleep(ms).then(() => true), aborted]);
    return slept && !signal.aborted;
  } finally {
    if (onAbort !== null) signal.removeEventListener('abort', onAbort);
  }
}

async function cleanupAndReply(
  services: CommandServices,
  ctx: CommandContext,
  text: string,
): Promise<void> {
  try {
    await services.store.deletePendingDevice(ctx.event.userOpenid);
  } catch (error) {
    ctx.logger.warn('清理 pending 设备码失败', { reason: errorMessage(error) });
  }
  await safeSendText(services, ctx, text);
}

async function pollDevice(
  services: CommandServices,
  ctx: CommandContext,
  authorization: DeviceAuthorization,
  signal: AbortSignal,
): Promise<void> {
  const openid = ctx.event.userOpenid;
  const maxSeconds = Math.min(
    Math.max(1, authorization.expiresIn),
    Math.max(1, services.config.RANKHUB_DEVICE_POLL_MAX_SECONDS),
  );
  const deadline = services.now() + maxSeconds * 1000;
  let intervalMs = Math.max(1, authorization.interval) * 1000;

  const timeoutText = `绑定超时（${Math.round(maxSeconds / 60)} 分钟内未完成），请重新发送 /bind。`;
  const failureText = '绑定失败：RankHub 返回了异常响应，请稍后重新发送 /bind。';

  if (services.now() >= deadline) {
    await cleanupAndReply(services, ctx, timeoutText);
    return;
  }

  while (!signal.aborted) {
    const slept = await sleepOrAbort(services.sleep, signal, intervalMs);
    if (!slept || signal.aborted) return;
    if (services.now() >= deadline) {
      await cleanupAndReply(services, ctx, timeoutText);
      return;
    }

    let result;
    try {
      result = await timed(services, 'devicePoll', () =>
        services.rankhub.devicePoll(authorization.deviceCode),
      );
    } catch (error) {
      const code = error instanceof RankHubError ? error.code : 'network_error';
      if (RETRYABLE_POLL_CODES.has(code)) {
        ctx.logger.warn('设备码轮询暂时失败，继续重试', { code });
        continue;
      }
      ctx.logger.warn('设备码轮询失败，终止绑定', { code, reason: errorMessage(error) });
      await cleanupAndReply(services, ctx, failureText);
      return;
    }

    if (result.status === 'pending') continue;
    if (result.status === 'slow_down') {
      intervalMs = Math.max(intervalMs, Math.max(1, result.interval) * 1000);
      continue;
    }
    if (result.status === 'denied') {
      await cleanupAndReply(services, ctx, '你已拒绝本次绑定。如需绑定，请重新发送 /bind。');
      return;
    }
    if (result.status === 'expired') {
      await cleanupAndReply(services, ctx, '设备码已过期，请重新发送 /bind 获取新的设备码。');
      return;
    }

    // status === 'ok'
    try {
      const tokens = result.tokens;
      const identity = await timed(services, 'userinfo', () =>
        services.rankhub.userinfo(tokens.accessToken),
      );
      const displayName =
        identity.name ??
        (identity.subject === UNKNOWN_SUBJECT ? 'RankHub 用户' : identity.subject);
      const issuedAt = services.now();
      await services.store.upsert({
        qqUserOpenid: openid,
        unionOpenid: null,
        rankhubSubject: identity.subject,
        rankhubName: identity.name,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessExpiresAt: issuedAt + tokens.expiresIn * 1000,
        scopes: tokens.scope !== '' ? tokens.scope : services.config.RANKHUB_SCOPES,
      });
      await services.store.deletePendingDevice(openid);
      await safeSendText(
        services,
        ctx,
        `绑定成功：${displayName}\n现在可以使用 /b50、/rks、/me 等指令了。`,
      );
    } catch (error) {
      ctx.logger.error('绑定成功但写入本地存储失败', { reason: errorMessage(error) });
      await cleanupAndReply(services, ctx, '绑定流程出错（本地存储写入失败），请重新发送 /bind。');
    }
    return;
  }
}

export const bindCommand: CommandHandler = async (services, ctx) => {
  const openid = ctx.event.userOpenid;
  // 同一 QQ 用户只保留一个 pending：新 /bind 覆盖旧的（旧轮询静默退出）。
  services.runtime.cancelBindTask(openid);

  const authorization = await timed(services, 'deviceAuthorization', () =>
    services.rankhub.deviceStart(services.config.RANKHUB_SCOPES),
  );

  const createdAt = services.now();
  await services.store.savePendingDevice({
    qqUserOpenid: openid,
    unionOpenid: null,
    deviceCode: authorization.deviceCode,
    userCode: authorization.userCode,
    expiresAt: createdAt + Math.max(1, authorization.expiresIn) * 1000,
    createdAt,
    messageId: ctx.event.messageId,
    groupOpenid: ctx.event.groupOpenid,
    nextReplySeq: 2,
  });

  const minutes = Math.max(1, Math.round(Math.max(1, authorization.expiresIn) / 60));
  await sendText(
    services,
    ctx,
    [
      `请在 ${minutes} 分钟内完成 RankHub 绑定：`,
      `1. 打开链接：${authorization.verificationUriComplete}`,
      `2. 确认设备码：${authorization.userCode}`,
      '绑定成功后我会在本会话再回复一条「绑定成功」。',
    ].join('\n'),
  );

  const controller = new AbortController();
  services.runtime.registerBindTask(
    openid,
    controller,
    pollDevice(services, ctx, authorization, controller.signal),
  );
};
