"""
marsmother / preprocess / build_sites.py

Spirit 주요 지점(js/data/spirit.js)마다 실제 데이터로 이미지를 만든다. (로버 사진 대신)
  1) 360° 지형 시점: 그 자리에 서서(눈높이 1.6 m) 사방을 둘러본 모습을 DEM + 가시광 모자이크로 렌더링
       - 3 km 안  : HiRISE DEM 2 m 격자 + 가시광 모자이크 (원본 0.25 m/px 를 2 m 로)
       - 30 km 안 : HiRISE DEM 30 m 격자 + 지도 사진
       - 그 밖    : MOLA 400 m 격자 (Gusev 크레이터 테두리 · 지평선)
       화성 곡률(거리² / 2R)과 먼지 낀 대기(거리에 따라 흐려짐)를 반영. ⚠ 사진이 아니라 지형 데이터로 그린 그림.
  2) 궤도 사진: 가시광 모자이크(HiRISE · CTX · HRSC, 0.25 m/px)에서 그 지점 주변 1.2 km / 400 m / 120 m 를 잘라냄
  3) HUD 를 3D 로 못 그릴 때 쓰는 현위치 360° 지형 시점

설치:  pip install rasterio numpy pillow
사용법 (프로젝트 루트에서, build_terrain.py · build_traverse.py 다음에):  python3 preprocess/build_sites.py

결과물
  - assets/sites/<id>-pano.jpg, <id>-orbit-1200m.jpg, <id>-orbit-400m.jpg, <id>-orbit-120m.jpg, <id>-thumb.jpg
  - js/data/sites.js  (const SITE_MEDIA = { id: { panorama, gallery, photo } })
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image, ImageDraw
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CLH_DEM = DATA / "CLH_DEM_Mosaic_HiRISE_CTX_HRSC_GCS_MARS_07-10-2018.tif"
CLH_IMG = DATA / "Mars Mosaic HiRISE 2018-07.tif"
MOLA = DATA / "Mola 400km DEM.tif"
MAP_PNG = ROOT / "assets" / "maps" / "columbia-hills.png"
OUT_DIR = ROOT / "assets" / "sites"
OUT_JS = ROOT / "js" / "data" / "sites.js"

MARS_R = 3396190.0
M_PER_DEG = MARS_R * math.pi / 180

PANO_W, PANO_H = 1800, 360
HORIZON_RATIO = 0.42  # js/hud.js 의 HORIZON_RATIO 와 같게
EYE_M = 1.6
NEAR_HALF_M = 1500  # 근거리 격자 반경
NEAR_RES_M = 2.0
SUN_AZ, SUN_ALT = 290.0, 30.0  # 오후 해 (서북서)
CROPS_M = [1200, 400, 120]
CROP_PX = 640

# 현위치(HUD 대체 화면용) — js/data/points.js 의 REGIONS.gusev.currentPosition
HERE = dict(id="here", name="현위치", lon=175.488, lat=-14.578)


# ─────────────────────────────── 격자 ───────────────────────────────
class Grid:
    """경위도 격자 (위쪽 줄 = 북쪽). 값 z(m), 밝기 a(0~1), 음영 s(0~1)"""

    def __init__(self, z, a, bounds):
        self.z, self.a, self.b = z.astype("f4"), a.astype("f4"), bounds
        h, w = z.shape
        lat0 = (bounds[1] + bounds[3]) / 2
        dx = (bounds[2] - bounds[0]) / w * M_PER_DEG * math.cos(math.radians(lat0))
        dy = (bounds[3] - bounds[1]) / h * M_PER_DEG
        gy, gx = np.gradient(self.z, dy, dx)
        gy = -gy  # 위쪽 줄이 북쪽
        # 태양 방향 (동, 북, 위)
        sa, sl = math.radians(SUN_AZ), math.radians(SUN_ALT)
        sun = np.array([math.sin(sa) * math.cos(sl), math.cos(sa) * math.cos(sl), math.sin(sl)])
        n = np.stack([-gx, -gy, np.ones_like(gx)])
        n /= np.linalg.norm(n, axis=0)
        self.s = np.clip(np.tensordot(sun, n, axes=1), 0, 1).astype("f4")

    def contains(self, lon, lat):
        w, s, e, n = self.b
        return (lon >= w) & (lon <= e) & (lat >= s) & (lat <= n)

    def sample(self, lon, lat):
        """bilinear → (z, a, s)"""
        w, s, e, n = self.b
        h, wd = self.z.shape
        fx = np.clip((lon - w) / (e - w) * (wd - 1), 0, wd - 1.001)
        fy = np.clip((n - lat) / (n - s) * (h - 1), 0, h - 1.001)
        x0, y0 = fx.astype(int), fy.astype(int)
        ax, ay = fx - x0, fy - y0
        out = []
        for g in (self.z, self.a, self.s):
            v = (g[y0, x0] * (1 - ax) + g[y0, x0 + 1] * ax) * (1 - ay) + (g[y0 + 1, x0] * (1 - ax) + g[y0 + 1, x0 + 1] * ax) * ay
            out.append(v)
        return out


def bounds_around(lon, lat, half_m):
    dlon = half_m / (M_PER_DEG * math.cos(math.radians(lat)))
    dlat = half_m / M_PER_DEG
    return lon - dlon, lat - dlat, lon + dlon, lat + dlat


def read_window(path, bounds, size, resampling=Resampling.average):
    with rasterio.open(path) as src:
        win = from_bounds(*bounds, src.transform)
        a = src.read(1, window=win, out_shape=(size, size), resampling=resampling, boundless=True, fill_value=0)
        nodata = src.nodata
    a = a.astype("f4")
    if nodata is not None:
        a[a == nodata] = np.nan
    a[a < -1e30] = np.nan
    return a


def fill_nan(a, value=None):
    if np.isnan(a).any():
        a[np.isnan(a)] = np.nanmedian(a) if value is None else value
    return a


def load_static_grids():
    # 30 km: DEM 30 m (1024 px) + 지도 사진
    with rasterio.open(CLH_DEM) as src:
        sb = src.bounds
        W, H = src.width, src.height
        z = src.read(1, out_shape=(round(1024 * H / W), 1024), resampling=Resampling.average).astype("f4")
    z[z < -1e30] = np.nan
    z = fill_nan(z)
    img = Image.open(MAP_PNG).convert("L").resize((z.shape[1], z.shape[0]), Image.BILINEAR)
    a = np.asarray(img, "f4") / 132.0  # 모자이크 중앙값 기준 밝기
    mid = Grid(z, a, (sb.left, sb.bottom, sb.right, sb.top))

    with rasterio.open(MOLA) as src:
        sb = src.bounds
        z = src.read(1).astype("f4")
    z[z == -9999] = np.nan
    z = fill_nan(z)
    far = Grid(z, np.full_like(z, 0.95), (sb.left, sb.bottom, sb.right, sb.top))
    return mid, far


def near_grid(lon, lat):
    b = bounds_around(lon, lat, NEAR_HALF_M)
    n = int(2 * NEAR_HALF_M / NEAR_RES_M)
    z = fill_nan(read_window(CLH_DEM, b, n))
    a = read_window(CLH_IMG, b, n)
    a[a == 0] = np.nan
    a = fill_nan(a, 132.0) / 132.0
    return Grid(z, a, b)


# ─────────────────────────────── 360° 렌더링 ───────────────────────────────
def hex_rgb(h):
    return np.array([int(h[i : i + 2], 16) for i in (1, 3, 5)], "f4") / 255


SKY_TOP, SKY_MID, SKY_HORIZON = hex_rgb("#5b4636"), hex_rgb("#b98d68"), hex_rgb("#e2bf98")
HAZE = hex_rgb("#cfa47c")
GROUND = hex_rgb("#c98f63")  # 화성 표토 색 (흑백 밝기에 곱함)


def sky_column():
    t = np.linspace(0, 1, PANO_H)[:, None] / HORIZON_RATIO  # 0 = 맨 위, 1 = 지평선
    t = np.clip(t, 0, 1)
    top = SKY_TOP + (SKY_MID - SKY_TOP) * np.clip(t / 0.55, 0, 1)
    return np.where(t < 0.55, top, SKY_MID + (SKY_HORIZON - SKY_MID) * np.clip((t - 0.55) / 0.45, 0, 1))


def render_pano(lon, lat, grids):
    near, mid, far = grids
    cos0 = math.cos(math.radians(lat))
    d = np.geomspace(1.2, 160000, 2600).astype("f4")
    az = (np.arange(PANO_W) + 0.5) / PANO_W * 2 * math.pi  # 왼쪽 끝 = 북쪽, 시계 방향
    E = np.sin(az)[:, None] * d[None, :]
    N = np.cos(az)[:, None] * d[None, :]
    LON = lon + E / (M_PER_DEG * cos0)
    LAT = lat + N / M_PER_DEG

    z = np.zeros_like(E)
    a = np.zeros_like(E)
    s = np.zeros_like(E)
    for g in (far, mid, near):  # 정밀한 것이 나중에 덮어씀
        m = g.contains(LON, LAT)
        if m.any():
            zz, aa, ss = g.sample(LON[m], LAT[m])
            z[m], a[m], s[m] = zz, aa, ss

    eye = near.sample(np.array([lon]), np.array([lat]))[0][0] + EYE_M
    drop = d[None, :] ** 2 / (2 * MARS_R)  # 화성 곡률
    ang = np.arctan2(z - drop - eye, d[None, :])  # 올려다본 각
    px_per_rad = PANO_W / (2 * math.pi)
    horizon = PANO_H * HORIZON_RATIO
    y = horizon - ang * px_per_rad  # 화면 줄 (아래로 갈수록 큼)

    color = GROUND[None, None, :] * np.clip(a, 0.3, 1.8)[..., None] * (0.35 + 0.8 * s)[..., None]
    fog = (1 - np.exp(-d / 45000))[None, :, None]
    color = color * (1 - fog) + HAZE * fog

    out = np.repeat(sky_column()[:, None, :], PANO_W, axis=1)
    rows = np.arange(PANO_H, dtype="f4")
    for c in range(PANO_W):
        m = np.minimum.accumulate(y[c])  # 가려지지 않은 가장 높은 줄
        k = np.searchsorted(-m, -rows, side="left")  # 그 줄에 처음 닿는 거리 단계
        vis = k < len(d)
        out[vis, c] = color[c, k[vis]]
    return Image.fromarray(np.clip(out * 255, 0, 255).astype(np.uint8))


# ─────────────────────────────── 궤도 사진 ───────────────────────────────
def orbit_crop(lon, lat, size_m):
    a = read_window(CLH_IMG, bounds_around(lon, lat, size_m / 2), CROP_PX, Resampling.bilinear)
    valid = a[(a > 0) & ~np.isnan(a)]
    lo, hi = np.percentile(valid, [1, 99]) if valid.size else (0, 255)
    a = np.nan_to_num(a)
    g = np.clip((a - lo) / max(hi - lo, 1) * 255, 0, 255).astype(np.uint8)
    im = Image.fromarray(g).convert("RGB")
    dr = ImageDraw.Draw(im)
    c, r = CROP_PX / 2, 9
    dr.ellipse([c - r, c - r, c + r, c + r], outline=(125, 249, 196), width=3)  # 그 지점 표시
    # 축척 막대: 크기의 1/4
    bar = CROP_PX / 4
    dr.rectangle([16, CROP_PX - 24, 16 + bar, CROP_PX - 19], fill=(255, 255, 255))
    dr.text((16, CROP_PX - 42), f"{size_m // 4} m", fill=(255, 255, 255))
    return im


# ─────────────────────────────── main ───────────────────────────────
def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    text = (ROOT / "js" / "data" / "spirit.js").read_text(encoding="utf-8")
    spirit = json.loads(re.search(r"=\s*(\{.*\});", text, re.S).group(1))
    sites = spirit["landmarks"] + [HERE]

    print("격자 준비 …")
    mid, far = load_static_grids()
    media = {}
    for site in sites:
        sid, lon, lat = site["id"], site["lon"], site["lat"]
        print(f"  {sid:16s} {lon:.5f}, {lat:.5f}")
        near = near_grid(lon, lat)
        render_pano(lon, lat, (near, mid, far)).save(OUT_DIR / f"{sid}-pano.jpg", quality=85, optimize=True)
        entry = {"panorama": f"assets/sites/{sid}-pano.jpg"}
        if sid != "here":
            gallery = []
            for size in CROPS_M:
                im = orbit_crop(lon, lat, size)
                name = f"{sid}-orbit-{size}m.jpg"
                im.save(OUT_DIR / name, quality=85, optimize=True)
                gallery.append(f"assets/sites/{name}")
                if size == 400:
                    im.resize((200, 200), Image.LANCZOS).crop((0, 25, 200, 175)).save(OUT_DIR / f"{sid}-thumb.jpg", quality=82)
            entry["gallery"] = gallery
            entry["photo"] = f"assets/sites/{sid}-thumb.jpg"
        media[sid] = entry

    OUT_JS.write_text(
        "// 자동 생성 파일 — 직접 고치지 말고 preprocess/build_sites.py 를 다시 실행\n"
        "// 지점별 이미지: panorama = DEM 으로 그린 360° 지형 시점 (사진 아님), gallery = 궤도 사진 1.2 km / 400 m / 120 m\n"
        f"const SITE_MEDIA = {json.dumps(media, ensure_ascii=False, indent=2)};\n",
        encoding="utf-8",
    )
    print(f"→ {OUT_JS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
