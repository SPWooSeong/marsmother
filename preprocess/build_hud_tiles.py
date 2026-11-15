"""
marsmother / preprocess / build_hud_tiles.py

HUD 발밑을 선명하게 보이게 하는 고해상도 표면 사진 타일.
현위치 주변 3 km (HUD 근거리 DEM 과 같은 범위)를 가시광 모자이크(원본 0.25 m/px)에서 원본 해상도 그대로 읽어
250 m × 250 m (1000 px) 타일 12 × 12 장으로 자른다. HUD 는 걷는 위치 주변 3 × 3 장만 불러와 2 m 간격 지형에 입힘.

밝기는 기존 근거리 사진(assets/terrain/hud-near-surface.jpg)에 맞춰 이어진 부분이 티 나지 않게 함.

설치:  pip install rasterio numpy pillow
사용법 (프로젝트 루트에서):  python3 preprocess/build_hud_tiles.py

결과물
  - assets/terrain/hud-tiles/<줄>-<칸>.jpg   (줄 0 = 북쪽, 칸 0 = 서쪽)
  - js/data/hud_tiles.js  (const HUD_TILES = {...})
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image, ImageFilter
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

ROOT = Path(__file__).resolve().parents[1]
IMG_TIF = ROOT / "data" / "Mars Mosaic HiRISE 2018-07.tif"
BASE_JPG = ROOT / "assets" / "terrain" / "hud-near-surface.jpg"
OUT_DIR = ROOT / "assets" / "terrain" / "hud-tiles"
OUT_JS = ROOT / "js" / "data" / "hud_tiles.js"

# js/data/terrain.js 의 DEM_DATA.near.bounds 와 같음 (3 km × 3 km)
BOUNDS = dict(lonMin=175.4618523, lonMax=175.5141477, latMin=-14.6033059, latMax=-14.5526941)
TILES = 12  # 12 × 12 장
TILE_PX = 1000  # 250 m / 0.25 m (원본 해상도)
DETAIL_RADIUS_PX = 40  # 10 m
DETAIL_GAIN = 2.5


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    n = TILES * TILE_PX
    print(f"가시광 모자이크 3 km 읽는 중 ({n}×{n}, 0.25 m/px) …")
    with rasterio.open(IMG_TIF) as src:
        win = from_bounds(BOUNDS["lonMin"], BOUNDS["latMin"], BOUNDS["lonMax"], BOUNDS["latMax"], src.transform)
        a = src.read(1, window=win, out_shape=(n, n), resampling=Resampling.average).astype("f4")
    valid = a > 0
    a[~valid] = np.median(a[valid])

    # 기존 근거리 사진과 밝기 맞추기: 같은 크기로 줄여서 a·x + b 를 최소제곱으로 구함
    base = np.asarray(Image.open(BASE_JPG).convert("L"), "f4")
    small = np.asarray(Image.fromarray(a).resize(base.shape[::-1], Image.BOX), "f4")
    A = np.c_[small.ravel(), np.ones(small.size)]
    k, c = np.linalg.lstsq(A, base.ravel(), rcond=None)[0]
    a = a * k + c
    print(f"  밝기 맞춤: {k:.3f}·x + {c:.1f}")

    # 잔 무늬 강조: 평원은 사진 대비가 낮아 가까이서 보면 밋밋함
    # → 10 m 보다 작은 무늬(돌 · 물결 · 작은 크레이터)만 DETAIL_GAIN 배로 키움. 넓은 범위의 밝기는 그대로
    a8 = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    blur = np.asarray(a8.filter(ImageFilter.GaussianBlur(DETAIL_RADIUS_PX)), "f4")
    a = np.clip(blur + (a - blur) * DETAIL_GAIN, 0, 255).astype(np.uint8)

    total = 0
    for r in range(TILES):
        for col in range(TILES):
            tile = a[r * TILE_PX : (r + 1) * TILE_PX, col * TILE_PX : (col + 1) * TILE_PX]
            path = OUT_DIR / f"{r}-{col}.jpg"
            Image.fromarray(tile).save(path, quality=80, optimize=True)
            total += path.stat().st_size

    meta = dict(
        bounds=BOUNDS,
        rows=TILES,
        cols=TILES,
        mPerPx=0.25,
        url="assets/terrain/hud-tiles/{r}-{c}.jpg",
    )
    OUT_JS.write_text(
        "// 자동 생성 파일 — 직접 고치지 말고 preprocess/build_hud_tiles.py 를 다시 실행\n"
        "// HUD 발밑 고해상도 표면 사진 타일 (0.25 m/px, 250 m 씩). 줄 r = 0 이 북쪽, 칸 c = 0 이 서쪽\n"
        f"const HUD_TILES = {json.dumps(meta, ensure_ascii=False)};\n",
        encoding="utf-8",
    )
    print(f"→ 타일 {TILES * TILES}장 ({total / 1e6:.1f} MB), {OUT_JS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
