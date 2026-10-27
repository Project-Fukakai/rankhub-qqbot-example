/**
 * 渲染器装配：把 `src/render/mai`（maimai b50）与 `src/render/phi`（phigros rks）
 * 合成契约里的单个 `Renderer`。
 *
 * 设计意图（task-5 与 task-3/4 并行开发时的解耦点）：
 * - 两个 render 模块都可能尚未落地 / 资源未下载 / 浏览器不可用，装配阶段不允许因此崩溃；
 * - 用**动态 import + try/catch** 探测模块，缺哪个就只让对应方法抛
 *   `RendererUnavailableError`，由 commands 层降级成文字摘要（不吞掉原因，logger.warn 留痕）；
 * - 真模块落地后**只需要改本文件**，commands / dispatcher 一行不动。
 */
import type { Logger } from '../logger/index.js';
import type {
  MaimaiB50RenderInput,
  PhigrosRksRenderInput,
  Renderer,
} from '../contracts/index.js';

/** 某个游戏渲染器不可用（模块缺失、资源缺失、浏览器启动失败等）。 */
export class RendererUnavailableError extends Error {
  constructor(
    readonly game: 'maimai' | 'phigros',
    message: string,
  ) {
    super(message);
    this.name = 'RendererUnavailableError';
  }
}

export interface RendererConfigLike {
  RENDER_BROWSER_PATH?: string;
  MAIMAIDX_STATIC?: string;
  PHI_PLUGIN_RES?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RendererLoad<T> {
  renderer: T | null;
  reason: string | null;
}

async function loadMaimai(
  config: RendererConfigLike,
  logger: Logger,
): Promise<RendererLoad<Renderer>> {
  try {
    const module = await import('../render/mai/index.js');
    if (typeof module.createMaimaiRenderer !== 'function') {
      return { renderer: null, reason: 'src/render/mai 缺少 createMaimaiRenderer 导出' };
    }
    const renderer = module.createMaimaiRenderer(
      config.MAIMAIDX_STATIC === undefined ? {} : { assetsDir: config.MAIMAIDX_STATIC },
    );
    logger.info('maimai 渲染器已装配');
    return { renderer, reason: null };
  } catch (error) {
    return { renderer: null, reason: errorMessage(error) };
  }
}

async function loadPhigros(
  config: RendererConfigLike,
  logger: Logger,
): Promise<RendererLoad<Renderer>> {
  try {
    const module = await import('../render/phi/index.js');
    if (typeof module.createPhigrosRenderer !== 'function') {
      return { renderer: null, reason: 'src/render/phi 缺少 createPhigrosRenderer 导出' };
    }
    const options = {
      ...(config.PHI_PLUGIN_RES === undefined ? {} : { resourcesDir: config.PHI_PLUGIN_RES }),
      ...(config.RENDER_BROWSER_PATH === undefined
        ? {}
        : { browserPath: config.RENDER_BROWSER_PATH }),
    };
    const renderer = module.createPhigrosRenderer(options);
    logger.info('phigros 渲染器已装配');
    return { renderer, reason: null };
  } catch (error) {
    return { renderer: null, reason: errorMessage(error) };
  }
}

/**
 * 装配组合渲染器。
 *
 * 两个子渲染器各自独立降级：maimai 缺失不影响 `/rks`，反之亦然。
 * 构造阶段只做「模块是否可 import + 可构造」探测；真正的渲染失败仍会在 render 时抛出，
 * 由 commands 层统一降级（例如 Chromium 启动失败）。
 */
export async function createRenderer(
  config: RendererConfigLike,
  logger: Logger,
): Promise<Renderer> {
  const log = logger.child({ module: 'renderer' });
  const [mai, phi] = await Promise.all([loadMaimai(config, log), loadPhigros(config, log)]);

  if (mai.renderer === null) {
    log.warn('maimai 渲染器不可用，/b50 将降级为文字摘要', { reason: mai.reason });
  }
  if (phi.renderer === null) {
    log.warn('phigros 渲染器不可用，/rks 将降级为文字摘要', { reason: phi.reason });
  }

  const maimaiRenderer = mai.renderer;
  const phigrosRenderer = phi.renderer;

  return {
    async renderMaimaiB50(input: MaimaiB50RenderInput): Promise<Buffer> {
      if (maimaiRenderer === null) {
        throw new RendererUnavailableError(
          'maimai',
          `maimai 渲染器未装配：${mai.reason ?? '未知原因'}`,
        );
      }
      return maimaiRenderer.renderMaimaiB50(input);
    },

    async renderPhigrosRks(input: PhigrosRksRenderInput): Promise<Buffer> {
      if (phigrosRenderer === null) {
        throw new RendererUnavailableError(
          'phigros',
          `phigros 渲染器未装配：${phi.reason ?? '未知原因'}`,
        );
      }
      return phigrosRenderer.renderPhigrosRks(input);
    },

    async close(): Promise<void> {
      const results = await Promise.allSettled([
        maimaiRenderer?.close() ?? Promise.resolve(),
        phigrosRenderer?.close() ?? Promise.resolve(),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') {
          log.warn('关闭渲染器失败', { reason: errorMessage(result.reason) });
        }
      }
    },
  };
}
