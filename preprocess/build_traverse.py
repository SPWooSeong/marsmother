"""
marsmother / preprocess / build_traverse.py

Spirit(MER-A) 로버의 실제 주행 기록(data/jmars data/MERA_traverse.csv)을 지도용 경위도로 바꾼다.

CSV 의 CORRECTED_X / CORRECTED_Y 는 착륙 지점 부근을 원점 근처로 하는 미터 단위(동/북) 좌표.
  → 위치 추정 기능에서 궤도 사진으로 확인한 sol 36 로버 위치(REGIONS.gusev.localize.truth)에 맞춰 경위도로 옮김.
  검증: 이렇게 옮기면 sol 581(Husband Hill 정상 도착일) 지점이 HiRISE DEM 의 국지 최고점과 30 m 안으로 맞음.

설치:  pip install rasterio numpy
사용법 (프로젝트 루트에서):  python3 preprocess/build_traverse.py

결과물: js/data/spirit.js  (const SPIRIT_TRAVERSE = {...})
  - path      : [[경도, 위도, sol, 고도(m)], ...]  — 같은 자리 반복 기록은 하나로 합침
  - landmarks : 주행 기록에서 뽑은 주요 지점 (sol 기준)
"""
from __future__ import annotations

import csv
import json
import math
from pathlib import Path

import rasterio

ROOT = Path(__file__).resolve().parents[1]
CSV = ROOT / "data" / "jmars data" / "MERA_traverse.csv"
CLH_TIF = ROOT / "data" / "CLH_DEM_Mosaic_HiRISE_CTX_HRSC_GCS_MARS_07-10-2018.tif"
OUT_JS = ROOT / "js" / "data" / "spirit.js"

MARS_R = 3396190.0
M_PER_DEG = MARS_R * math.pi / 180
ANCHOR_SOL = 36
ANCHOR = (175.477951, -14.571504)  # sol 36 로버 위치 (js/data/points.js 의 localize.truth)
MIN_STEP_M = 1.0  # 이보다 가까운 연속 기록은 합침

# 주요 지점: (id, 이름, 설명, 기준 sol). 위치는 그 sol 의 주행 기록에서 가져옴
LANDMARKS = [
    ("spirit-landing", "Columbia Memorial Station", "Spirit 착륙 지점 (2004-01-04)", 1),
    ("bonneville", "Bonneville Crater 가장자리", "착륙 후 처음 찾아간 큰 크레이터 (sol 65)", 65),
    ("west-spur", "Columbia Hills 도착 (West Spur)", "평원을 3 km 가로질러 언덕 기슭에 도착 (sol 156)", 156),
    ("husband-hill", "Husband Hill 정상", "Columbia Hills 의 봉우리 · 정상 도착 (sol 581)", 581),
    ("everest-pano", "Everest 파노라마 촬영지", "Husband Hill 정상에서 360° 파노라마 촬영 (sol 620~622)", 620),
    ("home-plate", "Home Plate", "화산 폭발로 쌓인 층상 지형 · 도착 (sol 744)", 744),
    ("low-ridge", "Low Ridge Haven", "2006년 겨울나기 (sol 880~1010, 가장 오래 머문 곳)", 880),
    ("troy", "Troy", "2009년 모래에 빠진 곳 · 마지막 교신 2010-03-22 (sol 2210)", None),  # None = 마지막 기록
]


def main():
    rows = list(csv.DictReader(CSV.open()))
    anchor_row = next(r for r in rows if int(r["START_SOL"]) <= ANCHOR_SOL <= int(r["END_SOL"]))
    ax, ay = float(anchor_row["CORRECTED_X"]), float(anchor_row["CORRECTED_Y"])
    cos0 = math.cos(math.radians(ANCHOR[1]))

    def to_lonlat(r):
        x, y = float(r["CORRECTED_X"]), float(r["CORRECTED_Y"])
        return ANCHOR[0] + (x - ax) / (M_PER_DEG * cos0), ANCHOR[1] + (y - ay) / M_PER_DEG

    pts = []
    for r in rows:
        lon, lat = to_lonlat(r)
        sol = int(r["START_SOL"])
        if pts:
            plon, plat, _ = pts[-1]
            if math.hypot((lon - plon) * M_PER_DEG * cos0, (lat - plat) * M_PER_DEG) < MIN_STEP_M:
                continue
        pts.append((lon, lat, sol))

    # 고도: 원본 HiRISE DEM (약 1 m/px) 에서 읽음
    with rasterio.open(CLH_TIF) as dem:
        elevs = [float(v[0]) for v in dem.sample([(lon, lat) for lon, lat, _ in pts])]

    path = [[round(lon, 6), round(lat, 6), sol, round(z, 1)] for (lon, lat, sol), z in zip(pts, elevs)]
    total_m = sum(
        math.hypot((b[0] - a[0]) * M_PER_DEG * cos0, (b[1] - a[1]) * M_PER_DEG) for a, b in zip(path, path[1:])
    )

    landmarks = []
    for lid, name, note, sol in LANDMARKS:
        # 그 sol 에 로버가 있던 자리 = 그 sol 이전의 마지막 기록
        p = path[-1] if sol is None else [q for q in path if q[2] <= sol][-1]
        landmarks.append(dict(id=lid, name=name, note=note, sol=p[2], lon=p[0], lat=p[1], elevM=p[3]))

    data = dict(
        source="NASA PDS MER Analyst's Notebook · Spirit (MER-A) 주행 기록 (MERA_traverse.csv)",
        anchor=dict(sol=ANCHOR_SOL, lon=ANCHOR[0], lat=ANCHOR[1]),
        lastSol=int(rows[-1]["END_SOL"]),
        distanceM=round(total_m),
        landmarks=landmarks,
        path=path,
    )
    OUT_JS.write_text(
        "// 자동 생성 파일 — 직접 고치지 말고 preprocess/build_traverse.py 를 다시 실행\n"
        "// Spirit 로버 실제 주행 기록. path: [경도°E, 위도°N, sol, 고도 m]\n"
        f"const SPIRIT_TRAVERSE = {json.dumps(data, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )
    print(f"{len(rows)} 기록 → {len(path)} 지점, 주행 거리 {total_m / 1000:.2f} km → {OUT_JS.relative_to(ROOT)}")
    for l in landmarks:
        print(f"  sol {l['sol']:5d}  {l['name']:<32s} {l['lon']:.5f}, {l['lat']:.5f}  {l['elevM']:.0f} m")


if __name__ == "__main__":
    main()
