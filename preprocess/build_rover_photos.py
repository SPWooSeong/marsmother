"""
marsmother / preprocess / build_rover_photos.py

Spirit 경로 위 사진 핀(data/spirit/spirit_pin.json)을 지도 데이터 포인트로 만든다.
  - 사진: data/spirit/pin<N>/pin<N>_pancam.jpeg, pin<N>_navcam.jpeg (NASA Photojournal 원본, 다운로드해 둔 것)
          → 웹용으로 줄여서 assets/rover/ 에 저장 (긴 변 MAX_SIDE px) + 목록용 썸네일
  - 위치: JSON 의 corrected_x / corrected_y 를 build_traverse.py 와 같은 방식(sol 36 기준점)으로 경위도로 옮김
          → 지도에 그려진 Spirit 주행 경로 위에 정확히 놓임
          (JSON 의 lat / lon 은 기준점 보정 없이 바꾼 값이라 경로에서 약 360~400 m 벗어나 있어 쓰지 않음)
  - 고도: HiRISE DEM 에서 읽음

설치:  pip install rasterio pillow
사용법 (프로젝트 루트에서):  python preprocess/build_rover_photos.py

결과물
  - assets/rover/pin<N>_<cam>.jpg, pin<N>_<cam>-thumb.jpg
  - js/data/rover_pins.js  (const ROVER_PINS = [...])
"""
from __future__ import annotations

import csv
import json
import math
from pathlib import Path

import rasterio
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PIN_JSON = ROOT / "data" / "spirit" / "spirit_pin.json"
PIN_DIR = ROOT / "data" / "spirit"
CSV = ROOT / "data" / "jmars data" / "MERA_traverse.csv"
CLH_TIF = ROOT / "data" / "CLH_DEM_Mosaic_HiRISE_CTX_HRSC_GCS_MARS_07-10-2018.tif"
OUT_DIR = ROOT / "assets" / "rover"
OUT_JS = ROOT / "js" / "data" / "rover_pins.js"

# build_traverse.py 와 같은 값
MARS_R = 3396190.0
M_PER_DEG = MARS_R * math.pi / 180
ANCHOR_SOL = 36
ANCHOR = (175.477951, -14.571504)

MAX_SIDE = 6000  # 웹용 사진 긴 변 (파노라마는 가로 22348 px 원본)
THUMB_H = 240
CAMS = {"pancam": "Pancam", "navcam": "Navcam"}

Image.MAX_IMAGE_PIXELS = None  # 원본 파노라마가 커서 PIL 경고 끔


def resize_save(src: Path, dst: Path, max_side: int | None = None, height: int | None = None):
    im = Image.open(src)
    im = im.convert("L" if im.mode == "L" else "RGB")
    w, h = im.size
    s = min(1.0, max_side / max(w, h)) if max_side else height / h
    if s < 1:
        im = im.resize((round(w * s), round(h * s)), Image.LANCZOS)
    im.save(dst, "JPEG", quality=85, optimize=True, progressive=True)
    return im.size


def main():
    rows = list(csv.DictReader(CSV.open()))
    anchor_row = next(r for r in rows if int(r["START_SOL"]) <= ANCHOR_SOL <= int(r["END_SOL"]))
    ax, ay = float(anchor_row["CORRECTED_X"]), float(anchor_row["CORRECTED_Y"])
    cos0 = math.cos(math.radians(ANCHOR[1]))

    def to_lonlat(x, y):
        return ANCHOR[0] + (x - ax) / (M_PER_DEG * cos0), ANCHOR[1] + (y - ay) / M_PER_DEG

    pins = json.loads(PIN_JSON.read_text(encoding="utf-8"))["pins"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    out = []
    for p in pins:
        lon, lat = to_lonlat(p["corrected_x"], p["corrected_y"])
        photos = []
        for cam, cam_label in CAMS.items():
            meta = p.get(cam)
            if not meta:
                continue
            src = PIN_DIR / f"pin{p['id']}" / f"pin{p['id']}_{cam}.jpeg"
            photo = dict(
                camera=cam_label,
                id=meta["id"],
                sol=meta.get("sol"),
                source=meta.get("source"),
                page=meta.get("page"),
                note=meta.get("note"),
            )
            if src.exists():
                name = f"pin{p['id']}_{cam}"
                size = resize_save(src, OUT_DIR / f"{name}.jpg", max_side=MAX_SIDE)
                resize_save(src, OUT_DIR / f"{name}-thumb.jpg", height=THUMB_H)
                photo.update(src=f"assets/rover/{name}.jpg", thumb=f"assets/rover/{name}-thumb.jpg",
                             color=Image.open(src).mode != "L", width=size[0], height=size[1])
            photos.append(photo)
        out.append(dict(
            id=p["id"], name=p["name"], site=p["site"], drive=p["drive"],
            startSol=p["start_sol"], endSol=p["end_sol"],
            lon=round(lon, 6), lat=round(lat, 6), photos=photos,
        ))

    with rasterio.open(CLH_TIF) as dem:
        for o, v in zip(out, dem.sample([(o["lon"], o["lat"]) for o in out])):
            o["elevM"] = round(float(v[0]), 1)

    OUT_JS.write_text(
        "// 자동 생성 파일 — 직접 고치지 말고 preprocess/build_rover_photos.py 를 다시 실행\n"
        "// Spirit 경로 위 사진 핀 (data/spirit/spirit_pin.json). 사진: NASA Photojournal Pancam / Navcam\n"
        "// lon/lat: corrected_x/y 를 spirit.js 와 같은 기준점(sol 36)으로 옮긴 값\n"
        f"const ROVER_PINS = {json.dumps(out, ensure_ascii=False, indent=1)};\n",
        encoding="utf-8",
    )
    for o in out:
        have = [f"{ph['camera']}{'' if ph.get('src') else '(사진 없음)'}" for ph in o["photos"]]
        print(f"pin{o['id']}  sol {o['startSol']:4d}  {o['lon']:.6f}, {o['lat']:.6f}  {o['elevM']:.0f} m  {', '.join(have)}  {o['name']}")
    print(f"→ {OUT_JS.relative_to(ROOT)}, {OUT_DIR.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
