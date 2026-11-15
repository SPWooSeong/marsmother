"""
marsmother / preprocess / build_terrain.py

data/ 의 DEM 두 개를 웹(3D 지도 · HUD · 레이어)에서 바로 쓰는 파일로 만든다.
  - Mola 400km DEM.tif                 : MOLA+HRSC 200 m/px, Gusev 주변 400 km
  - CLH_DEM_Mosaic_HiRISE_CTX_HRSC...  : Columbia Hills 30 km, 약 1 m/px

설치:  pip install rasterio numpy pillow
사용법 (프로젝트 루트 marsmother/ 에서):
    python3 preprocess/build_terrain.py

결과물
  - assets/terrain/mola-400km-height.png  : 광역 높이 (약 400 m 격자)
  - assets/terrain/gusev-30km-height.png  : Columbia Hills 전체 높이 (약 30 m 격자)
  - assets/terrain/hud-near-height.png    : HUD 현위치 주변 3 km 높이 (2 m 격자)
  - assets/layers/mola-relief.jpg         : 광역 고도 색 + 음영기복 (2D 레이어 · 3D 지도에 덮음)
  - assets/layers/hirise-relief.jpg       : Columbia Hills 고도 색 + 음영기복 (2D 레이어 · 3D 지도에 덮음, 4096 px ≈ 7 m/px)
  - js/data/terrain.js                    : 위 파일들의 범위 · 고도 범위 (const DEM_DATA)

높이 PNG 형식: 16bit 값을 R(상위 8bit) · G(하위 8bit) 에 나눠 담음.
    고도(m) = minM + (R*256 + G) / 65535 * (maxM - minM)
모든 격자는 경위도에 비례(등장방형)하고, 고도 기준은 둘 다 MOLA 아레오이드(반지름 3396.19 km 구 기준 좌표).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
MOLA_TIF = DATA / "Mola 400km DEM.tif"
CLH_TIF = DATA / "CLH_DEM_Mosaic_HiRISE_CTX_HRSC_GCS_MARS_07-10-2018.tif"
TERRAIN_DIR = ROOT / "assets" / "terrain"
LAYER_DIR = ROOT / "assets" / "layers"
OUT_JS = ROOT / "js" / "data" / "terrain.js"

MARS_R = 3396190.0
M_PER_DEG = MARS_R * np.pi / 180

# HUD 현위치 주변 3 km (assets/terrain/hud-near-surface.jpg 와 같은 범위)
NEAR_BOUNDS = dict(lonMin=175.4618523, lonMax=175.5141477, latMin=-14.6033059, latMax=-14.5526941)
NEAR_SIZE = 1501  # 3 km / 2 m + 1

# 고도 색 (MOLA 지도에서 흔히 쓰는 낮음=파랑 → 높음=흰색)
COLORMAP = ["#3b2a8c", "#2456c7", "#2bb5a0", "#4fbf3b", "#e8e03a", "#f08a24", "#d6301c", "#8c4a2f", "#f2f2f2"]


def read_dem(path, out_w=None, out_h=None, bounds=None):
    """DEM 을 (필요하면 범위를 잘라) 평균으로 줄여 읽음. nodata 는 NaN."""
    with rasterio.open(path) as src:
        window = None
        if bounds:
            window = from_bounds(bounds["lonMin"], bounds["latMin"], bounds["lonMax"], bounds["latMax"], src.transform)
            b = bounds
        else:
            sb = src.bounds
            b = dict(lonMin=sb.left, lonMax=sb.right, latMin=sb.bottom, latMax=sb.top)
        shape = (out_h, out_w) if out_w else None
        z = src.read(1, window=window, out_shape=shape, resampling=Resampling.average).astype("float32")
        nodata = src.nodata
    z[(z < -1e30) | (z == nodata)] = np.nan
    if np.isnan(z).any():
        z[np.isnan(z)] = np.nanmedian(z)
    return z, {k: round(float(v), 7) for k, v in b.items()}


def save_height_png(z, path):
    lo, hi = float(np.floor(z.min())), float(np.ceil(z.max()))
    q = np.round((z - lo) / (hi - lo) * 65535).astype(np.uint16)
    rgb = np.zeros((*z.shape, 3), np.uint8)
    rgb[..., 0] = q >> 8
    rgb[..., 1] = q & 255
    Image.fromarray(rgb).save(path, optimize=True)
    return lo, hi


def hillshade(z, dx_m, dy_m, azimuth=315, altitude=40, exaggeration=1.0):
    gy, gx = np.gradient(z * exaggeration, dy_m, dx_m)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(gy, -gx)  # 격자의 위쪽이 북쪽
    az, alt = np.radians(360 - azimuth + 90), np.radians(altitude)
    return np.clip(np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect), 0, 1)


def save_relief(z, bounds, lo, hi, path, exaggeration):
    """고도 색 + 음영기복"""
    stops = np.array([[int(c[i : i + 2], 16) for i in (1, 3, 5)] for c in COLORMAP], np.float32)
    t = np.clip((z - lo) / (hi - lo), 0, 1) * (len(stops) - 1)
    i0 = np.minimum(t.astype(int), len(stops) - 2)
    f = (t - i0)[..., None]
    rgb = stops[i0] * (1 - f) + stops[i0 + 1] * f
    lat0 = (bounds["latMin"] + bounds["latMax"]) / 2
    dx = (bounds["lonMax"] - bounds["lonMin"]) / z.shape[1] * M_PER_DEG * np.cos(np.radians(lat0))
    dy = (bounds["latMax"] - bounds["latMin"]) / z.shape[0] * M_PER_DEG
    shade = hillshade(z, dx, dy, exaggeration=exaggeration)
    rgb = rgb * (0.35 + 0.75 * shade[..., None])
    Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).save(path, quality=84, optimize=True)


def main():
    TERRAIN_DIR.mkdir(parents=True, exist_ok=True)
    LAYER_DIR.mkdir(parents=True, exist_ok=True)
    out = {"colormap": COLORMAP}

    # ── MOLA 400 km ──
    print("MOLA 400 km …")
    z, b = read_dem(MOLA_TIF)
    h, w = z.shape
    lo, hi = float(np.floor(z.min() / 100) * 100), float(np.ceil(z.max() / 100) * 100)
    save_relief(z, b, lo, hi, LAYER_DIR / "mola-relief.jpg", exaggeration=3)
    zs, _ = read_dem(MOLA_TIF, w // 2, h // 2)
    mn, mx = save_height_png(zs, TERRAIN_DIR / "mola-400km-height.png")
    out["mola"] = dict(
        name="MOLA + HRSC (200 m/px)",
        height="assets/terrain/mola-400km-height.png", bounds=b, minM=mn, maxM=mx,
        relief="assets/layers/mola-relief.jpg", reliefRange=[lo, hi],
    )
    print(f"   {w}x{h} → 높이 {zs.shape[1]}x{zs.shape[0]}, 고도 {mn:.0f} ~ {mx:.0f} m")

    # ── Columbia Hills 30 km (HiRISE · CTX · HRSC) ──
    print("Columbia Hills 30 km … (2.4 GB 파일이라 1~2분 걸림)")
    with rasterio.open(CLH_TIF) as src:
        W, H = src.width, src.height
    z, b = read_dem(CLH_TIF, 4096, round(4096 * H / W))
    lo, hi = np.percentile(z, [0.5, 99.5])
    lo, hi = float(np.floor(lo / 10) * 10), float(np.ceil(hi / 10) * 10)
    save_relief(z, b, lo, hi, LAYER_DIR / "hirise-relief.jpg", exaggeration=2)
    zs = np.asarray(Image.fromarray(z).resize((1024, round(1024 * H / W)), Image.BOX))
    mn, mx = save_height_png(zs, TERRAIN_DIR / "gusev-30km-height.png")
    out["hirise"] = dict(
        name="HiRISE · CTX · HRSC 모자이크 (1 m/px)",
        height="assets/terrain/gusev-30km-height.png", bounds=b, minM=mn, maxM=mx,
        relief="assets/layers/hirise-relief.jpg", reliefRange=[lo, hi],
    )
    print(f"   {W}x{H} → 높이 {zs.shape[1]}x{zs.shape[0]}, 고도 {mn:.0f} ~ {mx:.0f} m, 색 범위 {lo:.0f} ~ {hi:.0f} m")

    # ── HUD 근거리 3 km, 2 m 격자 ──
    print("HUD 근거리 3 km …")
    z, b = read_dem(CLH_TIF, NEAR_SIZE, NEAR_SIZE, bounds=NEAR_BOUNDS)
    mn, mx = save_height_png(z, TERRAIN_DIR / "hud-near-height.png")
    out["near"] = dict(
        name="HiRISE DEM (2 m 격자)",
        height="assets/terrain/hud-near-height.png", bounds=b, minM=mn, maxM=mx,
    )
    print(f"   {z.shape[1]}x{z.shape[0]}, 고도 {mn:.0f} ~ {mx:.0f} m")

    OUT_JS.write_text(
        "// 자동 생성 파일 — 직접 고치지 말고 preprocess/build_terrain.py 를 다시 실행\n"
        "// 실제 DEM (고도) 데이터 정보. 읽는 코드는 js/dem.js\n"
        f"const DEM_DATA = {json.dumps(out, ensure_ascii=False, indent=2)};\n",
        encoding="utf-8",
    )
    print(f"→ {OUT_JS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
