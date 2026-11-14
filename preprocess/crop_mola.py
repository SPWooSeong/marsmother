"""
marsmother / preprocess / crop_mola.py

전 지구 DEM  Mars_MOLA_blend200ppx_HRSC_DEM_clon0dd_200mpp_lzw.tif  (200 m/px)에서
Columbia Hills 고해상도 DEM·HiRISE 영상 범위(약 30 km x 30 km)의 중심을 기준으로
주변까지 넓혀 400 km x 400 km 구역을 잘라낸다.

원본은 경위도 격자라 동서 1°의 길이가 cos(위도)배로 줄어든다. 그래서
  - 남북 폭  : 400 km / (1°당 거리)
  - 동서 폭  : 400 km / (1°당 거리 * cos(중심 위도))
로 경위도 범위를 정해 원본 격자 그대로 잘라내고(_lonlat.tif, 리샘플 없음),
같은 범위를 중심 기준 등거리 원통도법(eqc, 미터 단위)으로 다시 맞춘
정사각형 격자(기본 200 m/px → 2000 x 2000 px, _eqc.tif)도 함께 저장한다.

설치:  pip install rasterio numpy matplotlib

사용법 (프로젝트 루트 marsmother/ 에서):
  python preprocess/crop_mola.py                       # CLH DEM 중심, 400 km x 400 km
  python preprocess/crop_mola.py --size-km 400 --res 200
  python preprocess/crop_mola.py --center 175.4367 -14.5746   # 중심 직접 지정 (경도 위도)

결과물 (preprocess/out/):
  - mola_400km_dem_lonlat.tif : 원본 경위도 격자 그대로 자른 DEM (float32, nodata -9999)
  - mola_400km_dem_eqc.tif    : 중심 기준 eqc(미터) 정사각형 격자 DEM
  - mola_400km_preview.png    : 음영기복 + 고도, 30 km CLH 범위 표시
  - mola_400km_meta.json      : 중심·범위·격자 정보
"""
from __future__ import annotations

import argparse
import json

import numpy as np
import rasterio
from affine import Affine
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.warp import reproject

from preprocess import OUT_DIR, setup_plot
from preprocess_mola import (fill_nan, find_clh_dem, find_mola, hillshade, m_per_deg, norm_lon,
                             pixel_size_rows, radius_m, read_lonlat_box, write_tif)

CLH_FALLBACK_BOUNDS = (175.1753, -14.8277, 175.6981, -14.3215)  # (W, S, E, N) CLH DEM 범위
NODATA = -9999.0
PAD_PX = 3   # eqc 리샘플 시 가장자리 보간용 여유 픽셀


def clh_bounds() -> tuple[float, float, float, float]:
    """Columbia Hills 고해상도 DEM(HiRISE 범위)의 (W, S, E, N). 파일이 없으면 기본값."""
    p = find_clh_dem()
    if p is None:
        print("  ※ data/ 에 CLH DEM이 없어 기본 범위를 사용합니다.")
        return CLH_FALLBACK_BOUNDS
    with rasterio.open(p) as c:
        b = c.bounds
    return b.left, b.bottom, b.right, b.top


def lonlat_box(lon0: float, lat0: float, size_m: float, mpd: float):
    """중심(lon0, lat0) 기준 size_m x size_m 에 해당하는 경위도 범위."""
    half_lat = size_m / 2 / mpd
    half_lon = size_m / 2 / (mpd * max(np.cos(np.radians(lat0)), 1e-6))
    if abs(lat0) + half_lat >= 90:
        raise SystemExit("범위가 극을 넘어요. 중심 위도나 크기를 줄이세요.")
    return (lon0 - half_lon, lon0 + half_lon), (lat0 - half_lat, lat0 + half_lat), half_lon, half_lat


def eqc_crs(lon0: float, lat0: float, R: float) -> CRS:
    return CRS.from_proj4(f"+proj=eqc +lat_ts={lat0} +lat_0={lat0} +lon_0={lon0} "
                          f"+x_0=0 +y_0=0 +R={R} +units=m +no_defs")


def lonlat_to_eqc(lon, lat, lon0, lat0, R):
    """eqc(lat_ts=lat0) 정방향 변환 (미리보기에 CLH 박스 그릴 때 사용)."""
    x = R * np.cos(np.radians(lat0)) * np.radians(((np.asarray(lon) - lon0 + 180) % 360) - 180)
    y = R * np.radians(np.asarray(lat) - lat0)
    return x, y


def main():
    ap = argparse.ArgumentParser(description="MOLA+HRSC 전 지구 DEM에서 CLH 중심 400 km x 400 km 잘라내기")
    ap.add_argument("--center", nargs=2, type=float, metavar=("LON", "LAT"),
                    help="중심 경도·위도 (생략하면 Columbia Hills DEM 범위 중심)")
    ap.add_argument("--size-km", type=float, default=400.0, help="한 변 길이(km). 기본 400")
    ap.add_argument("--res", type=float, default=200.0, help="eqc 출력 픽셀 크기(m). 기본 200 (원본과 동일)")
    args = ap.parse_args()

    OUT_DIR.mkdir(exist_ok=True)
    size_m = args.size_km * 1000.0
    tag = f"mola_{args.size_km:g}km"

    cw, cs, ce, cn = clh_bounds()
    if args.center:
        lon0, lat0 = norm_lon(args.center[0]), args.center[1]
    else:
        lon0, lat0 = (cw + ce) / 2, (cs + cn) / 2

    path = find_mola()
    print(f"\n=== {path.name} → {args.size_km:g} km x {args.size_km:g} km 잘라내기 ===")
    print(f"중심   : 경도 {lon0:.4f}°, 위도 {lat0:.4f}°")

    with rasterio.open(path) as src:
        R, mpd = radius_m(src), m_per_deg(src)
        lon_rng, lat_rng, half_lon, half_lat = lonlat_box(lon0, lat0, size_m, mpd)
        print(f"범위   : 경도 {lon_rng[0]:.4f}~{lon_rng[1]:.4f}° (±{half_lon:.4f}°), "
              f"위도 {lat_rng[0]:.4f}~{lat_rng[1]:.4f}° (±{half_lat:.4f}°)")

        # 1) 원본 경위도 격자 그대로 (리샘플 없음)
        dem, tf = read_lonlat_box(src, lon_rng, lat_rng)
        z = dem.filled(np.nan).astype("float32")
        write_tif(OUT_DIR / f"{tag}_dem_lonlat.tif", np.nan_to_num(z, nan=NODATA), src, tf, nodata=NODATA)
        dx_rows, dy = pixel_size_rows(src, tf, z.shape[0])

        # 2) eqc(미터) 정사각형 격자로 리샘플 — 가장자리 보간을 위해 조금 넓게 읽는다
        pad_lon, pad_lat = PAD_PX * abs(src.transform.a), PAD_PX * abs(src.transform.e)
        big, big_tf = read_lonlat_box(src, (lon_rng[0] - pad_lon, lon_rng[1] + pad_lon),
                                      (lat_rng[0] - pad_lat, lat_rng[1] + pad_lat))
        src_crs = src.crs

    n = int(round(size_m / args.res))
    half = n * args.res / 2
    dst_crs = eqc_crs(lon0, lat0, R)
    dst_tf = Affine(args.res, 0.0, -half, 0.0, -args.res, half)
    ze = np.full((n, n), np.nan, dtype="float32")
    reproject(source=big.filled(np.nan).astype("float32"), destination=ze,
              src_transform=big_tf, src_crs=src_crs, src_nodata=np.nan,
              dst_transform=dst_tf, dst_crs=dst_crs, dst_nodata=np.nan,
              resampling=Resampling.bilinear)
    profile = dict(driver="GTiff", height=n, width=n, count=1, dtype="float32", nodata=NODATA,
                   crs=dst_crs, transform=dst_tf, compress="deflate", tiled=True,
                   blockxsize=256, blockysize=256)
    with rasterio.open(OUT_DIR / f"{tag}_dem_eqc.tif", "w", **profile) as dst:
        dst.write(np.nan_to_num(ze, nan=NODATA), 1)

    # 요약 출력
    print(f"lonlat : {z.shape[1]} x {z.shape[0]} px, 동서 {dx_rows.min():.1f}~{dx_rows.max():.1f} m"
          f" / 남북 {dy:.1f} m  → 약 {z.shape[1] * dx_rows.mean() / 1000:.1f} x {z.shape[0] * dy / 1000:.1f} km")
    print(f"eqc    : {n} x {n} px, {args.res:g} m/px → {n * args.res / 1000:.1f} x {n * args.res / 1000:.1f} km")
    print(f"고도   : {np.nanmin(z):.0f} ~ {np.nanmax(z):.0f} m, 빈 값 lonlat {np.isnan(z).mean() * 100:.2f}%"
          f" / eqc {np.isnan(ze).mean() * 100:.2f}%")

    meta = {
        "source": path.name,
        "center_lonlat": [lon0, lat0],
        "size_km": args.size_km,
        "clh_bounds_WSEN": [cw, cs, ce, cn],
        "lonlat": {"file": f"{tag}_dem_lonlat.tif", "shape_hw": list(z.shape),
                   "lon_range": [tf.c, tf.c + tf.a * z.shape[1]],
                   "lat_range": [tf.f + tf.e * z.shape[0], tf.f],
                   "pixel_deg": [tf.a, -tf.e]},
        "eqc": {"file": f"{tag}_dem_eqc.tif", "shape_hw": [n, n], "res_m": args.res,
                "crs_proj4": dst_crs.to_proj4(), "transform": list(dst_tf)[:6]},
        "elevation_m": {"min": float(np.nanmin(z)), "max": float(np.nanmax(z)),
                        "mean": float(np.nanmean(z))},
        "nodata": NODATA,
    }
    (OUT_DIR / f"{tag}_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    # 미리보기 (eqc 격자, km 단위 축)
    plt = setup_plot()
    ext = (-half / 1000, half / 1000, -half / 1000, half / 1000)
    dx_e = np.full(n, args.res)
    fig, ax = plt.subplots(figsize=(9, 8))
    ax.imshow(hillshade(fill_nan(ze), dx_e, args.res), cmap="gray", extent=ext)
    im = ax.imshow(np.ma.masked_invalid(ze), cmap="terrain", alpha=0.5, extent=ext)
    fig.colorbar(im, ax=ax, shrink=0.8, label="고도 elevation (m)")
    bx, by = lonlat_to_eqc([cw, ce, ce, cw, cw], [cs, cs, cn, cn, cs], lon0, lat0, R)
    ax.plot(bx / 1000, by / 1000, color="red", lw=1.5)
    ax.annotate("Columbia Hills (HiRISE DEM)", (bx.max() / 1000, by.max() / 1000), color="red",
                fontsize=8, xytext=(4, 4), textcoords="offset points")
    ax.set_xlabel("동서 x (km, 중심 기준)")
    ax.set_ylabel("남북 y (km, 중심 기준)")
    ax.set_title(f"MOLA+HRSC DEM {args.size_km:g} km x {args.size_km:g} km "
                 f"(중심 {lon0:.3f}°E, {lat0:.3f}°)", fontsize=10)
    fig.tight_layout()
    fig.savefig(OUT_DIR / f"{tag}_preview.png", dpi=130)
    plt.close(fig)

    print(f"저장   : {OUT_DIR}/{tag}_dem_lonlat.tif, {tag}_dem_eqc.tif, {tag}_preview.png, {tag}_meta.json")


if __name__ == "__main__":
    main()
