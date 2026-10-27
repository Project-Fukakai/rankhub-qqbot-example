/**
 * Arcaea B50 海报的自包含 HTML 模板（内联 CSS，资源走 file://）。
 *
 * 版式来源：design 稿 best-posters
 *   css/base.css:6-9,50-154  → 海报骨架 / hero / 分区 / 卡片 / 页脚
 *   css/games.css:37-124      → `.game-arcaea` 的梯形难度标签、切角卡面、右侧判定大字、PTT 板
 *   js/app.js:95-126          → 卡片 DOM 结构与字段顺序（arcaea 分支）
 *   js/app.js:151-158         → hero / 分区 / 页脚结构
 *
 * 相对原稿的裁剪：
 * - 去掉工作台外壳（header / tabs / zoom / 纯海报开关 / 媒体查询），只留 `#poster` 本体；
 * - 去掉其它六款游戏的样式，只保留 `.game-arcaea`；
 * - `@font-face` 由实际存在的字体文件生成（缺字体时自动退回系统字体，不报错）。
 *
 * 本文件不执行任何模板引擎：纯字符串拼装，所有插值都过 `escapeHtml`，
 * 因此渲染产物里不会残留 `{{...}}` 之类的标记。
 */
import type { ArcTemplateCard, ArcTemplateData } from './data.js';

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** 所有文本/属性统一转义（`js/app.js:16` 的同款实现）。 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPE[char] ?? char);
}

/**
 * 资源 URL 只允许 `file://` / `data:`：模板里出现的地址全部由本地素材解析而来，
 * 这里再拦一道，避免把任意字符串拼进 HTML/CSS。
 */
function safeResourceUrl(url: string): string {
  const trimmed = url.trim();
  if (!/^(?:file|data):/i.test(trimmed)) {
    throw new Error(`Arcaea 海报只允许本地素材 URL（file:// 或 data:），收到: ${trimmed.slice(0, 80)}`);
  }
  return trimmed.replace(/["'\\\n\r]/g, '');
}

/** CSS `url("...")` 里的资源地址。 */
function cssUrl(url: string): string {
  return `url("${safeResourceUrl(url)}")`;
}

/** 卡片右侧判定/评级大字下方的箭头（`js/app.js:21`）。 */
const RATING_ARROW =
  '<svg class="rating-arrow" viewBox="0 0 28 12" fill="none" aria-hidden="true">' +
  '<path d="M0 6h26m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.2"/></svg>';

/** RankHub 品牌标（深色单色 SVG，由 `.rankhub-mark` 的 filter 反白）。 */
function rankhubMark(url: string | null): string {
  if (!url) return '';
  return `<img class="rankhub-mark" src="${escapeHtml(safeResourceUrl(url))}" width="353" height="397" alt="" aria-hidden="true">`;
}

/**
 * 海报 CSS：base.css + games.css 的 arcaea 子集，原样搬过来（含注释里的设计口径）。
 * `${fontFaceCss}` 由 data.ts 依据实际字体文件生成。
 */
function buildCss(fontFaceCss: string): string {
  return `
${fontFaceCss}

/* ── 基础（base.css:6-9） ── */
:root{color-scheme:dark;--paper:#090a0c;--surface:#181a1e;--ink:#f3f4f6;--muted:#adb0b7;--quiet:#8f939b;--rule:rgba(233,237,243,.18);--font:Saira,'PingFang SC','Microsoft YaHei',sans-serif}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#090a0c;color:var(--ink);font-family:var(--font);-webkit-font-smoothing:antialiased}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.rankhub-mark{width:auto;filter:brightness(0) invert(1)}

/* ── 海报骨架（base.css:50-53）2600px 定宽，@300ppi 打印级 ── */
.poster{position:relative;width:2600px;overflow:hidden;background:var(--paper);color:var(--ink);font-size:20px;line-height:1.25;font-variant-numeric:tabular-nums;isolation:isolate}
.poster-background{position:absolute;inset:-50px;z-index:-3;pointer-events:none;background-image:var(--hero-art,none);background-position:center top;background-size:cover;filter:grayscale(1) blur(30px) brightness(.38);opacity:.5}
.poster::before{content:'';position:absolute;inset:0;z-index:-2;background:linear-gradient(180deg,#090a0c22 0,#090a0c7a 28%,#090a0ccb 85%,#090a0cf5 100%);pointer-events:none}
.poster::after{content:'';position:absolute;inset:0;z-index:-1;background-image:linear-gradient(#ffffff05 1px,transparent 1px),linear-gradient(90deg,#ffffff05 1px,transparent 1px);background-size:80px 80px;pointer-events:none}

/* ── Hero（base.css:54-93） ── */
.poster-hero{position:relative;height:440px;padding:32px 64px 0;border-bottom:1px solid var(--rule);overflow:hidden}
.hero-artwork{position:absolute;right:0;top:0;width:920px;height:440px;object-fit:cover;object-position:center;filter:grayscale(1) brightness(.6);opacity:.48;mask-image:linear-gradient(90deg,transparent,#000 30%);z-index:-1}
.hero-grid{position:absolute;inset:0;z-index:-1;background:linear-gradient(0deg,#090a0cb8,transparent 55%);pointer-events:none}
.hero-topline{display:flex;align-items:center;gap:14px;font-size:19px;letter-spacing:.2px}
.hero-brand{display:flex;align-items:center;gap:10px;font-size:24px;font-weight:600}
.hero-brand .rankhub-mark{height:24px}
.hero-topline .slash{color:#71767e;margin:0 10px}
.hero-kicker{font-size:13px;font-weight:500;letter-spacing:4px;color:#c0c4ca}
.hero-edition{margin-left:auto;font-size:14px;letter-spacing:2px;color:#c5c8ce;display:flex;align-items:center;gap:18px}
.hero-edition::before{content:'';width:60px;height:1px;background:#c1c5cd70}
.hero-main{display:flex;align-items:center;gap:46px;height:241px;position:relative}
.game-heading{width:750px;flex:none;margin-top:3px}
.game-title{margin:0;font-size:88px;line-height:1;font-weight:600;letter-spacing:-3px}
.game-logo{display:block;height:120px;width:auto}
.game-subtitle{margin:19px 0 0;font-size:16px;letter-spacing:4px;color:#bdc1c8;font-weight:400;text-transform:uppercase}
.player-block{display:flex;align-items:center;gap:21px;min-width:330px;margin-left:6px;border-left:1px solid #ffffff23;padding-left:44px}
.avatar-monogram{width:80px;height:80px;display:flex;align-items:center;justify-content:center;position:relative;font-size:44px;font-weight:500;background:#ffffff09;border:1px solid #ffffff2c}
.avatar-monogram::after{content:'';position:absolute;bottom:5px;right:5px;width:8px;height:8px;border-bottom:1px solid #b6bbc4;border-right:1px solid #b6bbc4}
.player-name{margin:0;font-size:37px;font-weight:500;letter-spacing:.2px}
.player-code{font-size:13px;color:#a9afb8;letter-spacing:2.5px;margin-top:5px}
.hero-rating{margin-left:50px;min-width:350px}
.metric-label{font-size:14px;letter-spacing:3px;text-transform:uppercase;color:#cbd0d7;margin-bottom:0;display:flex;align-items:center;gap:12px}
.metric-label::before{content:'';width:20px;height:1px;background:#dadfe6}
.metric-value{font-size:95px;line-height:1.15;letter-spacing:-2px;font-weight:500}
.metric-caption{font-size:14px;color:#aeb4bd;letter-spacing:.3px;margin-top:3px}
.hero-best{margin-left:auto;align-self:center;text-align:right;position:relative;padding-left:26px;min-width:310px}
.best-eyebrow{font-size:18px;letter-spacing:11px;color:#d6dae0;padding-right:4px}
.best-number{font-size:152px;line-height:.9;font-weight:600;letter-spacing:-7px;color:#f0f3f8;margin-top:12px}
.best-number::before{content:'/';font-weight:400;color:#9ca2ad;font-size:100px;margin-right:10px}
.hero-bottom{height:91px;display:flex;align-items:center;border-top:1px solid var(--rule);gap:52px}
.hero-stats{display:flex;gap:50px;align-items:center;flex:1}
.hero-stat{display:flex;align-items:baseline;gap:15px;padding-right:44px;border-right:1px solid #ffffff24;min-width:220px}
.hero-stat:last-child{border:0}
.hero-stat-label{font-size:16px;color:#b9bfc8}
.hero-stat-value{font-size:30px;font-weight:500;white-space:nowrap}
.hero-stat-caption{font-size:13px;color:#9aa1ac;max-width:200px}
.hero-stamp{font-size:12px;letter-spacing:2.3px;color:#b8bec8;display:flex;align-items:center;gap:12px;text-align:right;white-space:nowrap}
.stamp-square{width:8px;height:8px;background:#dce0e6}

/* ── 分区骨架（base.css:94-104） ── */
.poster-content{padding:32px 64px 40px}
.score-section+.score-section{margin-top:32px}
.section-heading{height:64px;display:flex;align-items:center;gap:20px;margin-bottom:20px;border-bottom:1px solid #e4e9f333;padding-bottom:15px;position:relative}
.section-number{font-size:15px;letter-spacing:2px;color:#a6aeb9;width:39px}
.section-heading h2{font-size:31px;font-weight:500;margin:0;letter-spacing:.2px}
.section-subtitle{font-size:16px;letter-spacing:.5px;color:#aab2bd;padding-left:21px;border-left:1px solid #e4e9f333;margin-left:6px}
.section-count{margin-left:auto;display:flex;align-items:baseline;gap:9px;font-size:15px;color:#b4bbc5;letter-spacing:1px}
.section-count strong{font-size:26px;color:#e7ebf1;font-weight:500}
.section-count span{font-size:11px;letter-spacing:2px;margin-right:17px;color:#a0a8b4}
.score-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:20px 20px}

/* ── 卡片通用（base.css:104-133） ── */
.score-card{height:252px;position:relative;min-width:0;isolation:isolate;--diff:#c3c9d2}
.card-surface{position:absolute;inset:0;z-index:-1;background:linear-gradient(120deg,rgba(40,43,48,.82),rgba(19,21,24,.91));border:1px solid rgba(220,228,239,.22);backdrop-filter:blur(18px)}
.card-top{position:absolute;top:12px;left:16px;right:16px;display:flex;align-items:center;gap:13px;height:26px;white-space:nowrap}
.card-rank{font-size:21px;font-weight:500;color:#e3e7ed;min-width:41px;letter-spacing:.8px}
.card-rank small{font-size:11px;color:#949daa;margin-right:2px;letter-spacing:0}
.card-cover{position:absolute;left:16px;top:52px;width:154px;height:154px;background:#0a0c0f;overflow:hidden}
.card-cover img{width:100%;height:100%;object-fit:cover;display:block}
.card-cover::after{content:'';position:absolute;inset:0;border:1px solid #ffffff20;pointer-events:none}
.is-placeholder img{opacity:.72;filter:grayscale(1)}
.card-content{position:absolute;top:50px;left:186px;right:16px;min-width:0}
.song-title{margin:0;height:46px;font-size:20px;font-weight:500;line-height:1.15;letter-spacing:-.15px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;color:#f4f5f7}
.card-score{display:flex;align-items:baseline;gap:4px;white-space:nowrap;margin-top:5px;height:48px;font-size:42px;line-height:1.05;font-weight:600;letter-spacing:-1.3px}
.card-secondary{min-height:22px;font-size:14px;color:#b9c2cf;white-space:nowrap;letter-spacing:.3px;line-height:22px}
.rating-band{margin-top:8px;display:flex;align-items:center;gap:10px;height:32px;border-top:1px solid #ffffff1f;padding-top:7px;font-size:22px;white-space:nowrap}
.rating-constant{color:#b9c1cd;font-size:19px}
.rating-arrow{width:25px;height:12px;color:#8e99a8;flex:none;margin:0 1px}
.rating-value{color:#f0f3f7;font-weight:500}
.rating-label{font-size:10px;text-transform:uppercase;color:#a7b1bf;letter-spacing:.7px;margin-left:auto}
.card-footer{position:absolute;bottom:12px;left:16px;right:16px;height:24px;display:flex;align-items:center;justify-content:space-between;gap:9px;white-space:nowrap}
.card-extras{display:flex;gap:12px;align-items:center;font-size:12px;color:#bdc6d3;min-width:0;overflow:hidden}
.difficulty{font-size:14px;letter-spacing:.6px}
.chart-level{font-size:14px}
.extra-label,.rating-label{font-size:12px;letter-spacing:.35px}
.extra-value{font-size:13px}
@supports not (backdrop-filter:blur(1px)){.card-surface{background:rgba(25,28,33,.97)}}

/* ── 页脚（base.css:149-154） ── */
.poster-footer{position:relative;margin:0 64px;border-top:1px solid #d5ddeb33;padding:28px 0 30px;display:flex;align-items:center;gap:32px;min-height:108px}
.footer-logo{font-size:22px;font-weight:500;letter-spacing:-.3px;display:flex;gap:10px;align-items:center;white-space:nowrap}
.footer-logo .rankhub-mark{height:20px}
.footer-note{font-size:13px;line-height:1.7;color:#a5aebb;letter-spacing:.3px;max-width:1510px}
.footer-note strong{color:#c8d0db;font-weight:500}
.footer-edition{margin-left:auto;white-space:nowrap;text-align:right;font-size:12px;color:#b1bac7;line-height:1.9;letter-spacing:2px}

/* ── Arcaea 专属（games.css:37-124） ── */
/* 5 列必须保 10 行：卡片只能从左右留白里抠宽度（留白 64→20，列间距 20→40）。 */
.game-arcaea .poster-content{padding-left:20px;padding-right:20px}
.game-arcaea .poster-hero{padding-left:20px;padding-right:20px}
.game-arcaea .poster-footer{margin-left:20px;margin-right:20px}
.game-arcaea .score-grid{column-gap:40px;row-gap:64px}
.game-arcaea .section-heading{margin-bottom:64px}
.game-arcaea .game-title{font-weight:400;letter-spacing:1px;font-size:98px}
.game-arcaea .hero-artwork{clip-path:polygon(150px 0,100% 0,100% 100%,0 100%);width:980px}
.game-arcaea .avatar-monogram{clip-path:polygon(0 0,100% 0,100% calc(100% - 15px),calc(100% - 15px) 100%,0 100%)}
/* 难度/等级标签是卡面轮廓本身长出来的一段：.card-surface 向上探出 28px，
   一条 polygon 同时画出卡片本体和梯形标签，缺口 52/69/179/196，梯形宽 144px。 */
.game-arcaea .card-surface{top:-28px;bottom:6px;border:0;background:#cbd7e247;clip-path:polygon(0 28px,52px 28px,69px 0,179px 0,196px 28px,calc(100% - 24px) 28px,100% 52px,100% 100%,218px 100%,198px calc(100% - 20px),0 calc(100% - 20px))}
.game-arcaea .card-surface::after{content:'';position:absolute;inset:1px;clip-path:polygon(0 28px,52px 28px,69px 0,179px 0,196px 28px,calc(100% - 24px) 28px,100% 52px,100% 100%,218px 100%,198px calc(100% - 20px),0 calc(100% - 20px));background:linear-gradient(120deg,color-mix(in srgb,var(--diff) 20%,transparent),color-mix(in srgb,var(--diff) 5%,transparent) 44%,color-mix(in srgb,var(--diff) 0%,transparent) 72%),linear-gradient(120deg,#2a2c32ed,#181b21f0)}
.game-arcaea .card-cover{clip-path:polygon(0 0,100% 0,100% calc(100% - 17px),calc(100% - 17px) 100%,0 100%);height:150px;width:150px;left:14px;top:24px}
/* 序号不再单独占一行：绝对定位到右上角，卡片高度收掉 26px 顶栏。 */
.game-arcaea .score-card{height:214px}
.game-arcaea .card-rank{position:absolute;top:14px;right:24px;z-index:2}
/* 正文与右侧大字同处一条 flex 行：大字宽度由自身文字决定（P / F / EX+ 各不同）。 */
.game-arcaea .card-body{position:absolute;top:24px;left:180px;right:20px;display:flex;align-items:flex-start;gap:12px}
.game-arcaea .card-content{position:static;flex:1 1 auto;min-width:0;padding-top:50px}
.game-arcaea .song-title{display:block;position:absolute;left:0;right:0;top:18px;height:34px;padding-top:3px;font-size:24px;letter-spacing:-.4px;white-space:nowrap;text-overflow:ellipsis;overflow-wrap:normal;-webkit-line-clamp:unset}
.game-arcaea .card-score{font-size:36px;margin-top:9px}
.game-arcaea .card-secondary{margin-top:4px}
/* 标签只负责放文字：形状与底色都来自卡面轮廓。 */
.game-arcaea .card-tab{position:absolute;left:52px;top:-28px;z-index:3;width:144px;height:28px;display:flex;align-items:center;justify-content:center;gap:9px;font-size:15px;letter-spacing:1.3px;text-transform:uppercase;color:#e6ecf4;white-space:nowrap}
.game-arcaea .card-tab .tab-dot{width:6px;height:6px;background:var(--diff);flex:none}
.game-arcaea .card-tab .tab-level{font-size:16px;font-weight:600;color:#fff}
/* 单曲 PTT 板：204×30，叠 16% 难度色，不再用亮白板抢视线。 */
.game-arcaea .rating-band{position:absolute;right:-8px;bottom:-6px;z-index:2;width:204px;height:30px;padding:3px 12px 3px 16px;background:color-mix(in srgb,var(--diff) 16%,#1c2027f2);color:#c6ced9;border:0;font-size:16px;gap:7px;clip-path:polygon(11px 0,100% 0,100% calc(100% - 11px),calc(100% - 11px) 100%,0 100%,0 11px)}
.game-arcaea .rating-constant{color:#8e98a6;font-size:13px}
.game-arcaea .rating-value{color:#dbe2ec;font-weight:500}
.game-arcaea .rating-arrow{color:#7b8695;width:17px}
.game-arcaea .rating-label{color:#8792a1;font-size:10px}
.game-arcaea .card-footer{left:17px;bottom:16px;right:269px;justify-content:flex-start;overflow:hidden}
.game-arcaea .card-footer .card-extras{font-size:11px}
.game-arcaea .card-footer .extra-value{font-size:13px}
.game-arcaea .card-footer .extra-label{font-size:12px}
/* 判定 / 评级大字：不套容器，直接做在右侧。 */
.game-arcaea .card-grade{flex:0 0 auto;margin-top:56px;font-size:46px;line-height:.9;font-weight:600;letter-spacing:-4px;color:#e2e8f1;white-space:nowrap;pointer-events:none}
.game-arcaea .card-grade[data-tone=gold]{color:#e7d8ae}
.game-arcaea .card-grade[data-tone=blue]{color:#bfd1ec}
/* P / F 背后加一道横向散光（亮芯 + 光晕两层，都用字母自身颜色）。 */
.game-arcaea .card-grade:is([data-tone=gold],[data-tone=blue]){position:relative}
.game-arcaea .card-grade:is([data-tone=gold],[data-tone=blue])::before{content:'';position:absolute;left:-16px;right:-20px;top:50%;height:30px;transform:translateY(-50%);background:radial-gradient(50% 50% at 50% 50%,currentColor,transparent 70%);opacity:.32;filter:blur(6px);pointer-events:none}
.game-arcaea .card-grade:is([data-tone=gold],[data-tone=blue])::after{content:'';position:absolute;left:-16px;right:-20px;top:50%;height:6px;transform:translateY(-50%);background:linear-gradient(90deg,transparent,currentColor 14%,currentColor 86%,transparent);opacity:.5;filter:blur(4.5px);pointer-events:none}
/* 游玩时长挂在评级大字下方，两行共用卡片右边界。 */
.game-arcaea .grade-column{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:7px}
.game-arcaea .card-time{display:flex;align-items:baseline;gap:6px;white-space:nowrap}
.game-arcaea .card-time .time-label{font-size:11px;letter-spacing:1.4px;color:#8b95a3}
.game-arcaea .card-time .time-value{font-size:15px;color:#dde4ee}
`.trim();
}

/** 一张成绩卡片（对应 `js/app.js:117-125` 的 arcaea 分支）。 */
function cardHtml(card: ArcTemplateCard): string {
  const coverClass = card.coverMissing ? 'card-cover is-placeholder' : 'card-cover';
  const tab =
    card.difficulty && card.levelText
      ? `<div class="card-tab" aria-label="难度 ${escapeHtml(card.difficulty)}，等级 ${escapeHtml(card.levelText)}">` +
        `<i class="tab-dot" aria-hidden="true"></i><span class="tab-diff">${escapeHtml(card.difficulty)}</span>` +
        `<span class="tab-level">${escapeHtml(card.levelText)}</span></div>`
      : '';
  const time = card.playTime
    ? `<div class="card-time"><span class="time-label">TIME</span><span class="time-value">${escapeHtml(card.playTime)}</span></div>`
    : '';

  return (
    `<article class="score-card" style="--diff:${escapeHtml(card.diffColor)}" data-chart-id="${escapeHtml(card.chartId)}" ` +
    `aria-label="${escapeHtml(card.ariaLabel)}">` +
    `<div class="card-surface" aria-hidden="true"></div>` +
    `<span class="card-rank"><small>${escapeHtml(card.rankPrefix)}</small>${escapeHtml(card.rankNumber)}</span>` +
    tab +
    `<div class="${coverClass}">` +
    `<img src="${escapeHtml(safeResourceUrl(card.coverUrl))}" alt="${escapeHtml(card.title)} 曲绘" width="154" height="154">` +
    `</div>` +
    `<div class="card-body">` +
    `<div class="card-content">` +
    `<h3 class="song-title" title="${escapeHtml(card.title)}">${escapeHtml(card.title)}</h3>` +
    `<div class="card-score" aria-label="${escapeHtml(card.primaryLabel)} ${escapeHtml(card.primaryValue)}">${escapeHtml(card.primaryValue)}</div>` +
    `<div class="card-secondary">${escapeHtml(card.secondaryValue)}</div>` +
    `</div>` +
    `<div class="grade-column">` +
    `<div class="card-grade" data-tone="${escapeHtml(card.gradeTone)}" aria-hidden="true">${escapeHtml(card.gradeMark)}</div>` +
    time +
    `</div>` +
    `<span class="sr-only">${escapeHtml(card.gradeSrText)}</span>` +
    `</div>` +
    `<div class="card-footer"><div class="card-extras"></div></div>` +
    `<div class="rating-band" aria-label="定数 ${escapeHtml(card.ratingConstant)}，单曲 PTT ${escapeHtml(card.ratingValue)}">` +
    `<span class="rating-constant">${escapeHtml(card.ratingConstant)}</span>${RATING_ARROW}` +
    `<strong class="rating-value">${escapeHtml(card.ratingValue)}</strong>` +
    `<span class="rating-label">${escapeHtml(card.ratingLabel)}</span>` +
    `</div>` +
    `</article>`
  );
}

function statsHtml(data: ArcTemplateData): string {
  return data.stats
    .map(
      (stat) =>
        `<div class="hero-stat"><span class="hero-stat-label">${escapeHtml(stat.label)}</span>` +
        `<strong class="hero-stat-value">${escapeHtml(stat.value)}</strong>` +
        (stat.caption ? `<span class="hero-stat-caption">${escapeHtml(stat.caption)}</span>` : '') +
        `</div>`,
    )
    .join('');
}

/**
 * 渲染完整 HTML（`#poster` 即截图目标，宽 2600px）。
 *
 * @param data `buildArcTemplateData` 的输出
 */
export function buildArcPosterHtml(data: ArcTemplateData): string {
  const mark = rankhubMark(data.rankhubMarkUrl);
  const heroArt = data.heroArtUrl
    ? `<img class="hero-artwork" src="${escapeHtml(safeResourceUrl(data.heroArtUrl))}" alt="" aria-hidden="true">`
    : '';
  const titleCell = data.gameLogoUrl
    ? `<img class="game-logo" src="${escapeHtml(safeResourceUrl(data.gameLogoUrl))}" alt="Arcaea">`
    : 'Arcaea';
  const heroArtStyle = data.heroArtUrl ? ` style="--hero-art:${cssUrl(data.heroArtUrl)}"` : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<title>Arcaea Best ${escapeHtml(data.bestCount)} — RankHub</title>
<style>
${buildCss(data.fontFaceCss)}
</style>
</head>
<body>
<article id="poster" class="poster game-arcaea" aria-label="Arcaea Best ${escapeHtml(data.bestCount)} 成绩海报"${heroArtStyle}>
<div class="poster-background" aria-hidden="true"></div>
<header class="poster-hero">
${heroArt}
<div class="hero-grid" aria-hidden="true"></div>
<div class="hero-topline"><span class="hero-brand">${mark}RankHub</span><span class="slash">/</span><span class="hero-kicker">BEST PERFORMANCE ARCHIVE</span><span class="hero-edition">${escapeHtml(data.heroEdition)}<span>${escapeHtml(data.editionYear)}</span></span></div>
<div class="hero-main">
<div class="game-heading"><h1 class="game-title">${titleCell}</h1><p class="game-subtitle">${escapeHtml(data.subtitle)}</p></div>
<div class="player-block"><div class="avatar-monogram" aria-hidden="true">${escapeHtml(data.profileInitial)}</div><div><p class="player-name">${escapeHtml(data.profileName)}</p><div class="player-code">${escapeHtml(data.playerCode)}</div></div></div>
<div class="hero-rating"><div class="metric-label">${escapeHtml(data.metricLabel)}</div><div class="metric-value">${escapeHtml(data.potentialText)}</div><div class="metric-caption">${escapeHtml(data.metricCaption)}</div></div>
<div class="hero-best"><div class="best-eyebrow">BEST</div><div class="best-number">${escapeHtml(data.bestCount)}</div></div>
</div>
<div class="hero-bottom"><div class="hero-stats">${statsHtml(data)}</div><div class="hero-stamp"><span class="stamp-square" aria-hidden="true"></span>RANKHUB DATA<span>·</span>${escapeHtml(data.computedAtText)}</div></div>
</header>
<div class="poster-content">
<section class="score-section" data-section="best">
<header class="section-heading"><span class="section-number">01</span><h2>${escapeHtml(data.sectionTitle)}</h2><span class="section-subtitle">${escapeHtml(data.sectionSubtitle)}</span><div class="section-count"><span>${escapeHtml(data.sectionCountLabel)}</span><strong>${escapeHtml(String(data.sectionCount).padStart(2, '0'))}</strong> / ${escapeHtml(String(data.sectionCount).padStart(2, '0'))}</div></header>
<div class="score-grid">
${data.cards.map(cardHtml).join('\n')}
</div>
</section>
</div>
<footer class="poster-footer"><div class="footer-logo">${mark}RankHub</div><div class="footer-note"><strong>RankHub 数据 · 真实曲目与曲绘</strong><br>${escapeHtml(data.formulaNote)}</div><div class="footer-edition">BEST ARCHIVE / 03<br>DESIGNED FOR THE RHYTHM.</div></footer>
</article>
</body>
</html>
`;
}
