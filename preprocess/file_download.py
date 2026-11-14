"""
Mars Trek 제품 다운로드 (진행률 표시 포함)
- 실행: python trek_download.py
- 표준 라이브러리만 사용 (설치 필요 없음)
- 다른 제품을 받으려면 TITLE만 바꾸세요. 저장 위치는 SAVE_DIR.
"""
import json
import os
import shutil
import sys
import time
import urllib.parse
import urllib.request

TITLE = "MRO HiRISE, DEM Columbia Hills"
SAVE_DIR = "data"

SEARCH_API = "https://trek.nasa.gov/mars/TrekServices/ws/index/eq/searchItems"
STREAM_API = "https://trek.nasa.gov/mars/TrekWS/rest/cat/data/stream"  # Mars Trek 'Download' 버튼이 쓰는 주소
CHUNK = 1024 * 1024  # 1 MB


def first(v):
    """Solr 응답은 값이 리스트([값])로 오기도 해서 첫 번째 값만 꺼냄"""
    return v[0] if isinstance(v, list) and v else v


def find_product(title):
    params = {"proj": "urn:ogc:def:crs:EPSG::104905", "start": 0, "rows": 100,
              "key": title.split(",")[-1].strip()}
    with urllib.request.urlopen(SEARCH_API + "?" + urllib.parse.urlencode(params), timeout=60) as r:
        docs = [{k: first(v) for k, v in d.items()} for d in json.load(r)["response"]["docs"]]
    for d in docs:
        if d.get("title") == title:
            return d
    names = "\n".join(" - " + str(d.get("title")) for d in docs)
    sys.exit(f"'{title}'을(를) 찾지 못했어요. 검색된 제품:\n{names}")


def fmt_time(sec):
    sec = int(sec)
    return f"{sec // 3600:d}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def draw(done, total, start, last_print=[0.0]):
    now = time.time()
    if now - last_print[0] < 0.2 and done < total:
        return  # 화면 갱신은 0.2초에 한 번
    last_print[0] = now
    elapsed = max(now - start, 1e-6)
    speed = done / elapsed  # bytes/s
    width = max(10, min(40, shutil.get_terminal_size((80, 20)).columns - 60))
    if total:
        frac = min(done / total, 1.0)
        filled = int(width * frac)
        bar = "█" * filled + "░" * (width - filled)
        eta = (total - done) / speed if speed > 0 else 0
        line = (f"\r|{bar}| {frac * 100:5.1f}%  {done / 1e9:5.2f}/{total / 1e9:.2f} GB  "
                f"{speed * 8 / 1e6:6.1f} Mbps  남은 시간 {fmt_time(eta)}")
    else:
        line = f"\r{done / 1e9:5.2f} GB 받음  {speed * 8 / 1e6:6.1f} Mbps  경과 {fmt_time(elapsed)}"
    sys.stdout.write(line)
    sys.stdout.flush()


def download(product):
    label = product["productLabel"]
    total = int(product.get("fileSize") or 0)
    url = STREAM_API + "?" + urllib.parse.urlencode({"label": label})

    os.makedirs(SAVE_DIR, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "marswalk-map/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        # 서버가 알려주는 파일명 사용 (없으면 라벨 + .tif)
        disp = r.headers.get("Content-Disposition", "")
        name = disp.split("filename=")[-1].strip('"; ') if "filename=" in disp else label + ".tif"
        path = os.path.join(SAVE_DIR, name)
        part = path + ".part"

        if os.path.exists(path) and total and os.path.getsize(path) == total:
            print(f"이미 받은 파일이 있어요: {path}")
            return path

        print(f"제품   : {product['title']}")
        print(f"저장   : {path}")
        print(f"용량   : {total / 1e9:.2f} GB" if total else "용량   : 알 수 없음")
        start = time.time()
        done = 0
        with open(part, "wb") as f:
            while True:
                chunk = r.read(CHUNK)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                draw(done, total, start)
        draw(done, total, start, [0.0])

    os.replace(part, path)  # 다 받은 뒤에만 정식 파일명으로 변경
    elapsed = time.time() - start
    print(f"\n완료: {done / 1e9:.2f} GB, {fmt_time(elapsed)} 소요 "
          f"(평균 {done * 8 / elapsed / 1e6:.1f} Mbps)")
    if total and done != total:
        print(f"주의: 받은 크기({done:,})가 목록상 크기({total:,})와 달라요. 다시 받아 보세요.")
    return path


if __name__ == "__main__":
    try:
        download(find_product(TITLE))
    except KeyboardInterrupt:
        print("\n중단했어요. (.part 파일은 지워도 됩니다. 이 서버는 이어받기를 지원하지 않아요.)")