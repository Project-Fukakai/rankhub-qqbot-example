/**
 * 真实 QQ 冒烟（只读）：
 *   1. 取 app access token（检查 HTTP 200 + body.code 业务错误）
 *   2. GET /users/@me 验证凭证
 *   3. GET /gateway/bot 验证网关地址可达
 * 只打印 id/username/url 的 host，不打印任何 token。
 */
import { loadConfig } from '../src/config/index.js';

const config = loadConfig();

async function main(): Promise<void> {
  const tokenRes = await fetch(config.QQ_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId: config.QQ_APP_ID, clientSecret: config.QQ_APP_SECRET }),
  });
  const tokenBody = (await tokenRes.json()) as {
    access_token?: string;
    expires_in?: number | string;
    code?: number;
    message?: string;
  };
  if (!tokenRes.ok || (tokenBody.code !== undefined && tokenBody.code !== 0)) {
    console.error(
      JSON.stringify({
        step: 'getAppAccessToken',
        http: tokenRes.status,
        code: tokenBody.code ?? null,
        message: tokenBody.message ?? null,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const accessToken = tokenBody.access_token;
  if (!accessToken) {
    console.error(JSON.stringify({ step: 'getAppAccessToken', error: 'no access_token' }));
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      step: 'getAppAccessToken',
      ok: true,
      expiresIn: Number(tokenBody.expires_in),
      tokenPrefix: accessToken.slice(0, 4) + '…',
    }),
  );

  const meRes = await fetch(`${config.QQ_API_BASE}/users/@me`, {
    headers: { authorization: `QQBot ${accessToken}` },
  });
  const meBody = (await meRes.json()) as Record<string, unknown>;
  console.log(
    JSON.stringify({
      step: 'users/@me',
      http: meRes.status,
      id: meBody.id ?? null,
      username: meBody.username ?? null,
      bot: meBody.bot ?? null,
      keys: Object.keys(meBody),
    }),
  );

  const gwRes = await fetch(`${config.QQ_API_BASE}/gateway/bot`, {
    headers: { authorization: `QQBot ${accessToken}` },
  });
  const gwText = await gwRes.text();
  let gwHost: string | null = null;
  let shards: unknown = null;
  try {
    const gwBody = JSON.parse(gwText) as { url?: string; shards?: unknown };
    gwHost = gwBody.url ? new URL(gwBody.url).host : null;
    shards = gwBody.shards ?? null;
  } catch {
    /* 非 JSON 时只报状态码 */
  }
  console.log(
    JSON.stringify({
      step: 'gateway/bot',
      http: gwRes.status,
      host: gwHost,
      shards,
      rawLength: gwText.length,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ step: 'fatal', error: (error as Error).message }));
  process.exitCode = 1;
});
