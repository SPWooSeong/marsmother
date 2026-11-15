"""
marsmother / preprocess / build_layers.py

data/ 의 과학 레이어(JMARS shapefile, TES 열관성)를 Gusev 주변만 잘라
웹에서 바로 쓰는 파일로 만든다. (추가 라이브러리 필요 없음: 순수 파이썬)

사용법 (프로젝트 루트 marsmother/ 에서):
    python3 preprocess/build_layers.py            # 변환
    python3 preprocess/build_layers.py --survey   # 범위 안 개수만 확인

결과물
  - js/data/layers.js          : 레이어 GeoJSON 묶음 (const SCIENCE_LAYERS = {...})
                                 file:// 로 열어도 동작하도록 fetch 대신 <script> 로 불러옴
  - assets/layers/ti-overlay.png : TES 열관성 색 이미지 (투명 nodata)

잘라내는 범위는 열관성 데이터 범위(Gusev 중심 400 km × 400 km)와 같다.
"""
from __future__ import annotations

import argparse
import json
import shutil
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JMARS_DIR = ROOT / "data" / "jmars data"
TI_DIR = ROOT / "data" / "mars_thermointertia_gusev_400km"
OUT_JS = ROOT / "js" / "data" / "layers.js"
OUT_ASSET_DIR = ROOT / "assets" / "layers"

# 열관성 manifest.json 의 aoi 와 같은 범위 (경도 °E, 위도 °N)
BOX = (171.91487, -17.87412, 178.88513, -11.12588)  # west, south, east, north
ROUND = 5  # 소수 5자리 ≈ 0.6 m

# JMARS 레이어: (파일 이름, 앱에서 쓸 id, 남길 속성 칸)
# ⚠ JMARS 내보내기에서 칸 너비가 잘려 대부분의 속성 표가 깨져 있음 → 멀쩡한 칸만 남김
#   0개인 레이어(fans, clay)는 범위 안에 데이터가 없어 결과에서 빠짐
JMARS_LAYERS = [
    ("jmars_valley_network_database", "valleys", ["VNOrder"]),
    ("jmars_sparse_valleys_2005", "sparse_valleys", []),
    ("jmars_open_basins_2012", "open_basins", []),
    ("jmars_closed_basins_2015", "closed_basins", []),
    ("jmars_delta_database", "deltas", []),
    ("jmars_fan_survey_2005_2008", "fans", []),
    ("jmars_hydrous_mineral_detections_crism_omega", "hydrous_minerals", []),
    ("jmars_aqueous_mineral_distribution_2014.point", "aqueous_minerals", ["Class"]),
    ("jmars_clay_weathering_sequences", "clay", []),
    ("jmars_global_noachian_units", "geo_noachian", ["Unit", "UnitDesc"]),
    ("jmars_global_hesperian_units", "geo_hesperian", ["Unit", "UnitDesc"]),
    ("jmars_global_amazonian_units", "geo_amazonian", ["Unit", "UnitDesc"]),
]

TI_LAYERS = [
    ("layer_surface_units.geojson", "ti_surface_units"),
    ("layer_sand_trap_risk.geojson", "ti_sand_trap"),
    ("layer_ti_anomalies.geojson", "ti_anomalies"),
    ("layer_ti_contours.geojson", "ti_contours"),
]


# ─────────────────────────────── shapefile 읽기 ───────────────────────────────
def read_dbf(path: Path) -> list[dict]:
    raw = path.read_bytes()
    n = struct.unpack("<I", raw[4:8])[0]
    header_len, rec_len = struct.unpack("<HH", raw[8:12])
    fields = []
    pos = 32
    while raw[pos] != 0x0D:
        name = raw[pos : pos + 11].split(b"\0")[0].decode("latin-1")
        ftype = chr(raw[pos + 11])
        flen = raw[pos + 16]
        fields.append((name, ftype, flen))
        pos += 32
    rows = []
    for i in range(n):
        off = header_len + i * rec_len
        rec = raw[off : off + rec_len]
        p = 1  # 첫 바이트는 삭제 표시
        row = {}
        for name, ftype, flen in fields:
            s = rec[p : p + flen].replace(b"\0", b"").decode("utf-8", "replace").strip()
            p += flen
            if ftype in "NF":
                try:
                    v = float(s)
                    row[name] = int(v) if v.is_integer() and "." not in s else v
                except ValueError:
                    row[name] = None
            elif ftype == "L":
                row[name] = s.upper() in ("Y", "T")
            else:
                row[name] = s or None
        rows.append(row)
    return rows


def read_shp(path: Path) -> list[tuple[str, list] | None]:
    """각 레코드를 ('point', [x,y]) / ('line', [parts]) / ('polygon', [rings]) 로 반환"""
    raw = path.read_bytes()
    pos = 100
    out = []
    while pos + 8 <= len(raw):
        _, clen = struct.unpack(">II", raw[pos : pos + 8])
        body = raw[pos + 8 : pos + 8 + clen * 2]
        pos += 8 + clen * 2
        stype = struct.unpack("<i", body[:4])[0]
        base = stype % 10 if stype > 10 else stype  # Z/M 변형은 x,y 만 사용
        if stype == 0:
            out.append(None)
        elif base == 1:
            x, y = struct.unpack("<2d", body[4:20])
            out.append(("point", [x, y]))
        elif base == 8:
            npts = struct.unpack("<i", body[36:40])[0]
            pts = [list(struct.unpack("<2d", body[40 + i * 16 : 56 + i * 16])) for i in range(npts)]
            out.append(("multipoint", pts))
        elif base in (3, 5):
            nparts, npts = struct.unpack("<2i", body[36:44])
            starts = list(struct.unpack(f"<{nparts}i", body[44 : 44 + 4 * nparts]))
            p0 = 44 + 4 * nparts
            pts = [struct.unpack("<2d", body[p0 + i * 16 : p0 + 16 + i * 16]) for i in range(npts)]
            parts = [[list(pt) for pt in pts[s:e]] for s, e in zip(starts, starts[1:] + [npts])]
            out.append(("line" if base == 3 else "polygon", parts))
        else:
            out.append(None)
    return out


# ─────────────────────────────── 범위 자르기 ───────────────────────────────
def norm_lon(x: float) -> float:
    return x - 360 if x > 180 else x


def in_box(x, y):
    w, s, e, n = BOX
    return w <= x <= e and s <= y <= n


def clip_ring(ring):
    """Sutherland–Hodgman: 다각형 고리를 사각형으로 자름"""
    w, s, e, n = BOX
    edges = [
        (lambda p: p[0] >= w, lambda a, b: (w, a[1] + (b[1] - a[1]) * (w - a[0]) / (b[0] - a[0]))),
        (lambda p: p[0] <= e, lambda a, b: (e, a[1] + (b[1] - a[1]) * (e - a[0]) / (b[0] - a[0]))),
        (lambda p: p[1] >= s, lambda a, b: (a[0] + (b[0] - a[0]) * (s - a[1]) / (b[1] - a[1]), s)),
        (lambda p: p[1] <= n, lambda a, b: (a[0] + (b[0] - a[0]) * (n - a[1]) / (b[1] - a[1]), n)),
    ]
    pts = ring
    for inside, cross in edges:
        if not pts:
            break
        res = []
        prev = pts[-1]
        for cur in pts:
            if inside(cur):
                if not inside(prev):
                    res.append(cross(prev, cur))
                res.append(cur)
            elif inside(prev):
                res.append(cross(prev, cur))
            prev = cur
        pts = res
    return pts if len(pts) >= 3 else None


def clip_segment(a, b):
    """Liang–Barsky: 선분을 사각형으로 자름 (없으면 None)"""
    w, s, e, n = BOX
    x0, y0 = a
    dx, dy = b[0] - x0, b[1] - y0
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, x0 - w), (dx, e - x0), (-dy, y0 - s), (dy, n - y0)):
        if p == 0:
            if q < 0:
                return None
        else:
            t = q / p
            if p < 0:
                t0 = max(t0, t)
            else:
                t1 = min(t1, t)
    if t0 > t1:
        return None
    return (x0 + t0 * dx, y0 + t0 * dy), (x0 + t1 * dx, y0 + t1 * dy)


def clip_line(part):
    runs, cur = [], []
    for a, b in zip(part, part[1:]):
        seg = clip_segment(a, b)
        if not seg:
            if len(cur) >= 2:
                runs.append(cur)
            cur = []
            continue
        p, q = seg
        if not cur or cur[-1] != p:
            if len(cur) >= 2:
                runs.append(cur)
            cur = [p]
        cur.append(q)
        if q != tuple(b):  # 선분이 범위 밖으로 나감
            runs.append(cur)
            cur = []
    if len(cur) >= 2:
        runs.append(cur)
    return runs


def rnd(pts):
    out = []
    for x, y in pts:
        p = [round(x, ROUND), round(y, ROUND)]
        if not out or out[-1] != p:
            out.append(p)
    return out


def clip_geometry(kind, data):
    if kind == "point":
        x, y = norm_lon(data[0]), data[1]
        return {"type": "Point", "coordinates": rnd([(x, y)])[0]} if in_box(x, y) else None
    if kind == "multipoint":
        pts = [(norm_lon(x), y) for x, y in data if in_box(norm_lon(x), y)]
        return {"type": "MultiPoint", "coordinates": rnd(pts)} if pts else None
    parts = [[(norm_lon(x), y) for x, y in part] for part in data]
    if kind == "line":
        runs = [rnd(r) for part in parts for r in clip_line(part)]
        runs = [r for r in runs if len(r) >= 2]
        return {"type": "MultiLineString", "coordinates": runs} if runs else None
    rings = []
    for part in parts:
        c = clip_ring(part)
        if c:
            r = rnd(c)
            if len(r) >= 3:
                rings.append(r + [r[0]])
    # 고리마다 따로 잘랐으므로 MultiPolygon 대신 '고리 묶음'으로 두고 evenodd 로 칠함
    return {"type": "Polygon", "coordinates": rings} if rings else None


def load_jmars(name, keep=None):
    shp = read_shp(JMARS_DIR / f"{name}.shp")
    rows = read_dbf(JMARS_DIR / f"{name}.dbf")
    feats = []
    for geom, props in zip(shp, rows):
        if not geom:
            continue
        g = clip_geometry(*geom)
        if g:
            if keep is not None:
                props = {k: props.get(k) for k in keep}
            feats.append({"type": "Feature", "geometry": g, "properties": props})
    return feats


def load_ti(name):
    gj = json.loads((TI_DIR / name).read_text(encoding="utf-8"))
    for f in gj["features"]:
        f["geometry"] = round_geometry(f["geometry"])
    return gj["features"]


def round_geometry(g):
    def walk(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], ROUND), round(c[1], ROUND)]
        return [walk(x) for x in c]

    return {"type": g["type"], "coordinates": walk(g["coordinates"])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--survey", action="store_true", help="범위 안 개수와 속성 칸만 출력")
    args = ap.parse_args()

    layers = {}
    for name, lid, keep in JMARS_LAYERS:
        feats = load_jmars(name, None if args.survey else keep)
        print(f"{lid:20s} {len(feats):5d}  ({name})")
        if args.survey and feats:
            print("    칸:", list(feats[0]["properties"].keys()))
            print("    예:", feats[0]["properties"])
        if feats:
            layers[lid] = {"type": "FeatureCollection", "features": feats}

    for name, lid in TI_LAYERS:
        feats = load_ti(name)
        print(f"{lid:20s} {len(feats):5d}  ({name})")
        layers[lid] = {"type": "FeatureCollection", "features": feats}

    if args.survey:
        return

    manifest = json.loads((TI_DIR / "manifest.json").read_text(encoding="utf-8"))
    a = manifest["aoi"]
    meta = {
        "box": {"lonMin": BOX[0], "latMin": BOX[1], "lonMax": BOX[2], "latMax": BOX[3]},
        "tiOverlay": {
            "image": "assets/layers/ti-overlay.png",
            "bounds": {"lonMin": a["west"], "lonMax": a["east"], "latMin": a["south"], "latMax": a["north"]},
        },
        "tiLegend": manifest["legend"],
    }

    OUT_ASSET_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(TI_DIR / "ti_overlay.png", OUT_ASSET_DIR / "ti-overlay.png")

    body = json.dumps(layers, ensure_ascii=False, separators=(",", ":"))
    meta_s = json.dumps(meta, ensure_ascii=False, separators=(",", ":"))
    OUT_JS.write_text(
        "// 자동 생성 파일 — 직접 고치지 말고 preprocess/build_layers.py 를 다시 실행\n"
        "// 과학 레이어 (JMARS · TES 열관성), Gusev 주변 400 km 범위로 잘라냄. 좌표 [경도°E, 위도°N]\n"
        f"const SCIENCE_LAYER_META = {meta_s};\n"
        f"const SCIENCE_LAYERS = {body};\n",
        encoding="utf-8",
    )
    print(f"\n→ {OUT_JS.relative_to(ROOT)} ({OUT_JS.stat().st_size / 1024:.0f} KB)")
    print(f"→ {(OUT_ASSET_DIR / 'ti-overlay.png').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
