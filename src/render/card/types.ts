/**
 * `/me` 名片渲染的公开数据模型。
 *
 * 输入类型直接**别名**到冻结契约 `src/contracts/index.ts` 的 `PlayerCardRenderInput`：
 * 契约是并行开发（api-profile / commands-integration / render-*）的边界，渲染器只读它、
 * 不复制一份结构——否则渲染器和契约会各自漂移，集成时才发现字段对不上。
 * （渲染器本身仍然不依赖网络：所有图片素材都是调用方传进来的 `Buffer`。）
 *
 * 本地只定义渲染器自己的构造参数与返回结果。
 */
import type {
  PlayerCardGameIcon as ContractGameIcon,
  PlayerCardGameSection as ContractGameSection,
  PlayerCardRenderInput as ContractRenderInput,
} from '../../contracts/index.js';

/** 顶部「已绑定游戏」图标条的一项（= 契约 `PlayerCardGameIcon`）。 */
export type PlayerCardGameIcon = ContractGameIcon;

/** 游戏卡片里的一个信息格（label 小字 + value 大字）。 */
export type PlayerCardGameField = ContractGameSection['fields'][number];

/** 单个游戏的玩家卡片（= 契约 `PlayerCardGameSection`）。 */
export type PlayerCardGameCard = ContractGameSection;

/** 渲染一张名片所需的全部输入（= 契约 `PlayerCardRenderInput`）。 */
export type PlayerCardInput = ContractRenderInput;

/** 渲染器构造参数。 */
export interface PlayerCardRendererOptions {
  /** Chromium 可执行文件（默认 RENDER_BROWSER_PATH / playwright 缓存 / PATH）。 */
  browserPath?: string;
  /** 页面加载与截图超时（ms），默认 30s。 */
  timeoutMs?: number;
  /** PNG 超过该字节数时降级为 JPEG quality 90（QQ 图片上限约 5MB）。 */
  maxImageBytes?: number;
  /** 可选展示字体目录（默认 `vendor/card/fonts`，缺失时回退 `vendor/phi` 的 Aldrich）。 */
  fontsDir?: string;
  /** 可选 App 默认背景目录（默认 `vendor/card/backgrounds`，缺失时卡片用纯色兜底）。 */
  backgroundsDir?: string;
}

/** 渲染结果（`renderPlayerCard` 只返回 buffer，详细版供测试/排查）。 */
export interface PlayerCardRenderResult {
  buffer: Buffer;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  /** 实际渲染的 HTML（测试断言无残留占位符、素材来源用）。 */
  html: string;
  /** 输入归一后的摘要（测试断言素材是否真的用上）。 */
  summary: {
    hasBanner: boolean;
    hasAvatar: boolean;
    hasQr: boolean;
    games: number;
    cards: number;
    fields: number;
    /** 没有背景图、走游戏主题渐变的卡片数。 */
    fallbackBackgrounds: number;
  };
  diagnostics: {
    browserPath: string;
    browserSource: 'env' | 'playwright-cache' | 'path';
    /** 展示字体家族名；没有可用字体时为 null（回退系统字体）。 */
    displayFont: string | null;
    /** 展示字体是否真的加载成功（没有字体时恒为 true）。 */
    fontsReady: boolean;
    /** 用上 App 默认背景素材的游戏（依赖 vendor/card/backgrounds 是否存在）。 */
    defaultBackgroundGames: string[];
    /** 横向滚动宽度；> 1200 说明有元素把版式撑出去了（测试断言用）。 */
    scrollWidth: number;
    /** 视口 clientWidth（应为 1200）。 */
    clientWidth: number;
  };
}

/** 名片渲染器接口。 */
export interface PlayerCardRenderer {
  /** 渲染并返回 PNG/JPEG 字节。 */
  renderPlayerCard(input: PlayerCardInput): Promise<Buffer>;
  /** 渲染并返回 HTML / 尺寸 / 诊断信息。 */
  renderPlayerCardDetail(input: PlayerCardInput): Promise<PlayerCardRenderResult>;
  /** 关闭 Chromium（可重复调用）。 */
  close(): Promise<void>;
}
