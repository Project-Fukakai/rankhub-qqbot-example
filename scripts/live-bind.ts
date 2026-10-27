/**
 * 本机绑定联调：生成二维码 PNG → 轮询 App 确认 → 换令牌 → 写库（qqUserOpenid=local-live-verify）。
 *
 * 用途：QQ 图片链未验证/不可用时，先把 RankHub 授权 + 令牌 + 入库跑通；
 * 之后 `pnpm live:verify` 会用这条 binding 拉真实数据渲染 b50/rks。
 *
 * 用法：`pnpm exec tsx scripts/live-bind.ts`
 * 产物：`evidence/qqbot/live/bind-qr.png`（二维码）+ 终端打印深链；不打印任何令牌。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../src/config/index.js';
import {
  codeFromResumeUrl,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  pollAuthorizationStatus,
} from '../src/rankhub/oauth-code.js';
import { UNKNOWN_SUBJECT } from '../src/rankhub/index.js';
import { createRankHubClient } from '../src/rankhub/index.js';
import { createBindingStore } from '../src/store/index.js';

const LOCAL_OPENID = 'local-live-verify';
const config = loadConfig();
const store = createBindingStore(config);
const rankhub = createRankHubClient(config, { store });
const outDir = join(config.rootDir, 'evidence', 'qqbot', 'live');
mkdirSync(outDir, { recursive: true });

function decodeQr(dataUrl: string | null): Buffer | null {
  if (dataUrl === null) return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (match === null || match[1] === undefined) return null;
  return Buffer.from(match[1], 'base64');
}

async function main(): Promise<void> {
  const state = randomBytes(16).toString('base64url');
  const request = await createAuthorizationRequest(
    {
      RANKHUB_AUTH_BASE: config.RANKHUB_AUTH_BASE,
      RANKHUB_CLIENT_ID: config.RANKHUB_CLIENT_ID,
      RANKHUB_CLIENT_SECRET: config.RANKHUB_CLIENT_SECRET,
    },
    {
      redirectUri: config.RANKHUB_REDIRECT_URI,
      scope: config.RANKHUB_SCOPES,
      state,
    },
  );

  const qr = decodeQr(request.qrDataUrl);
  if (qr === null) throw new Error('服务端没有下发二维码');
  const qrPath = join(outDir, 'bind-qr.png');
  writeFileSync(qrPath, qr);
  console.log(JSON.stringify({ step: 'qr', path: qrPath, bytes: qr.length }));
  console.log(JSON.stringify({ step: 'deepLink', link: request.deepLink }));

  const deadline = Math.min(request.expiresAt, Date.now() + config.RANKHUB_DEVICE_POLL_MAX_SECONDS * 1000);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const status = await pollAuthorizationStatus(
      {
        RANKHUB_AUTH_BASE: config.RANKHUB_AUTH_BASE,
        RANKHUB_CLIENT_ID: config.RANKHUB_CLIENT_ID,
        RANKHUB_CLIENT_SECRET: config.RANKHUB_CLIENT_SECRET,
      },
      request.pollToken,
    );
    if (status.status === 'pending') continue;
    if (status.status !== 'approved') {
      console.error(JSON.stringify({ step: 'status', status: status.status }));
      process.exitCode = 2;
      return;
    }
    const code = codeFromResumeUrl(status.resumeUrl);
    if (code === null) throw new Error('resumeUrl 缺 code');
    const tokens = await exchangeAuthorizationCode(
      {
        RANKHUB_AUTH_BASE: config.RANKHUB_AUTH_BASE,
        RANKHUB_CLIENT_ID: config.RANKHUB_CLIENT_ID,
        RANKHUB_CLIENT_SECRET: config.RANKHUB_CLIENT_SECRET,
      },
      { code, redirectUri: config.RANKHUB_REDIRECT_URI },
    );
    let name: string | null = null;
    let subject = UNKNOWN_SUBJECT;
    try {
      const identity = await rankhub.userinfo(tokens.accessToken);
      name = identity.name;
      subject = identity.subject;
    } catch {
      /* userinfo 失败不阻断 */
    }
    await store.upsert({
      qqUserOpenid: LOCAL_OPENID,
      unionOpenid: null,
      rankhubSubject: subject,
      rankhubName: name,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessExpiresAt: Date.now() + Math.max(30, tokens.expiresIn) * 1000,
      scopes: tokens.scope === '' ? config.RANKHUB_SCOPES : tokens.scope,
    });
    console.log(JSON.stringify({ step: 'bound', name, expiresIn: tokens.expiresIn }));
    return;
  }
  console.error(JSON.stringify({ step: 'timeout' }));
  process.exitCode = 3;
}

main()
  .catch((error: unknown) => {
    console.error(JSON.stringify({ step: 'fatal', error: (error as Error).message }));
    process.exitCode = 1;
  })
  .finally(() => store.close());
