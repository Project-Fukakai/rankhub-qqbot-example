/**
 * 真实 RankHub 数据联调（只在本地有 active binding 时使用）：
 *   读取 data/bot.db 的第一条 active binding → 刷新 access → listGames/profiles/bests
 *   → 渲染 maimai b50 与 phigros rks → 写 evidence/qqbot/live/。
 *
 * 不打印任何令牌；只打印档案名、rating、条数、图片字节数与尺寸。
 *
 * 用法：`pnpm exec tsx scripts/live-verify.ts [maimai|phigros|all]`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRenderer } from '../src/bot/renderer.js';
import { loadConfig } from '../src/config/index.js';
import type { Binding, GameProfile } from '../src/contracts/index.js';
import { createLogger } from '../src/logger/index.js';
import { createRankHubClient } from '../src/rankhub/index.js';
import { createBindingStore, DatabaseSyncCtor } from '../src/store/index.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, { app: 'live-verify' });
const store = createBindingStore(config);
const rankhub = createRankHubClient(config, { store, logger });
const outDir = join(config.rootDir, 'evidence', 'qqbot', 'live');
mkdirSync(outDir, { recursive: true });

const only = (process.argv[2] ?? 'all') as 'maimai' | 'phigros' | 'all';

function firstActiveBindingId(): string | null {
  const db = new DatabaseSyncCtor(config.DB_PATH);
  try {
    const row = db
      .prepare("select id from bindings where status='active' order by updated_at desc limit 1")
      .get() as { id?: string } | undefined;
    return row?.id ?? null;
  } finally {
    db.close();
  }
}

function pickLatest(profiles: GameProfile[]): GameProfile | null {
  if (profiles.length === 0) return null;
  return [...profiles].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
}

async function main(): Promise<void> {
  const id = firstActiveBindingId();
  if (id === null) {
    console.error('没有 active binding：先在 QQ 里跑 /bind 完成绑定');
    process.exitCode = 2;
    return;
  }
  const binding: Binding | null = await store.getById(id);
  if (binding === null) throw new Error('binding 读不到');

  const accessToken = await rankhub.authorize(binding);
  const games = await rankhub.listGames(accessToken);
  console.log(JSON.stringify({ step: 'listGames', games: games.map((g) => g.game), count: games.length }));

  const renderer = await createRenderer(config, logger);
  try {
    if (only === 'maimai' || only === 'all') {
      const profiles = await rankhub.listProfiles(accessToken, 'maimai');
      const profile = pickLatest(profiles);
      console.log(JSON.stringify({ step: 'maimai.profiles', count: profiles.length, picked: profile?.player.name ?? null }));
      if (profile !== null) {
        const bests = await rankhub.getBests(accessToken, 'maimai', profile.profileId);
        const items = bests.buckets.reduce((sum, b) => sum + b.items.length, 0);
        const rating = typeof bests.totals.total === 'number' ? bests.totals.total : (profile.player.rating ?? 0);
        console.log(JSON.stringify({ step: 'maimai.bests', buckets: bests.buckets.map((b) => ({ key: b.key, label: b.label, total: b.total, items: b.items.length })), items }));
        const image = await renderer.renderMaimaiB50({
          profileName: profile.player.name ?? 'Player',
          rating,
          buckets: bests.buckets.map((b) => ({ key: b.key, label: b.label, total: b.total, items: b.items })),
          totals: bests.totals,
          computedAt: bests.computedAt,
        });
        const path = join(outDir, 'live-maimai-b50.png');
        writeFileSync(path, image);
        console.log(JSON.stringify({ step: 'maimai.render', bytes: image.length, path }));
      }
    }

    if (only === 'phigros' || only === 'all') {
      const profiles = await rankhub.listProfiles(accessToken, 'phigros');
      const profile = pickLatest(profiles);
      console.log(JSON.stringify({ step: 'phigros.profiles', count: profiles.length, picked: profile?.player.name ?? null }));
      if (profile !== null) {
        const bests = await rankhub.getBests(accessToken, 'phigros', profile.profileId);
        const phi = bests.buckets.find((b) => b.key === 'phi')?.items ?? [];
        const best = bests.buckets.find((b) => b.key === 'best30')?.items ?? [];
        console.log(JSON.stringify({ step: 'phigros.bests', totals: bests.totals, phi: phi.length, best30: best.length }));
        const image = await renderer.renderPhigrosRks({
          profileName: profile.player.name ?? 'Player',
          rks: typeof bests.totals.rks === 'number' ? bests.totals.rks : 0,
          officialRks: typeof bests.totals.officialRks === 'number' ? bests.totals.officialRks : null,
          phi,
          best,
          computedAt: bests.computedAt,
        });
        const path = join(outDir, 'live-phigros-rks.png');
        writeFileSync(path, image);
        console.log(JSON.stringify({ step: 'phigros.render', bytes: image.length, path }));
      }
    }
  } finally {
    await renderer.close();
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ step: 'fatal', error: (error as Error).message }));
  process.exitCode = 1;
});
