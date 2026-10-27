#!/usr/bin/env python3
"""
用 maimaiDX 原始绘制代码生成 b50 参考图（移植 spike 的对照基线）。

原则：
  * 绘制代码零改动 —— `core/image/{best50,base,assets,tools}.py`、`core/utils/calc.py`、
    `constants.py`、`core/merge/models/*`、`core/clients/lxns/models/{enum,collection}.py`
    都是从 `vendor/mai-src`（commit 1154ad676238ab45a76a70c23648f7a6d881e53c）原样复制；
  * 只为「插件运行环境」补最小 shim：config（maiconfig）、resources（静态资源路径）、
    service（曲目数据 `mai`）、database（`User`）、clients/http（在线资源，禁用）、
    divingfish（Stats）——全部标注 `[shim]`；
  * 输入输出纯 JSON/PNG，不依赖 hoshino、sqlmodel、httpx、Playwright。

运行（必须在 .venv-ref 里）：
  .venv-ref/bin/python scripts/render-reference.py \
      --input evidence/qqbot/render/maimai-input.json \
      --output evidence/qqbot/render/maimai-reference.png

输入 JSON 结构见 `--help` 与 `build_player()`。
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import shutil
import sys
import tempfile
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAI_SRC = ROOT / "vendor" / "mai-src"
STATIC = ROOT / "vendor" / "mai"

MAIMAIDX_COMMIT = "1154ad676238ab45a76a70c23648f7a6d881e53c"

# 原样复制（不得改动）的源码
VERBATIM = [
    "constants.py",
    "core/image/base.py",
    "core/image/best50.py",
    "core/image/assets.py",
    "core/image/tools.py",
    "core/utils/calc.py",
    "core/merge/models/enum.py",
    "core/merge/models/player.py",
    "core/merge/models/score.py",
    "core/merge/models/best50.py",
    "core/merge/models/song.py",
    "core/clients/lxns/models/enum.py",
    "core/clients/lxns/models/collection.py",
]

# shim：仅补齐 import 依赖与静态资源路径，不含任何绘制逻辑
SHIMS = {
    "__init__.py": "# [shim] maimaiDX 运行环境最小替身\n",
    "config.py": '''
"""[shim] 替代 maimaiDX 的 config.py（原始版本依赖 hoshino / pydantic-settings）。"""


class _MaiConfig:
    maimaidx_path = ""
    save_in_memory = True
    assets_online = False  # 强制走本地 static，绝不联网取图
    bot_name = "RankHub"
    maimaidx_alias_proxy = False
    maimaidx_alias_push = False


maiconfig = _MaiConfig()
''',
    "resources.py": '''
"""[shim] 替代 maimaiDX 的 resources.py：路径改指裁剪后的 vendor/mai。"""
from pathlib import Path

static = Path(__file__).resolve().parent.parent / "vendor" / "mai"
font_dir = static / "font"
data_dir = static / "data"
mai_dir = static
pic_dir = static / "pic"
cover_dir = static / "cover"
plate_dir = static / "plate"
shougou_dir = static / "shougou"
plate_version_dir = static / "plate_version"
plate_table_dir = static / "plate_table"
rating_table_dir = static / "rating_table"

SIYUAN = font_dir / "ResourceHanRoundedCN-Bold.ttf"
SHANGGUMONO = font_dir / "ShangguMonoSC-Regular.otf"
TBFONT = font_dir / "Torus SemiBold.otf"
FOTNEWRODIN = font_dir / "FOT-NewRodin Pro EB.otf"
''',
    "core/__init__.py": "",
    "core/image/__init__.py": "",
    "core/utils/__init__.py": "",
    "core/merge/__init__.py": "",
    "core/merge/models/__init__.py": '''
"""[shim] 只导出 b50 绘制用到的模型。"""
from .best50 import Best50
from .enum import Category, ServiceName, Theme
from .player import LxnsPlayer, Player
from .score import BaseResult, NotPlayedResult, PlayedResult, Result, RiseResult
from .song import Difficulties, SimpleSong, Song

__all__ = [
    "Best50",
    "Category",
    "ServiceName",
    "Theme",
    "LxnsPlayer",
    "Player",
    "BaseResult",
    "NotPlayedResult",
    "PlayedResult",
    "Result",
    "RiseResult",
    "Difficulties",
    "SimpleSong",
    "Song",
]
''',
    "core/clients/__init__.py": "",
    "core/clients/http.py": '''
"""[shim] 替代 maimaiDX 的在线资源客户端。assets_online=False 时不会被调用。"""


async def online_assets(path: str):  # pragma: no cover - 禁用联网
    raise RuntimeError("[shim] assets_online=False，禁止在线取图")


async def qqlogo(qqid: int):  # pragma: no cover - 禁用联网
    raise RuntimeError("[shim] qqlogo 不可用")
''',
    "core/clients/lxns/__init__.py": "",
    "core/clients/lxns/models/__init__.py": '''
"""[shim] 只导出绘制用到的 lxns 模型与枚举。"""
from pydantic import BaseModel

from .collection import Collection, CollectionRequired, CollectionRequiredSong
from .enum import FCType, FSType, LevelIndex, RateType, SongType, TrophyColor


class Notes(BaseModel):
    total: int = 0


__all__ = [
    "Collection",
    "CollectionRequired",
    "CollectionRequiredSong",
    "FCType",
    "FSType",
    "LevelIndex",
    "Notes",
    "RateType",
    "SongType",
    "TrophyColor",
]
''',
    "core/clients/divingfish/__init__.py": "",
    "core/clients/divingfish/models/__init__.py": '''
"""[shim] 绘制用不到水鱼数据，只补 Stats 类型占位。"""
from pydantic import BaseModel


class Stats(BaseModel):
    pass
''',
    "core/database/__init__.py": "",
    "core/database/qq.py": '''
"""[shim] 替代 maimaiDX 的 sqlmodel User，只保留绘制读取的字段。"""
from dataclasses import dataclass

from ..merge.models import ServiceName, Theme


@dataclass
class User:
    qqid: int | None = None
    service: ServiceName = ServiceName.DIVINGFISH
    theme: Theme = Theme.PRISM_PLUS
''',
    "core/service/__init__.py": '''
"""[shim] 替代 maimaiDX 的 mai 单例：曲目表与定数表从 vendor/mai/data.json 构建。"""
import json
from pathlib import Path

from ..clients.lxns.models import LevelIndex
from ..merge.models import Difficulties, Song

_DATA = json.loads(
    (Path(__file__).resolve().parent.parent.parent / "vendor" / "mai" / "data.json").read_text()
)


class _Song:
    def __init__(self, song_id: int, difficulties: dict[int, int]):
        self.song_id = song_id
        # difficulties[level_index].dx_score（= notes.total * 3）
        self.difficulties = {
            idx: type("_Diff", (), {"dx_score": dx}) for idx, dx in difficulties.items()
        }


class _MusicList:
    def __init__(self, songs: dict[int, _Song]):
        self._songs = songs

    def by_id(self, song_id: int):
        return self._songs.get(int(song_id))


class _Diff:
    """difficulties[level_index] 的最小替身，只暴露 dx_score（谱面满 DX 分）。"""

    __slots__ = ("dx_score",)

    def __init__(self, dx_score: int) -> None:
        self.dx_score = dx_score


class _Mai:
    def __init__(self) -> None:
        songs: dict[int, _Song] = {}
        level_values: dict[str, float] = {}
        for entry in _DATA["songs"]:
            base_id = int(entry["id"])
            for diff in entry["difficulties"]:
                song_id = base_id if diff["type"] == "standard" else base_id + 10000
                idx = int(diff["difficulty"])
                notes_total = diff.get("notes_total") or 0
                song = songs.setdefault(song_id, _Song(song_id, {}))
                song.difficulties[idx] = _Diff(notes_total * 3)
                lv = diff.get("level_value")
                if lv is not None:
                    level_values[f"{song_id}-{idx}"] = float(lv)
        self.total_list = _MusicList(songs)
        self.total_level_value_map = level_values


mai = _Mai()
''',
}


def build_runtime(build_dir: Path) -> Path:
    """把 vendor/mai-src 的原样源码 + shim 拼成可 import 的包。"""
    pkg = build_dir / "maidx"
    if pkg.exists():
        shutil.rmtree(pkg)
    pkg.mkdir(parents=True)

    for rel in VERBATIM:
        src = MAI_SRC / rel
        if not src.exists():
            raise SystemExit(f"缺少原始源码：{src}（先跑 scripts/fetch-assets-mai.mjs 或重新 vendor）")
        dst = pkg / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

    for rel, content in SHIMS.items():
        dst = pkg / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(textwrap.dedent(content).lstrip("\n"))

    # resources.py 用 __file__ 定位仓库根，这里改写为绝对路径更稳
    res = pkg / "resources.py"
    res.write_text(
        res.read_text().replace(
            'Path(__file__).resolve().parent.parent / "vendor" / "mai"',
            f'Path({str(STATIC)!r})',
        )
    )
    svc = pkg / "core/service/__init__.py"
    svc.write_text(
        svc.read_text().replace(
            '(Path(__file__).resolve().parent.parent.parent / "vendor" / "mai" / "data.json")',
            f'Path({str(STATIC / "data.json")!r})',
        )
    )
    return pkg


def normalize(data: dict, sample_id: str | None) -> dict:
    """支持两种输入：单样例 {player,best50} 或 fixture 多样例 {samples:[{id,player,sd,dx}]}。"""
    if "samples" not in data:
        return data
    samples = data["samples"]
    sample = next((s for s in samples if s["id"] == sample_id), None) if sample_id else samples[0]
    if sample is None:
        raise SystemExit(f"fixture 里没有样例 {sample_id!r}；可选：{[s['id'] for s in samples]}")
    sd_total = sum(int(item["rating"]) for item in sample["sd"])
    dx_total = sum(int(item["rating"]) for item in sample["dx"])
    return {
        "player": sample["player"],
        "best50": {
            "sd_total": sd_total,
            "dx_total": dx_total,
            "sd": sample["sd"],
            "dx": sample["dx"],
        },
        "theme": sample.get("theme", data.get("theme", "prism_plus")),
        "service": sample.get("service", data.get("service", "Diving-Fish")),
    }


def build_player(data: dict):
    """把输入 JSON 的 player/best50 段转成 maimaiDX 模型（调用前 sys.path 已就绪）。"""
    from maidx.core.merge.models import Best50, Player, ServiceName, Theme, PlayedResult

    raw_player = data["player"]
    player = Player(
        name=raw_player["name"],
        rating=int(raw_player["rating"]),
        course_rank=int(raw_player.get("course_rank") or 0),
        class_rank=int(raw_player.get("class_rank") or 0),
        trophy=raw_player.get("trophy"),
        icon=raw_player.get("icon"),
        name_plate=raw_player.get("name_plate"),
    )

    raw_best = data["best50"]

    def to_results(items: list[dict]) -> list[PlayedResult]:
        out = []
        for item in items:
            out.append(
                PlayedResult(
                    song_id=int(item["song_id"]),
                    song_name=item["song_name"],
                    level=str(item.get("level") or ""),
                    level_index=int(item["level_index"]),
                    level_value=float(item.get("level_value") or 0),
                    type=item.get("type") or "SD",
                    rating=int(item["rating"]),
                    achievements=float(item["achievements"]),
                    rate=item.get("rate") or None,
                    fc=item.get("fc") or None,
                    fs=item.get("fs") or None,
                    dx_score=int(item.get("dx_score") or 0),
                )
            )
        return out

    best50 = Best50(
        sd_total=int(raw_best["sd_total"]),
        dx_total=int(raw_best["dx_total"]),
        sd=to_results(raw_best.get("sd", [])),
        dx=to_results(raw_best.get("dx", [])),
    )
    return player, best50, ServiceName, Theme


async def render(data: dict, output: Path, build_dir: Path) -> None:
    build_runtime(build_dir)
    sys.path.insert(0, str(build_dir))

    from maidx.core.database.qq import User
    from maidx.core.image.assets import AssetsImage
    from maidx.core.image.best50 import PlayerBest50
    from maidx.resources import pic_dir

    # [shim] 上游 AssetsImage._load_image() 会加载全部 30+ 张底图（rise/border/table/背景），
    # b50 只用得到其中两张。这里只预载这两张，绘制逻辑与 assets.py 均不改动。
    AssetsImage._dx_star_bg = [
        AssetsImage._open_image(pic_dir / f"UI_GAM_Gauge_DXScoreIcon_0{num}.png") for num in range(1, 6)
    ]
    AssetsImage._diff_bg = [
        AssetsImage._open_image(pic_dir / f"b50_score_{name}.png")
        for name in ("basic", "advanced", "expert", "master", "remaster")
    ]

    player, best50, ServiceName, ThemeCls = build_player(data)

    theme = ThemeCls(data.get("theme", "prism_plus"))
    service = ServiceName(data.get("service", "Diving-Fish"))
    user = User(qqid=data["player"].get("qqid"), service=service, theme=theme)

    image_cls = PlayerBest50(user, player=player, best50=best50)
    b64 = await image_cls.draw()
    payload = b64[len("base64://") :] if b64.startswith("base64://") else b64
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(base64.b64decode(payload))
    print(f"[render-reference] 参考图已生成：{output} ({output.stat().st_size} B, theme={theme.value})")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="用 maimaiDX 原始代码渲染 b50 参考图",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent(
            """
            输入 JSON：
              {
                "player": {"name": "...", "rating": 15000, "course_rank": 3,
                           "class_rank": 20, "trophy": null, "qqid": null},
                "best50": {"sd_total": 8000, "dx_total": 7000,
                           "sd": [{"song_id": 8, "song_name": "...", "level": "13+",
                                   "level_index": 3, "level_value": 13.5,
                                   "type": "SD", "rating": 280,
                                   "achievements": 100.5, "rate": "sssp",
                                   "fc": "ap", "fs": "fsd", "dx_score": 2500}],
                           "dx": [...]},
                "theme": "prism_plus"
              }
            """
        ),
    )
    parser.add_argument("--input", required=True, help="输入 JSON 路径")
    parser.add_argument("--output", required=True, help="输出 PNG 路径")
    parser.add_argument("--sample", default=None, help="fixture 多样例时选择其中之一（s1/s2/s3）")
    parser.add_argument("--keep-build", action="store_true", help="保留临时 build 目录便于排查")
    args = parser.parse_args()

    data = normalize(json.loads(Path(args.input).read_text()), args.sample)
    workspace = Path(tempfile.mkdtemp(prefix="maidx-ref-"))
    try:
        asyncio.run(render(data, Path(args.output).resolve(), workspace))
    finally:
        if args.keep_build:
            print(f"[render-reference] build 目录保留在 {workspace}")
        else:
            shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    main()
