/**
 * /unbind /解绑：撤销 RankHub 令牌并删除本地 binding。
 *
 * 远端失败也要删本地（用户意图是“断开”），但会在回复里说明远端撤销失败。
 */
import { RankHubError } from '../contracts/index.js';

import type { CommandHandler } from './common.js';
import { NOT_BOUND_TEXT, sendText, timed } from './common.js';

export const unbindCommand: CommandHandler = async (services, ctx) => {
  const binding = await services.store.getByQqUser(ctx.event.userOpenid);
  if (binding === null) {
    await sendText(services, ctx, NOT_BOUND_TEXT);
    return;
  }

  let revoked = false;
  try {
    // 优先用 refresh token 撤销（RFC 7009 允许撤销任意令牌；撤 refresh 会连带撤整个 token family），
    // 解密失败才回退到 authorize（按需刷新）拿 access token。
    let token: string;
    try {
      token = services.store.decryptRefreshToken(binding);
    } catch (cipherError) {
      ctx.logger.warn('读取 refresh token 失败，回退用 access token 撤销', {
        reason: cipherError instanceof Error ? cipherError.message : String(cipherError),
      });
      token = await timed(services, 'authorize', () => services.rankhub.authorize(binding));
    }
    await timed(services, 'revoke', () => services.rankhub.revoke(token));
    revoked = true;
  } catch (error) {
    if (error instanceof RankHubError && (error.code === 'invalid_grant' || error.code === 'unauthorized')) {
      // 远端已经失效，等价于撤销成功。
      revoked = true;
    } else {
      ctx.logger.warn('远端撤销令牌失败，继续删除本地绑定', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await services.store.deleteByQqUser(ctx.event.userOpenid);
  services.runtime.cancelBindTask(ctx.event.userOpenid);

  await sendText(
    services,
    ctx,
    revoked
      ? '已解绑 RankHub 账号，并已撤销授权。需要时再发送 /bind 重新绑定。'
      : '已在本地解绑。远端授权撤销失败（令牌会在过期后自然失效），如需彻底撤销请到 RankHub 账号设置里操作。',
  );
};
