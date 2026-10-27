/**
 * /status /状态：绑定信息 + QQ 网关 identity + 最近一次 RankHub API 耗时。
 *
 * 只读本地状态，不主动调 RankHub（避免用户只是想看状态却触发令牌刷新）。
 */
import type { CommandHandler } from './common.js';
import { formatDateTime, sendText } from './common.js';

export const statusCommand: CommandHandler = async (services, ctx) => {
  const binding = await services.store.getByQqUser(ctx.event.userOpenid);
  const identity = services.qq.identity();
  const metric = services.runtime.lastApiMetric();

  const lines: string[] = ['运行状态：'];
  if (binding === null) {
    lines.push('绑定：未绑定（发送 /bind 绑定 RankHub）');
  } else {
    const statusText = binding.status === 'revoked' ? '已失效（请重新 /bind）' : '正常';
    lines.push(`绑定：${statusText}`);
    lines.push(`RankHub 用户：${binding.rankhubName ?? binding.rankhubSubject}`);
    lines.push(`绑定时间：${formatDateTime(new Date(binding.createdAt).toISOString())}`);
  }

  lines.push(
    identity === null
      ? 'QQ 网关：未连接'
      : `QQ 网关：${identity.username}（${identity.id}）`,
  );
  lines.push(
    metric === null
      ? '最近一次 RankHub API：暂未调用'
      : `最近一次 RankHub API：${metric.label} ${metric.durationMs} ms（${formatDateTime(
          new Date(metric.at).toISOString(),
        )}）`,
  );

  await sendText(services, ctx, lines.join('\n'));
};
