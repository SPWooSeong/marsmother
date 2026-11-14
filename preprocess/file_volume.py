"""
Mars Trek 제품 용량 확인
- 실행: python trek_filesize.py  (Colab에서는 셀에 붙여 넣고 실행)
- 표준 라이브러리만 사용 (설치 필요 없음)
- 다른 제품을 보려면 TITLE만 바꾸세요.
"""
import json
import urllib.parse
import urllib.request

TITLE = "MRO HiRISE, DEM Columbia Hills"

API = "https://trek.nasa.gov/mars/TrekServices/ws/index/eq/searchItems"
params = {
    "proj": "urn:ogc:def:crs:EPSG::104905",
    "start": 0,
    "rows": 100,
    "key": TITLE.split(",")[-1].strip(),  # 제목 뒷부분으로 검색 (예: "DEM Columbia Hills")
}
url = API + "?" + urllib.parse.urlencode(params)

with urllib.request.urlopen(url, timeout=60) as resp:
    docs = json.load(resp)["response"]["docs"]

def first(v):
    """Solr 응답은 값이 리스트([값])로 오기도 해서 첫 번째 값만 꺼냄"""
    return v[0] if isinstance(v, list) and v else v


docs = [{k: first(v) for k, v in d.items()} for d in docs]
matches = [d for d in docs if d.get("title") == TITLE]
if not matches:
    print(f"'{TITLE}'을(를) 찾지 못했어요. 검색된 제품:")
    for d in docs:
        print(" -", d.get("title"))
else:
    for d in matches:
        size = int(d.get("fileSize") or 0)
        print(f"제품명   : {d['title']}")
        print(f"라벨     : {d.get('productLabel')}")
        print(f"분류     : {d.get('productCat1')} / {d.get('productCat2')}")
        print(f"범위bbox : {d.get('bbox')}")
        print(f"용량     : {size:,} bytes  =  {size / 1e9:.2f} GB  ({size / 2**30:.2f} GiB)")