"""
marsmother / preprocess / preprocess.py

Mars Trek에서 받은 GeoTIFF(DEM, 영상 모자이크)를 분석하고 전처리한다.

설치:  pip install rasterio numpy matplotlib

사용법 (프로젝트 루트 marsmother/ 에서):
  1) 파일 구조·내용 분석 + 미리보기 이미지
       python preprocess/preprocess.py inspect
  2) 관심 구역 잘라내기 + 경사도 계산 (경도/위도 범위 지정)
       python preprocess/preprocess.py crop --lon 175.45 175.55 --lat -14.62 -14.52
       (생략하면 데이터 중앙 2km x 2km)

결과물은 preprocess/out/ 에 저장된다.
  - <파일명>_quicklook.png   : 축소 미리보기 (DEM은 음영기복 + 고도색)
  - report.json              : 메타데이터·통계 요약
  - crop_dem.tif / crop_img.tif / crop_slope.tif / crop_preview.png / crop_arrays.npz
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import transform as warp_transform
from rasterio.windows import Window, from_bounds

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
OUT_DIR = Path(__file__).resolve().parent / "out"
PREVIEW_MAX = 2048          # 미리보기 최대 한 변 픽셀 수 (전체를 메모리에 올리지 않기 위함)
NODATA_FLOOR = -1e30        # 이보다 작은 값은 빈 값으로 간주 (-3.4e38 같은 채움값 대비)
EXPECTED_STD_PARALLEL = -14.5  # Columbia Hills 제품 설명서상 표준 위선


# ─────────────────────────────── 공통 유틸 ───────────────────────────────
def setup_plot():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams["font.family"] = ["Malgun Gothic", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    return plt


def find_files() -> dict[str, Path]:
    """data/ 에서 DEM과 영상(Visible) 파일을 찾는다."""
    tifs = sorted(DATA_DIR.glob("*.tif"))
    if not tifs:
        raise SystemExit(f"{DATA_DIR} 에 .tif 파일이 없어요.")
    files = {}
    for p in tifs:
        name = p.name.upper()
        if "DEM" in name:
            files["dem"] = p
        elif "VISIBLE" in name or "MOSAIC" in name:
            files.setdefault("img", p)
    return files


def masked(arr: np.ndarray, nodata) -> np.ma.MaskedArray:
    """nodata 값, NaN, 극단적 채움값을 가린다."""
    a = arr.astype("float64", copy=False)
    m = ~np.isfinite(a) | (a < NODATA_FLOOR)
    if nodata is not None and np.isfinite(nodata):
        m |= a == nodata
    return np.ma.MaskedArray(a, mask=m)


def read_preview(src, band: int = 1) -> np.ma.MaskedArray:
    """긴 변이 PREVIEW_MAX 이하가 되도록 축소해서 읽는다(오버뷰가 있으면 GDAL이 자동 사용)."""
    scale = max(src.width, src.height) / PREVIEW_MAX
    scale = max(scale, 1.0)
    shape = (int(src.height / scale), int(src.width / scale))
    arr = src.read(band, out_shape=shape, resampling=Resampling.average)
    return masked(arr, src.nodata)


def crs_params(src) -> dict:
    try:
        return src.crs.to_dict()
    except Exception:
        return {}


def mars_geographic(src) -> str:
    """원본 투영과 같은 반지름을 쓰는 화성 경위도 좌표계 (경위도 <-> 투영 좌표 변환용)."""
    p = crs_params(src)
    radius = p.get("R") or p.get("a") or 3396190.0
    return f"+proj=longlat +R={radius} +no_defs"


def pixel_size_m(src) -> tuple[float, float]:
    """픽셀 크기(m). 파일명에 GCS가 붙은 것처럼 경위도(도 단위) 좌표계면 m로 환산."""
    rx, ry = abs(src.res[0]), abs(src.res[1])
    if src.crs and src.crs.is_geographic:
        p = crs_params(src)
        radius = p.get("R") or p.get("a") or 3396190.0
        lat_c = np.radians((src.bounds.top + src.bounds.bottom) / 2)
        m_per_deg = np.pi / 180 * radius
        return rx * m_per_deg * np.cos(lat_c), ry * m_per_deg
    return rx, ry


def lonlat_to_xy(src, lons, lats):
    xs, ys = warp_transform(mars_geographic(src), src.crs, list(lons), list(lats))
    return xs, ys


def xy_to_lonlat(src, xs, ys):
    lons, lats = warp_transform(src.crs, mars_geographic(src), list(xs), list(ys))
    return lons, lats


# ─────────────────────────────── 1) 분석 ───────────────────────────────
def inspect_file(path: Path) -> dict:
    with rasterio.open(path) as src:
        p = crs_params(src)
        res_x, res_y = pixel_size_m(src)
        info = {
            "file": path.name,
            "size_GB": round(path.stat().st_size / 1e9, 2),
            "driver": src.driver,
            "width_px": src.width,
            "height_px": src.height,
            "bands": src.count,
            "dtype": src.dtypes[0],
            "nodata": src.nodata,
            "compression": str(src.compression) if src.compression else None,
            "tiled": bool(src.profile.get("tiled", False)),
            "block_shape": list(src.block_shapes[0]),
            "overviews": src.overviews(1),
            "crs_wkt_head": src.crs.to_wkt()[:200] if src.crs else None,
            "crs_params": p,
            "crs_is_geographic": bool(src.crs and src.crs.is_geographic),
            "pixel_size_native": [abs(src.res[0]), abs(src.res[1])],
            "pixel_size_m": [round(res_x, 3), round(res_y, 3)],
            "extent_km": [round(src.width * abs(res_x) / 1000, 2), round(src.height * abs(res_y) / 1000, 2)],
            "bounds_xy": list(src.bounds),
            "units": src.units,
            "band_descriptions": src.descriptions,
            "tags": {k: str(v)[:120] for k, v in src.tags().items()},
        }

        # 경위도 범위
        b = src.bounds
        lons, lats = xy_to_lonlat(src, [b.left, b.right], [b.bottom, b.top])
        info["bounds_lonlat"] = {"lon": [round(min(lons), 4), round(max(lons), 4)],
                                 "lat": [round(min(lats), 4), round(max(lats), 4)]}

        # 표준 위선 확인 (설명서: Columbia Hills = -14.5°)
        sp = p.get("lat_ts")
        info["std_parallel"] = sp
        info["std_parallel_ok"] = (sp is not None and abs(sp - EXPECTED_STD_PARALLEL) < 0.01)

        # 축소본으로 통계
        prev = read_preview(src)
        valid = prev.compressed()
        info["preview_shape"] = list(prev.shape)
        info["valid_ratio"] = round(float(valid.size / prev.size), 4) if prev.size else 0.0
        if valid.size:
            q = np.percentile(valid, [0, 1, 50, 99, 100])
            info["stats"] = {"min": float(q[0]), "p1": float(q[1]), "median": float(q[2]),
                             "p99": float(q[3]), "max": float(q[4]), "mean": float(valid.mean()),
                             "std": float(valid.std())}
    return info


def hillshade(z: np.ndarray, dx: float, dy: float, az=315.0, alt=45.0) -> np.ndarray:
    gy, gx = np.gradient(z, dy, dx)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    az, alt = np.radians(az), np.radians(alt)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip(hs, 0, 1)


def save_quicklook(path: Path, kind: str):
    plt = setup_plot()

    with rasterio.open(path) as src:
        prev = read_preview(src)
        px, py = pixel_size_m(src)
        sx = src.width / prev.shape[1] * px
        sy = src.height / prev.shape[0] * py

    fig, ax = plt.subplots(figsize=(9, 9))
    if kind == "dem":
        z = prev.filled(np.nan)
        zf = np.where(np.isnan(z), np.nanmedian(z), z)
        ax.imshow(hillshade(zf, sx, sy), cmap="gray")
        im = ax.imshow(np.ma.masked_invalid(z), cmap="terrain", alpha=0.55)
        fig.colorbar(im, ax=ax, shrink=0.7, label="고도 elevation (m)")
    else:
        lo, hi = np.percentile(prev.compressed(), [1, 99]) if prev.count() else (0, 1)
        ax.imshow(np.clip((prev - lo) / (hi - lo + 1e-9), 0, 1).filled(0), cmap="gray")
    ax.set_title(f"{path.name}\n(축소 미리보기, 1px ≈ {sx:.0f} m)", fontsize=9)
    ax.axis("off")
    out = OUT_DIR / f"{path.stem}_quicklook.png"
    fig.savefig(out, dpi=130, bbox_inches="tight")
    plt.close(fig)
    return out


def compare_grids(a: dict, b: dict) -> dict:
    """DEM과 영상이 같은 격자인지(그대로 픽셀 단위로 겹칠 수 있는지) 확인."""
    same_crs = a["crs_params"] == b["crs_params"]
    same_bounds = np.allclose(a["bounds_xy"], b["bounds_xy"], atol=1.0)
    ratio = [round(a["pixel_size_m"][i] / b["pixel_size_m"][i], 3) for i in range(2)]
    return {"same_crs": same_crs, "same_bounds(±1m)": same_bounds,
            "dem_px / img_px": ratio,
            "note": ("같은 범위·좌표계. 해상도 비율만큼 리샘플하면 픽셀이 정확히 겹침"
                     if same_crs and same_bounds else
                     "좌표계나 범위가 달라요. rasterio.warp.reproject로 한쪽을 다른 쪽 격자에 맞춰야 해요.")}


def cmd_inspect(_args):
    OUT_DIR.mkdir(exist_ok=True)
    files = find_files()
    report = {}
    for kind, path in files.items():
        print(f"\n=== {kind.upper()} : {path.name} ===")
        info = inspect_file(path)
        report[kind] = info
        for k in ("size_GB", "width_px", "height_px", "bands", "dtype", "nodata", "compression",
                  "tiled", "overviews", "pixel_size_m", "extent_km", "bounds_lonlat",
                  "std_parallel", "std_parallel_ok", "valid_ratio", "stats"):
            print(f"  {k:16s}: {info.get(k)}")
        if not info["overviews"]:
            print("  ※ 오버뷰(피라미드)가 없어 미리보기 읽기가 느릴 수 있어요. "
                  "한 번만: gdaladdo -r average <파일> 2 4 8 16 32")
        if info["crs_is_geographic"]:
            print("  ※ 경위도(도 단위) 좌표계예요. 거리·경사는 m로 환산해서 계산합니다.")
        elif not info["std_parallel_ok"]:
            print(f"  ※ 표준 위선이 {EXPECTED_STD_PARALLEL}°가 아니에요(또는 읽지 못함). "
                  "거리·경사 계산 전에 CRS를 확인하세요.")
        print(f"  미리보기 저장: {save_quicklook(path, kind)}")

    if "dem" in report and "img" in report:
        report["grid_compare"] = compare_grids(report["dem"], report["img"])
        print("\n=== DEM vs 영상 격자 비교 ===")
        for k, v in report["grid_compare"].items():
            print(f"  {k:16s}: {v}")

    (OUT_DIR / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str),
                                         encoding="utf-8")
    print(f"\n요약 저장: {OUT_DIR / 'report.json'}")


# ─────────────────────────────── 2) 잘라내기 + 경사 ───────────────────────────────
def crop_window(src, lon_rng, lat_rng) -> Window:
    xs, ys = lonlat_to_xy(src, [lon_rng[0], lon_rng[1], lon_rng[0], lon_rng[1]],
                          [lat_rng[0], lat_rng[0], lat_rng[1], lat_rng[1]])
    win = from_bounds(min(xs), min(ys), max(xs), max(ys), src.transform)
    win = win.round_offsets().round_lengths()
    return win.intersection(Window(0, 0, src.width, src.height))


def center_lonlat_box(src, size_m=2000.0):
    cx = (src.bounds.left + src.bounds.right) / 2
    cy = (src.bounds.bottom + src.bounds.top) / 2
    px, py = pixel_size_m(src)
    hx = size_m / 2 * abs(src.res[0]) / px   # 좌표계 단위(m 또는 도)로 환산한 반폭
    hy = size_m / 2 * abs(src.res[1]) / py
    lons, lats = xy_to_lonlat(src, [cx - hx, cx + hx], [cy - hy, cy + hy])
    return sorted(lons), sorted(lats)


def write_tif(path: Path, arr: np.ndarray, src, win: Window, dtype="float32", nodata=-9999.0):
    profile = src.profile.copy()
    profile.update(driver="GTiff", height=arr.shape[0], width=arr.shape[1], count=1,
                   dtype=dtype, nodata=nodata, transform=src.window_transform(win),
                   compress="deflate", tiled=True, blockxsize=256, blockysize=256)
    profile.pop("photometric", None)
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(arr.astype(dtype), 1)


def detail_map(img: np.ndarray, block: int = 64) -> np.ndarray:
    """블록별 고주파 에너지(라플라시안 표준편차). 값이 낮은 블록은 저해상도(CTX/HRSC)로 채워졌을 가능성이 큼."""
    a = img.astype("float64")
    lap = (-4 * a[1:-1, 1:-1] + a[:-2, 1:-1] + a[2:, 1:-1] + a[1:-1, :-2] + a[1:-1, 2:])
    h, w = lap.shape[0] // block, lap.shape[1] // block
    if h == 0 or w == 0:
        return np.array([[lap.std()]])
    return lap[: h * block, : w * block].reshape(h, block, w, block).std(axis=(1, 3))


def cmd_crop(args):
    plt = setup_plot()

    OUT_DIR.mkdir(exist_ok=True)
    files = find_files()
    if "dem" not in files:
        raise SystemExit("DEM 파일을 찾지 못했어요.")

    with rasterio.open(files["dem"]) as dem_src:
        lon_rng, lat_rng = (args.lon, args.lat) if args.lon and args.lat else center_lonlat_box(dem_src)
        win = crop_window(dem_src, lon_rng, lat_rng)
        if win.width <= 0 or win.height <= 0:
            raise SystemExit("지정한 범위가 DEM과 겹치지 않아요.")
        dem = masked(dem_src.read(1, window=win), dem_src.nodata)
        dx, dy = pixel_size_m(dem_src)
        dem_win_bounds = rasterio.windows.bounds(win, dem_src.transform)

        z = dem.filled(np.nan)
        gy, gx = np.gradient(z, dy, dx)
        slope = np.degrees(np.arctan(np.hypot(gx, gy)))
        write_tif(OUT_DIR / "crop_dem.tif", np.nan_to_num(z, nan=-9999.0), dem_src, win)
        write_tif(OUT_DIR / "crop_slope.tif", np.nan_to_num(slope, nan=-9999.0), dem_src, win)

    img = None
    if "img" in files:
        with rasterio.open(files["img"]) as img_src:
            iwin = from_bounds(*dem_win_bounds, img_src.transform).round_offsets().round_lengths()
            iwin = iwin.intersection(Window(0, 0, img_src.width, img_src.height))
            img = img_src.read(1, window=iwin)
            write_tif(OUT_DIR / "crop_img.tif", img, img_src, iwin, dtype=img.dtype.name,
                      nodata=img_src.nodata if img_src.nodata is not None else 0)
            img_res = pixel_size_m(img_src)[0]

    valid = np.isfinite(slope)
    print(f"범위   : 경도 {lon_rng[0]:.4f}~{lon_rng[1]:.4f}, 위도 {lat_rng[0]:.4f}~{lat_rng[1]:.4f}")
    print(f"DEM    : {z.shape[1]} x {z.shape[0]} px, 픽셀 {dx:.2f} m  "
          f"→ {z.shape[1] * dx / 1000:.2f} x {z.shape[0] * dy / 1000:.2f} km")
    print(f"고도   : {np.nanmin(z):.1f} ~ {np.nanmax(z):.1f} m, 빈 값 {(~valid).mean() * 100:.1f}%")
    if valid.any():
        s = slope[valid]
        print(f"경사   : 중앙값 {np.median(s):.1f}°, 95% {np.percentile(s, 95):.1f}°, "
              f"15° 초과 {(s > 15).mean() * 100:.1f}%, 25° 초과 {(s > 25).mean() * 100:.1f}%")
    if img is not None:
        dm = detail_map(img)
        print(f"영상   : {img.shape[1]} x {img.shape[0]} px, 픽셀 {img_res:.2f} m, "
              f"디테일 낮은 블록(저해상도 채움 의심) {(dm < np.median(dm) * 0.3).mean() * 100:.1f}%")

    np.savez_compressed(OUT_DIR / "crop_arrays.npz", dem=z.astype("float32"),
                        slope=slope.astype("float32"), pixel_m=np.array([dx, dy]),
                        lon=np.array(lon_rng), lat=np.array(lat_rng),
                        **({"img": img} if img is not None else {}))

    n = 3 if img is not None else 2
    fig, axes = plt.subplots(1, n, figsize=(6 * n, 6))
    axes[0].imshow(hillshade(np.nan_to_num(z, nan=np.nanmedian(z)), dx, dy), cmap="gray")
    im = axes[0].imshow(np.ma.masked_invalid(z), cmap="terrain", alpha=0.5)
    fig.colorbar(im, ax=axes[0], shrink=0.7, label="m")
    axes[0].set_title("DEM (음영기복 + 고도)")
    im = axes[1].imshow(np.ma.masked_invalid(slope), cmap="magma", vmin=0, vmax=35)
    fig.colorbar(im, ax=axes[1], shrink=0.7, label="°")
    axes[1].set_title("경사도 slope")
    if img is not None:
        lo, hi = np.percentile(img, [1, 99])
        axes[2].imshow(np.clip((img - lo) / (hi - lo + 1e-9), 0, 1), cmap="gray")
        axes[2].set_title("영상 image")
    for a in axes:
        a.axis("off")
    fig.tight_layout()
    fig.savefig(OUT_DIR / "crop_preview.png", dpi=120)
    plt.close(fig)
    print(f"저장   : {OUT_DIR}/crop_*.tif, crop_arrays.npz, crop_preview.png")


# ─────────────────────────────── main ───────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="Mars Trek GeoTIFF 분석/전처리")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("inspect", help="메타데이터·통계·미리보기")
    c = sub.add_parser("crop", help="관심 구역 잘라내기 + 경사도")
    c.add_argument("--lon", nargs=2, type=float, metavar=("MIN", "MAX"))
    c.add_argument("--lat", nargs=2, type=float, metavar=("MIN", "MAX"))
    args = ap.parse_args()
    {"crop": cmd_crop}.get(args.cmd, cmd_inspect)(args)


if __name__ == "__main__":
    main()