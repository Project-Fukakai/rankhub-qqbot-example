/**
 * /bind /绑定：RankHub 授权码 + App 确认（服务端到服务端，不依赖设备的确认页）。
 *
 * 为什么不用设备码：
 * `rankhub_net` 的 `POST /v1/oauth/device_authorization` 在写 `device_code` artifact 时没有
 * 写 `clientId` metadata，而确认页（`v1oauthreq_device.go`）从 `deviceArtifact.Metadata`
 * 读取它 ⇒ 所有设备码在确认页都报 “device authorization is missing its client id”。
 * 服务端修复见 `rankhub_net` 分支 `fix/identity-device-flow-20261027`（未部署前用本链路）。
 *
 * 流程：
 * 1. `POST {AUTH}/v1/interaction/oauth-authorizations` 建授权请求（带 redirect_uri/scope/state）
 *    → pollToken + deepLink + 二维码；
 * 2. 被动回复 #1 说明、#2 二维码图片（用户用 RankHub App 扫码确认）；
 * 3. 轮询 status：approved 时从 `resumeUrl` 取一次性 code → `authorization_code` 换令牌；
 * 4. userinfo → 加密入库 → 被动回复 #3「绑定成功：<name>」。
 *
 * 不需要浏览器、不需要监听端口；`redirect_uri` 只作为 code 的载体（已注册回环地址）。
 */
import { randomBytes } from 'node:crypto';

import { RankHubError } from '../contracts/index.js';
import {
  codeFromResumeUrl,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  pollAuthorizationStatus,
} from '../rankhub/oauth-code.js';
import { UNKNOWN_SUBJECT } from '../rankhub/index.js';

import type { CommandContext, CommandHandler, CommandServices } from './common.js';
import { safeSendText, sendImage, sendText, timed } from './common.js';

/** 可重试的轮询错误：网络抖动 / 服务端异常 / 限流都不终止窗口。 */
const RETRYABLE_POLL_CODES = new Set(['network_error', 'server_error', 'rate_limited']);

/** 轮询间隔（秒）：服务端二维码有效期 10 分钟，3 秒足够灵敏且不触发风控。 */
const POLL_INTERVAL_MS = 3000;

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

/** 把 `data:image/png;base64,…` 解成 Buffer；不是合法 PNG 时返回 null。 */
export function decodeQrDataUrl(dataUrl: string | null): Buffer | null {
  if (dataUrl === null) return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (match === null || match[1] === undefined) return null;
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length < 8 || buffer[0] !== 0x89 || buffer.toString('ascii', 1, 4) !== 'PNG') {
    return null;
  }
  return buffer;
}

interface RankHubAuthConfig {
  RANKHUB_AUTH_BASE: string;
  RANKHUB_CLIENT_ID: string;
  RANKHUB_CLIENT_SECRET: string;
}

function authConfig(services: CommandServices): RankHubAuthConfig {
  return {
    RANKHUB_AUTH_BASE: services.config.RANKHUB_AUTH_BASE,
    RANKHUB_CLIENT_ID: services.config.RANKHUB_CLIENT_ID,
    RANKHUB_CLIENT_SECRET: services.config.RANKHUB_CLIENT_SECRET,
  };
}

async function pollUntilApproved(
  services: CommandServices,
  ctx: CommandContext,
  request: { pollToken: string; expiresAt: number },
  controller: AbortController,
): Promise<void> {
  const openid = ctx.event.userOpenid;
  const maxSeconds = Math.max(
    30,
    Math.min(
      services.config.RANKHUB_DEVICE_POLL_MAX_SECONDS,
      Math.floor((request.expiresAt - services.now()) / 1000),
    ),
  );
  const deadline = Math.min(request.expiresAt, services.now() + maxSeconds * 1000);

  while (!controller.signal.aborted) {
    if (services.now() >= deadline) {
      await safeSendText(
        services,
        ctx,
        `绑定超时（${Math.max(1, Math.round(maxSeconds / 60))} 分钟内未在 App 确认），请重新发送 /bind。`,
      );
      return;
    }
    const slept = await sleepOrAbort(services.sleep, controller.signal, POLL_INTERVAL_MS);
    if (!slept || controller.signal.aborted) return;

    let status;
    try {
      status = await timed(services, 'pollAuthorizationStatus', () =>
        pollAuthorizationStatus(authConfig(services), request.pollToken),
      );
    } catch (error) {
      const code = error instanceof RankHubError ? error.code : 'network_error';
      if (RETRYABLE_POLL_CODES.has(code)) {
        ctx.logger.warn('授权状态轮询暂时失败，继续重试', { code });
        continue;
      }
      ctx.logger.warn('授权状态轮询失败，终止绑定', { code, reason: errorMessage(error) });
      await safeSendText(services, ctx, '绑定失败：RankHub 返回了异常响应，请稍后重新 /bind。');
      return;
    }

    if (status.status === 'pending') continue;
    if (status.status === 'denied') {
      await safeSendText(services, ctx, '你已拒绝本次绑定。如需绑定，请重新发送 /bind。');
      return;
    }
    if (status.status === 'expired' || status.status === 'cancelled' || status.status === 'consumed') {
      await safeSendText(services, ctx, '本次授权已失效，请重新发送 /bind 获取新的二维码。');
      return;
    }

    // approved（上面的 pending/denied/expired 都已 return）
    if (status.status !== 'approved') return;
    const code = codeFromResumeUrl(status.resumeUrl);
    if (code === null) {
      ctx.logger.warn('授权通过但 resumeUrl 里没有 code');
      await safeSendText(services, ctx, '绑定失败：授权响应缺少 code，请重新 /bind。');
      return;
    }

    let tokens;
    try {
      tokens = await timed(services, 'exchangeAuthorizationCode', () =>
        exchangeAuthorizationCode(authConfig(services), {
          code,
          redirectUri: services.config.RANKHUB_REDIRECT_URI,
        }),
      );
    } catch (error) {
      ctx.logger.warn('授权码换令牌失败', {
        code: error instanceof RankHubError ? error.code : 'unknown',
        reason: errorMessage(error),
      });
      await safeSendText(services, ctx, '绑定失败：换取令牌时出错，请重新发送 /bind。');
      return;
    }

    let subject = UNKNOWN_SUBJECT;
    let name: string | null = null;
    try {
      const identity = await services.rankhub.userinfo(tokens.accessToken);
      subject = identity.subject;
      name = identity.name;
    } catch (error) {
      ctx.logger.warn('userinfo 获取失败，绑定继续', { reason: errorMessage(error) });
    }

    const expiresAt = services.now() + Math.max(30, tokens.expiresIn) * 1000;
    await services.store.upsert({
      qqUserOpenid: openid,
      unionOpenid: null,
      rankhubSubject: subject,
      rankhubName: name,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessExpiresAt: expiresAt,
      scopes: tokens.scope === '' ? services.config.RANKHUB_SCOPES : tokens.scope,
    });
    await services.store.deletePendingDevice(openid);
    await safeSendText(
      services,
      ctx,
      `绑定成功${name === null ? '' : `：${name}`}。\n可以发送 /b50、/rks、/me 试试。`,
    );
    return;
  }
}

export const bindCommand: CommandHandler = async (services, ctx) => {
  const openid = ctx.event.userOpenid;
  const existing = await services.store.getByQqUser(openid);
  if (existing !== null && existing.status === 'active') {
    await sendText(
      services,
      ctx,
      `你已经绑定过 RankHub 账号${existing.rankhubName === null ? '' : `：${existing.rankhubName}`}。\n` +
        '如需换绑，请先发送 /unbind。',
    );
    return;
  }

  const state = randomBytes(24).toString('base64url');
  let request;
  try {
    request = await timed(services, 'createAuthorizationRequest', () =>
      createAuthorizationRequest(authConfig(services), {
        redirectUri: services.config.RANKHUB_REDIRECT_URI,
        scope: services.config.RANKHUB_SCOPES,
        state,
        target: { source: 'qq', kind: ctx.event.kind },
      }),
    );
  } catch (error) {
    ctx.logger.warn('创建 RankHub 授权请求失败', {
      code: error instanceof RankHubError ? error.code : 'unknown',
      reason: errorMessage(error),
    });
    await sendText(services, ctx, '创建绑定请求失败，请稍后重新发送 /bind。');
    return;
  }

  // #1 文字说明（附带深链，二维码识别不了时可直接点/复制到 App）。
  await sendText(
    services,
    ctx,
    [
      '请在 10 分钟内完成 RankHub 绑定：',
      '1. 用手机上的 RankHub App 扫描下一条消息里的二维码；',
      '2. 在 App 里确认本次授权；',
      '3. 确认成功后我会在这里回复「绑定成功」。',
      `深链：${request.deepLink}`,
    ].join('\n'),
  );

  // #2 二维码图片。
  const qr = decodeQrDataUrl(request.qrDataUrl);
  if (qr !== null) {
    try {
      await sendImage(services, ctx, qr, 'rankhub-bind.png');
    } catch (error) {
      ctx.logger.warn('绑定二维码发送失败', { reason: errorMessage(error) });
    }
  }

  const controller = new AbortController();
  const task = pollUntilApproved(services, ctx, request, controller).catch((error: unknown) => {
    ctx.logger.error('绑定轮询任务异常', { reason: errorMessage(error) });
  });
  services.runtime.registerBindTask(openid, controller, task);
};
