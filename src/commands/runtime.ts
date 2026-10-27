/**
 * 指令层运行期状态：内存缓存、API 耗时指标、后台绑定轮询任务的生命周期。
 *
 * 生命周期只挂在 createBot 返回的 Bot 上：`stop()` 会 abort 所有后台轮询并等待收尾，
 * 避免进程退出时还有定时器/网络请求在跑。
 */
import type { GameProfile, GameScore } from '../contracts/index.js';
import type { Logger } from '../logger/index.js';

interface CacheEntry<T> {
  at: number;
  value: T;
}

export interface ApiMetric {
  label: string;
  durationMs: number;
  at: number;
}

interface BindTask {
  controller: AbortController;
  task: Promise<void>;
}

const MAX_CACHE_ENTRIES = 500;

export class CommandRuntime {
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly profileCache = new Map<string, CacheEntry<GameProfile[]>>();
  private readonly scoreCache = new Map<string, CacheEntry<GameScore[]>>();
  private readonly binds = new Map<string, BindTask>();
  private lastApi: ApiMetric | null = null;
  private closed = false;

  constructor(now: () => number, logger: Logger) {
    this.now = now;
    this.logger = logger;
  }

  /** 最近一次 RankHub API 调用的耗时。 */
  lastApiMetric(): ApiMetric | null {
    return this.lastApi;
  }

  recordApi(label: string, durationMs: number): void {
    this.lastApi = { label, durationMs, at: this.now() };
  }

  getProfiles(bindingId: string, game: string, ttlMs = 60_000): GameProfile[] | null {
    return this.read(this.profileCache, `${bindingId}:${game}`, ttlMs);
  }

  setProfiles(bindingId: string, game: string, profiles: GameProfile[]): void {
    this.write(this.profileCache, `${bindingId}:${game}`, profiles);
  }

  getScores(
    bindingId: string,
    game: string,
    profileId: string,
    ttlMs = 5 * 60_000,
  ): GameScore[] | null {
    return this.read(this.scoreCache, `${bindingId}:${game}:${profileId}`, ttlMs);
  }

  setScores(bindingId: string, game: string, profileId: string, scores: GameScore[]): void {
    this.write(this.scoreCache, `${bindingId}:${game}:${profileId}`, scores);
  }

  /**
   * 注册一个后台绑定轮询任务。
   *
   * - 同一 QQ 用户只保留一个：新 /bind 会先 abort 旧任务（旧任务自行静默退出）；
   * - 任务内部的异常在这里兜底记日志，不会变成 unhandled rejection。
   */
  registerBindTask(qqUserOpenid: string, controller: AbortController, task: Promise<void>): void {
    this.cancelBindTask(qqUserOpenid);
    const safeTask = task.catch((error: unknown) => {
      this.logger.error('后台绑定任务失败', {
        qqUserOpenid,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    const entry: BindTask = { controller, task: safeTask };
    this.binds.set(qqUserOpenid, entry);
    void safeTask.finally(() => {
      if (this.binds.get(qqUserOpenid) === entry) this.binds.delete(qqUserOpenid);
    });
  }

  /** 主动取消某个用户的 pending 绑定（新 /bind 覆盖旧流程）。 */
  cancelBindTask(qqUserOpenid: string): void {
    const existing = this.binds.get(qqUserOpenid);
    if (existing === undefined) return;
    this.binds.delete(qqUserOpenid);
    existing.controller.abort();
  }

  /** 停机关闭：abort 全部后台任务并等待它们退出。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const tasks = [...this.binds.values()];
    this.binds.clear();
    for (const entry of tasks) entry.controller.abort();
    await Promise.allSettled(tasks.map((entry) => entry.task));
  }

  private read<T>(cache: Map<string, CacheEntry<T>>, key: string, ttlMs: number): T | null {
    const entry = cache.get(key);
    if (entry === undefined) return null;
    if (this.now() - entry.at >= ttlMs) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  private write<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(key, { at: this.now(), value });
  }
}
