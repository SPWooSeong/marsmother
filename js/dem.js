// Mars Mother — 실제 DEM (고도) 읽기
// 데이터 정보: js/data/terrain.js (preprocess/build_terrain.py 가 data/ 원본에서 만들어 냄)
//   near   : HUD 현위치 주변 3 km, 2 m 격자 (HiRISE)
//   hirise : Columbia Hills 30 km, 약 30 m 격자 (HiRISE · CTX · HRSC 모자이크)
//   mola   : Gusev 주변 400 km, 약 400 m 격자 (MOLA + HRSC)
// 쓰는 곳: 3D 지도 고도 표시 (globe.js), HUD 지형 · 경사 위험도 (hud.js), 고도 색 레이어 (layers.js)
// ⚠ 픽셀을 읽어야 해서 file:// 로 열면 동작하지 않음 → 로컬 서버(python3 -m http.server)로 열기

const DEM_ORDER = ["near", "hirise", "mola"]; // 정밀한 것부터
const DEM_LABELS = { near: "HiRISE 2 m", hirise: "HiRISE 30 m", mola: "MOLA 400 m" };
const demGrids = {}; // key → { w, h, values(Float32Array, m), bounds }
const demPromises = {};

// 높이 PNG → 격자. 고도(m) = minM + (R*256 + G) / 65535 * (maxM - minM)
function loadDemGrid(key) {
  if (demPromises[key]) return demPromises[key];
  const info = DEM_DATA[key];
  demPromises[key] = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, c.width, c.height).data;
        const values = new Float32Array(c.width * c.height);
        const scale = (info.maxM - info.minM) / 65535;
        for (let i = 0; i < values.length; i++) values[i] = info.minM + (px[i * 4] * 256 + px[i * 4 + 1]) * scale;
        demGrids[key] = { key, w: c.width, h: c.height, values, bounds: info.bounds };
        resolve(demGrids[key]);
      } catch (e) {
        reject(e); // file:// 에서는 보안 정책 때문에 픽셀을 읽을 수 없음
      }
    };
    img.onerror = () => reject(new Error(`${info.height} 불러오기 실패`));
    img.src = info.height;
  });
  demPromises[key].catch(() => delete demPromises[key]); // 실패하면 다음에 다시 시도
  return demPromises[key];
}

// 격자 안 (fx, fy) 위치 값 (bilinear). 격자는 위쪽 줄 = 북쪽
function demBilinear(grid, fx, fy) {
  const x = Math.max(0, Math.min(grid.w - 1.001, fx));
  const y = Math.max(0, Math.min(grid.h - 1.001, fy));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const ax = x - x0;
  const ay = y - y0;
  const i = y0 * grid.w + x0;
  const v = grid.values;
  return (v[i] * (1 - ax) + v[i + 1] * ax) * (1 - ay) + (v[i + grid.w] * (1 - ax) + v[i + grid.w + 1] * ax) * ay;
}

function demContains(grid, lon, lat) {
  const b = grid.bounds;
  return lon >= b.lonMin && lon <= b.lonMax && lat >= b.latMin && lat <= b.latMax;
}

function demSample(grid, lon, lat) {
  const b = grid.bounds;
  return demBilinear(
    grid,
    ((lon - b.lonMin) / (b.lonMax - b.lonMin)) * (grid.w - 1),
    ((b.latMax - lat) / (b.latMax - b.latMin)) * (grid.h - 1)
  );
}

// 경위도의 고도 → { m, source } (불러온 격자 중 가장 정밀한 것). 범위 밖이거나 아직 못 불러왔으면 null
function demElevation(lon, lat) {
  for (const key of DEM_ORDER) {
    const grid = demGrids[key];
    if (grid && demContains(grid, lon, lat)) {
      // 탐사한 곳은 기존 DEM 대신 탐사로 갱신된 고도 (js/survey.js)
      const dz = typeof surveyDeltaAt === "function" ? surveyDeltaAt(lon, lat) : 0;
      return { m: demSample(grid, lon, lat) + dz, source: key, surveyed: dz !== 0 };
    }
  }
  return null;
}

function formatElevation(m) {
  return `${m < 0 ? "−" : ""}${Math.abs(Math.round(m)).toLocaleString("en-US")} m`;
}
