/**
 * `/me` 名片渲染的公开数据模型。
 *
 * 输入类型直接**别名**到冻结契约 `src/contracts/index.ts` 的 `PlayerCardRenderInput`
 * 判别联合（maimai / phigros / arcaea 三种卡片数据）：契约是并行开发
 * （qqbot-data / qqbot-render / commands）的边界，渲染器只读它、不复制一份结构——
 * 否则渲染器和契约会各自漂移，集成时才发现字段对不上。
 * （渲染器本身仍然不依赖网络：所有图片素材都是调用方传进来的 `Buffer`。）
 *
 * 本地只定义渲染器自己的构造参数、结果与诊断信息。
 */
import type {
  PhigrosDifficulty as ContractPhigrosDifficulty,
  PlayerCardArcaeaCardData as ContractArcaeaCardData,
  PlayerCardGameCard as ContractGameCard,
  PlayerCardGameIcon as ContractGameIcon,
  PlayerCardMaimaiCardData as ContractMaimaiCardData,
  PlayerCardPhigrosCardData as ContractPhigrosCardData,
  PlayerCardRenderInput as ContractRenderInput,
} from '../../contracts/index.js';

/** Phigros 难度（与 App / 后端偏好枚举逐字一致）。 */
export type PhigrosDifficulty = ContractPhigrosDifficulty;

/** 顶部「已绑定游戏」图标条的一项（= 契约 `PlayerCardGameIcon`）。 */
export type PlayerCardGameIcon = ContractGameIcon;

/** 单个游戏的玩家卡片（= 契约 `PlayerCardGameCard` 判别联合）。 */
export type PlayerCardGameCard = ContractGameCard;

export type PlayerCardMaimaiCardData = ContractMaimaiCardData;
export type PlayerCardPhigrosCardData = ContractPhigrosCardData;
export type PlayerCardArcaeaCardData = ContractArcaeaCardData;

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
  /**
   * 名片静态素材目录（默认 `vendor/card`，由 `scripts/fetch-assets-card.mjs` 准备）。
   * 目录缺失/不全时降级渲染，不报错。
   */
  assetsDir?: string;
  /**
   * 是否把 phi 字体（phi-plugin 的 Saira×思源黑体混合字体，约 8.4MB）内联进页面。
   * 默认 false：App 卡片的三套版式都用 Saira + 系统中文字体即可，内联大字体只会拖慢渲染；
   * 设为 true 时可用于「服务器没有任何 CJK 字体」的极端环境兜底。
   */
  includePhiFont?: boolean;
}

/** 单张卡片在页面里的实际盒子（测试断言 5:2 / 1120×448）。 */
export interface PlayerCardRect {
  game: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 渲染摘要（测试断言素材是否真的用上）。 */
export interface PlayerCardSummary {
  hasBanner: boolean;
  hasAvatar: boolean;
  hasQr: boolean;
  games: number;
  cards: number;
  /** 卡片按输入顺序的游戏名（断言三张卡都在）。 */
  cardsByGame: string[];
  /** 真正被 HTML 引用的固定素材数量。 */
  usedStaticAssets: number;
  /** 尝试引用但缺失的固定素材数量。 */
  missingStaticAssets: number;
}

/** 渲染结果（`renderPlayerCard` 只返回 buffer，详细版供测试/排查）。 */
export interface PlayerCardRenderResult {
  buffer: Buffer;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  /** 实际渲染的 HTML（测试断言结构、素材来源、无残留占位符）。 */
  html: string;
  summary: PlayerCardSummary;
  /** 实际用到的固定素材 key（如 `arcaea:banner`）。 */
  usedStaticAssets: string[];
  /** 缺失的固定素材 key。 */
  missingStaticAssets: string[];
  diagnostics: {
    browserPath: string;
    browserSource: 'env' | 'playwright-cache' | 'path';
    /** 成功加载的字体 family（Saira / Orbitron / phi / RankHub Display）。 */
    fontFamilies: string[];
    /** 字体是否真的加载成功（没有可用字体时恒为 true，表示无字体可等）。 */
    fontsReady: boolean;
    /** 卡片盒子的实测几何（页面坐标）。 */
    cardRects: PlayerCardRect[];
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
  /** 只渲染一张游戏卡（1120×448），用于证据截图 / 单卡调试。 */
  renderGameCard(card: PlayerCardGameCard): Promise<Buffer>;
  /** 只渲染一张游戏卡并返回详细信息。 */
  renderGameCardDetail(card: PlayerCardGameCard): Promise<PlayerCardRenderResult>;
  /** 关闭 Chromium（可重复调用）。 */
  close(): Promise<void>;
}
