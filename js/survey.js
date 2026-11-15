// Mars Mother — 탐사 구역 · 탐사로 갱신된 지형
// 가정: 우리가 가진 DEM(HiRISE 30 m)·열관성 지도는 촬영된 지 오래됐고, 화성 지형도 그동안 조금씩 바뀜.
//   → "실제 지형" = 기존 데이터 + 시간에 따른 변화 (아래 모델, 정해진 seed 로 매번 같게 만듦)
//   → 실제 지형은 직접 가 본 곳(경로에서 반경 SURVEY_RADIUS_M 안)만 알 수 있음
//   → 탐사된 칸은 기존 데이터 대신 탐사 데이터로 바꿔 씀 (길찾기 · 고도 · 지면 계수 모두)
// 탐사한 곳: 우리가 직접 걸어 다닌 곳 — HUD 에서 WASD 로 걸은 길. 저장하지 않으므로 새로고침하면 리셋
//  (Spirit 로버 경로는 참고용 표시일 뿐 탐사 구역과 무관)
//
// 시간에 따른 지형 변화 모델 (DEM 촬영 SURVEY_DEM_EPOCH 이후 경과 연수에 비례하는 것 포함)
//   1) DEM 자체 오차 · 위치 맞춤 오차: 부드러운 잡음 (±1 m 정도)
//   2) 사면 이완 (mass wasting): 볼록한 능선은 깎이고 오목한 곳은 메워짐
//   3) 바람에 의한 모래 이동: 모래 지대의 사구 · 연흔이 바람 방향으로 이동 (경과 연수 × 이동 속도)
//   4) 국지 사건: 새 충돌구 · 낙석/바위 지대 · 새 모래 퇴적 · 사면 붕괴
//
// 필요: dem.js(loadDemGrid, DEM_DATA) / eva.js(terrainEtaPrior) / main.js(mapImage, mapEl, view, geoToImagePx) / data/spirit.js

// 지나간 길에서 이만큼 안쪽이 탐사됨: 걸으면서 발밑 주변을 cm 급으로 확실히 잴 수 있는 거리
// 지도에는 발자취를 따라 폭 20 m 띠로 그림. 길찾기 격자는 30 m 라, 지형 데이터는 밟은 칸 단위로 갱신됨
const SURVEY_RADIUS_M = 10;
const SURVEY_DEM_EPOCH = Date.UTC(2007, 0, 1); // 기존 DEM 촬영 무렵 (HiRISE 스테레오)
const SURVEY_SEED = 20040104; // Spirit 착륙일 — 실제 지형을 매번 같게 만들기 위한 seed
const SURVEY_WALKS_KEY = "marsmother.surveyWalks";

const SURVEY_EVENT_TYPES = {
  crater: { label: "새 충돌구", color: "#ff5a5a" },
  boulders: { label: "낙석 · 바위 지대", color: "#ffb84d" },
  sand: { label: "새 모래 퇴적", color: "#ffe680" },
  slump: { label: "사면 붕괴", color: "#d17bff" },
};

const survey = {
  ready: null, // Promise
  loaded: false,
  // 격자 (HiRISE 30 m DEM 과 같음)
  w: 0, h: 0, b: null, dx: 0, dy: 0,
  priorZ: null, priorEta: null, // 기존 데이터
  trueZ: null, trueEta: null, // 실제 지형 (탐사해야만 앎)
  z: null, eta: null, slope: null, // 지금 아는 지형 = 탐사한 칸은 실제, 아닌 칸은 기존 (길찾기가 쓰는 것)
  rough: null, // 거칠기 · 암석 밀도 0~1 (발목 부상 위험). 기존: DEM 요철만 / 탐사한 칸: 실제 바위 밀도 포함
  rockTrue: null, // 실제 바위 밀도 (탐사해야 앎)
  dzKnown: null, // 탐사로 바뀐 고도 (탐사한 칸만, 나머지 0)
  mask: null, // 1 = 탐사됨
  events: [],
  observed: 0,
  version: 0,
  walks: [], // 저장된 걸어 본 길 [[lon, lat], ...][]
};

// ---------- seed 난수 · 잡음 ----------
function surveyRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 격자 간격 cell 칸의 값 잡음 (−1 ~ 1, smoothstep 보간)
function surveyValueNoise(w, h, cell, rand) {
  const lw = Math.ceil(w / cell) + 2;
  const lh = Math.ceil(h / cell) + 2;
  const lat = new Float32Array(lw * lh);
  for (let i = 0; i < lat.length; i++) lat[i] = rand() * 2 - 1;
  const out = new Float32Array(w * h);
  const ss = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < h; y++) {
    const fy = y / cell, y0 = Math.floor(fy), ty = ss(fy - y0);
    for (let x = 0; x < w; x++) {
      const fx = x / cell, x0 = Math.floor(fx), tx = ss(fx - x0);
      const i = y0 * lw + x0;
      const a = lat[i] * (1 - tx) + lat[i + 1] * tx;
      const c = lat[i + lw] * (1 - tx) + lat[i + lw + 1] * tx;
      out[y * w + x] = a * (1 - ty) + c * ty;
    }
  }
  return out;
}

function surveySlopeAt(s, i) {
  const { w, h, z, dx, dy } = s;
  const x = i % w, y = (i - x) / w;
  const gx = (z[y * w + Math.min(w - 1, x + 1)] - z[y * w + Math.max(0, x - 1)]) / (2 * dx);
  const gy = (z[Math.max(0, y - 1) * w + x] - z[Math.min(h - 1, y + 1) * w + x]) / (2 * dy);
  return (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
}

// 거칠기 0~1: 30 m 격자에서 보이는 요철(이웃 평균과의 차) + 경사. 탐사한 칸은 실제 바위 밀도를 더함
// ⚠ 궤도 DEM 으로는 발목을 다칠 크기(수십 cm)의 바위가 안 보임 → 미탐사 구역은 지형 요철로만 추정
function surveyRoughAt(s, i) {
  const { w, h, z } = s;
  const x = i % w, y = (i - x) / w;
  let sum = 0, n = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (!ox && !oy) continue;
      const nx = x + ox, ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      sum += z[ny * w + nx];
      n++;
    }
  }
  const resid = Math.abs(z[i] - sum / n);
  const base = Math.min(1, resid / 1.5) * 0.7 + Math.min(1, s.slope[i] / 30) * 0.3;
  return Math.min(1, base + (s.mask && s.mask[i] ? s.rockTrue[i] : 0));
}

// ---------- 실제 지형 만들기 ----------
function buildSurveyTruth(s) {
  const { w, h, dx, priorZ: z0, priorEta: eta0 } = s;
  const N = w * h;
  const rand = surveyRandom(SURVEY_SEED);
  const years = Math.max(1, (Date.now() - SURVEY_DEM_EPOCH) / (365.25 * 86400e3));
  const dz = new Float32Array(N);
  const eta = new Float32Array(eta0);
  const rock = new Float32Array(N); // 실제 바위 밀도 (궤도에서 안 보임)

  // 1) DEM 오차: 240 m · 90 m 파장 잡음
  const n1 = surveyValueNoise(w, h, 8, rand);
  const n2 = surveyValueNoise(w, h, 3, rand);
  for (let i = 0; i < N; i++) dz[i] += 0.7 * n1[i] + 0.3 * n2[i];

  // 2) 사면 이완: 3×3 평균 쪽으로 조금 (최대 ±1.5 m)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let sum = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) sum += z0[i + oy * w + ox];
      dz[i] += Math.max(-1.5, Math.min(1.5, 0.3 * (sum / 9 - z0[i])));
    }
  }

  // 3) 모래 이동: 모래 지대(열관성 낮음) + 잡음으로 생긴 모래 띠. 북서풍, 사구 파장 180 m, 연 1.5 m 이동
  const sandNoise = surveyValueNoise(w, h, 12, rand);
  const lambda = 180 / dx; // 칸
  const k = (2 * Math.PI) / lambda;
  const wind = { x: Math.cos(-0.6), y: Math.sin(-0.6) };
  const shift = (1.5 * years) / dx; // 칸
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const sand = Math.max(Math.min(1, (eta0[i] - 1.1) / 0.7), Math.max(0, (sandNoise[i] - 0.45) * 2.5));
      if (sand <= 0) continue;
      const p = x * wind.x + y * wind.y;
      dz[i] += sand * 1.2 * (Math.sin(k * (p - shift)) - Math.sin(k * p));
      eta[i] = Math.max(eta[i], 1.1 + 0.4 * sand);
    }
  }
  // 지면 상태도 조금씩 다름 (±10%)
  const etaNoise = surveyValueNoise(w, h, 5, rand);
  for (let i = 0; i < N; i++) eta[i] = Math.max(1, eta[i] * (1 + 0.1 * etaNoise[i]));

  // 바위 밭: 군데군데 (전체의 15% 정도) 자갈 · 바위가 깔린 곳
  const rockNoise = surveyValueNoise(w, h, 6, rand);
  for (let i = 0; i < N; i++) rock[i] = Math.max(0, (rockNoise[i] - 0.35) * 1.3);

  // 4) 국지 사건: 1 km² 에 약 3 개
  const areaKm2 = (w * dx * h * s.dy) / 1e6;
  const count = Math.round(areaKm2 * 3);
  const events = [];
  const disc = (cx, cy, r, fn) => {
    const R = Math.ceil(r);
    for (let oy = -R; oy <= R; oy++) {
      for (let ox = -R; ox <= R; ox++) {
        const x = cx + ox, y = cy + oy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const d = Math.hypot(ox, oy) / r;
        if (d <= 1) fn(y * w + x, d, ox, oy);
      }
    }
  };
  const slopeOf = (i) => surveySlopeAt({ ...s, z: z0 }, i);
  for (let n = 0; n < count; n++) {
    const cx = Math.floor(rand() * w);
    const cy = Math.floor(rand() * h);
    const ci = cy * w + cx;
    const roll = rand();
    let type = roll < 0.22 ? "crater" : roll < 0.55 ? "boulders" : roll < 0.88 ? "sand" : "slump";
    if (type === "slump" && slopeOf(ci) < 8) type = "boulders";
    let radiusM;
    if (type === "crater") {
      // 지름 40~120 m 의 새 충돌구: 깊이 지름의 0.15, 테두리 솟음
      radiusM = 20 + rand() * 40;
      const r = radiusM / dx;
      const depth = 0.3 * radiusM;
      disc(cx, cy, r * 1.6, (i, d) => {
        const t = d * 1.6;
        dz[i] += t < 1 ? -depth * (1 - t * t) + 0.12 * depth : 0.12 * depth * Math.max(0, 1 - (t - 1) / 0.6);
        eta[i] = Math.max(eta[i], t < 1 ? 1.35 : eta[i]); // 바닥엔 고운 흙
      });
    } else if (type === "boulders") {
      // 지름 80~200 m 바위 지대: 울퉁불퉁 (칸마다 ±2 m) + 살짝 솟음
      radiusM = 40 + rand() * 60;
      disc(cx, cy, radiusM / dx, (i, d) => {
        const fall = Math.cos((d * Math.PI) / 2);
        dz[i] += fall * (1.2 + (rand() * 2 - 1) * 2.2);
        eta[i] = Math.max(1.0, eta[i] * 0.95);
        rock[i] = Math.min(1, rock[i] + 0.7 * fall);
      });
    } else if (type === "sand") {
      // 지름 120~360 m 새 모래 퇴적: 발이 빠지는 무른 땅
      radiusM = 60 + rand() * 120;
      const soft = 1.5 + rand() * 0.4;
      disc(cx, cy, radiusM / dx, (i, d) => {
        const fall = Math.cos((d * Math.PI) / 2);
        dz[i] += 0.6 * fall;
        eta[i] = Math.max(eta[i], 1.1 + (soft - 1.1) * Math.min(1, fall * 1.6));
      });
    } else {
      // 사면 붕괴: 위쪽은 깎이고 아래쪽에 쌓임 (경사 방향으로)
      radiusM = 50 + rand() * 70;
      const x0 = Math.max(1, Math.min(w - 2, cx)), y0 = Math.max(1, Math.min(h - 2, cy));
      const gx = z0[y0 * w + x0 + 1] - z0[y0 * w + x0 - 1];
      const gy = z0[(y0 + 1) * w + x0] - z0[(y0 - 1) * w + x0];
      const gl = Math.hypot(gx, gy) || 1;
      const amp = 2 + rand() * 3;
      const r = radiusM / dx;
      disc(cx, cy, r, (i, d, ox, oy) => {
        const along = (ox * gx + oy * gy) / gl / r; // + 오르막 쪽
        dz[i] += -amp * along * Math.cos((d * Math.PI) / 2);
        eta[i] = Math.max(eta[i], 1.25);
      });
    }
    events.push({ type, i: ci, radiusM, found: false, ...surveyCellLonLat(s, ci) });
  }

  s.trueZ = new Float32Array(N);
  for (let i = 0; i < N; i++) s.trueZ[i] = z0[i] + dz[i];
  s.trueEta = eta;
  s.rockTrue = rock;
  s.events = events;
  s.years = years;
}

// ---------- 좌표 ----------
function surveyCellLonLat(s, i) {
  const x = i % s.w, y = (i - x) / s.w;
  return {
    lon: s.b.lonMin + (x / (s.w - 1)) * (s.b.lonMax - s.b.lonMin),
    lat: s.b.latMax - (y / (s.h - 1)) * (s.b.latMax - s.b.latMin),
  };
}

function surveyFxFy(lon, lat) {
  const b = survey.b;
  return [((lon - b.lonMin) / (b.lonMax - b.lonMin)) * (survey.w - 1), ((b.latMax - lat) / (b.latMax - b.latMin)) * (survey.h - 1)];
}

// ---------- 불러오기 ----------
function loadSurvey() {
  if (survey.ready) return survey.ready;
  survey.ready = loadDemGrid("hirise").then((dem) => {
    const s = survey;
    const { w, h, values, bounds: b } = dem;
    const lat0 = (b.latMin + b.latMax) / 2;
    Object.assign(s, {
      w, h, b,
      dx: ((b.lonMax - b.lonMin) / (w - 1)) * DEG_TO_M_SURVEY * Math.cos((lat0 * Math.PI) / 180),
      dy: ((b.latMax - b.latMin) / (h - 1)) * DEG_TO_M_SURVEY,
    });
    s.priorZ = values;
    // 기존 지면 계수: 열관성 해상도(약 7 km)가 낮아 32×32 칸 묶음으로 계산
    const eta = new Float32Array(w * h);
    const B = 32;
    for (let by = 0; by < h; by += B) {
      for (let bx = 0; bx < w; bx += B) {
        const c = surveyCellLonLat(s, Math.min(h - 1, by + B / 2) * w + Math.min(w - 1, bx + B / 2));
        const v = terrainEtaPrior(c.lon, c.lat);
        for (let y = by; y < Math.min(h, by + B); y++) eta.fill(v, y * w + bx, y * w + Math.min(w, bx + B));
      }
    }
    s.priorEta = eta;
    buildSurveyTruth(s);

    s.z = new Float32Array(values);
    s.eta = new Float32Array(eta);
    s.slope = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) s.slope[i] = surveySlopeAt(s, i);
    s.dzKnown = new Float32Array(w * h);
    s.mask = new Uint8Array(w * h);
    s.rough = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) s.rough[i] = surveyRoughAt(s, i);
    s.loaded = true;

    // 이미 탐사한 곳: 지금 서 있는 곳 + 저장된 걸어 본 길
    s.walks = loadSurveyWalks();
    surveyRevealHere();
    for (const walk of s.walks) surveyRevealPath(walk.map(([lon, lat]) => ({ lon, lat })), { silent: true });
    for (const e of s.events) e.found = !!s.mask[e.i];
    s.version++;
    document.dispatchEvent(new CustomEvent("surveychange"));
    return s;
  });
  survey.ready.catch((e) => {
    console.warn("탐사 지형: DEM 을 읽지 못했어요 (file:// 로 열었다면 로컬 서버로 열어야 해요).", e);
    survey.ready = null;
  });
  return survey.ready;
}

const DEG_TO_M_SURVEY = (Math.PI * 3396190) / 180;

// ---------- 탐사 (칸을 실제 지형으로 바꿈) ----------
// 한 점 주변 radiusM 안 칸을 탐사. 새로 알게 된 칸 번호 목록을 돌려줌
function surveyRevealAt(lon, lat, radiusM = SURVEY_RADIUS_M, out = []) {
  const s = survey;
  if (!s.loaded) return out;
  const [fx, fy] = surveyFxFy(lon, lat);
  const rx = radiusM / s.dx, ry = radiusM / s.dy;
  const x0 = Math.max(0, Math.floor(fx - rx)), x1 = Math.min(s.w - 1, Math.ceil(fx + rx));
  const y0 = Math.max(0, Math.floor(fy - ry)), y1 = Math.min(s.h - 1, Math.ceil(fy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // 반경이 칸(30 m)보다 작아도 서 있는 칸은 항상 탐사됨
      const standing = x === Math.round(fx) && y === Math.round(fy);
      if (!standing && ((x - fx) / rx) ** 2 + ((y - fy) / ry) ** 2 > 1) continue;
      const i = y * s.w + x;
      if (s.mask[i]) continue;
      s.mask[i] = 1;
      s.z[i] = s.trueZ[i];
      s.eta[i] = s.trueEta[i];
      s.dzKnown[i] = s.trueZ[i] - s.priorZ[i];
      s.observed++;
      out.push(i);
    }
  }
  return out;
}

// 새로 알게 된 칸과 그 이웃의 경사를 다시 계산. 경사가 바뀐 칸까지 포함한 목록을 돌려줌
function surveyRefreshSlopes(cells) {
  const s = survey;
  const touched = new Set();
  for (const i of cells) {
    const x = i % s.w, y = (i - x) / s.w;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nx = x + ox, ny = y + oy;
        if (nx >= 0 && ny >= 0 && nx < s.w && ny < s.h) touched.add(ny * s.w + nx);
      }
    }
  }
  for (const i of touched) s.slope[i] = surveySlopeAt(s, i);
  for (const i of touched) s.rough[i] = surveyRoughAt(s, i);
  return touched;
}

// 새로 발견한 국지 사건
function surveyNewEvents() {
  const found = [];
  for (const e of survey.events) {
    if (!e.found && survey.mask[e.i]) {
      e.found = true;
      found.push(e);
    }
  }
  return found;
}

// 경로(경위도 점 목록)를 따라 탐사. { cells: 바뀐 칸(경사 포함) Set, events: 새로 찾은 사건 }
function surveyRevealPath(points, { radiusM = SURVEY_RADIUS_M, silent = false } = {}) {
  const s = survey;
  if (!s.loaded || !points.length) return { cells: new Set(), events: [] };
  const fresh = [];
  const step = Math.min(s.dx, s.dy); // 한 칸보다 촘촘히
  surveyRevealAt(points[0].lon, points[0].lat, radiusM, fresh);
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1], c = points[k];
    const [ax, ay] = surveyFxFy(a.lon, a.lat);
    const [cx, cy] = surveyFxFy(c.lon, c.lat);
    const n = Math.max(1, Math.ceil(Math.hypot((cx - ax) * s.dx, (cy - ay) * s.dy) / step));
    for (let t = 1; t <= n; t++) {
      surveyRevealAt(a.lon + ((c.lon - a.lon) * t) / n, a.lat + ((c.lat - a.lat) * t) / n, radiusM, fresh);
    }
  }
  const cells = fresh.length ? surveyRefreshSlopes(fresh) : new Set();
  const events = silent ? [] : surveyNewEvents();
  if (fresh.length && !silent) {
    s.version++;
    surveyNotify();
  }
  return { cells, events, fresh: fresh.length };
}

// 탐사 중에는 칸이 아주 자주 바뀌므로 화면 갱신 알림은 모아서 (최대 0.2초에 한 번)
let surveyNotifyTimer = null;
function surveyNotify() {
  if (surveyNotifyTimer) return;
  surveyNotifyTimer = setTimeout(() => {
    surveyNotifyTimer = null;
    document.dispatchEvent(new CustomEvent("surveychange"));
  }, 200);
}

// ---------- 다른 모듈이 쓰는 값 ----------
// 탐사로 바뀐 고도 (dem.js 의 demElevation 이 더함). 탐사 안 된 곳은 0
function surveyDeltaAt(lon, lat) {
  const s = survey;
  if (!s.loaded || !s.observed) return 0;
  const b = s.b;
  if (lon < b.lonMin || lon > b.lonMax || lat < b.latMin || lat > b.latMax) return 0;
  const [fx, fy] = surveyFxFy(lon, lat);
  return demBilinear({ w: s.w, h: s.h, values: s.dzKnown }, fx, fy);
}

// 탐사된 곳의 지면 계수 (eva.js 의 terrainEta 가 씀). 탐사 안 된 곳은 null
function surveyEtaAt(lon, lat) {
  const s = survey;
  if (!s.loaded || !s.observed) return null;
  const b = s.b;
  if (lon < b.lonMin || lon > b.lonMax || lat < b.latMin || lat > b.latMax) return null;
  const [fx, fy] = surveyFxFy(lon, lat);
  const i = Math.round(fy) * s.w + Math.round(fx);
  return s.mask[i] ? s.eta[i] : null;
}

function surveyIsObserved(lon, lat) {
  return surveyEtaAt(lon, lat) !== null;
}

// ---------- 저장 (걸어 본 길) ----------
// 탐사 기록은 저장하지 않음 — 새로고침하면 처음(미탐험)부터 다시. 예전 버전이 저장해 둔 것은 지움
function loadSurveyWalks() {
  try {
    localStorage.removeItem(SURVEY_WALKS_KEY);
  } catch {
    // 무시
  }
  return [];
}

// HUD 로 걷는 동안의 발자취 (이번 접속 동안만 기억)
function surveyTrackPoint(p) {
  const s = survey;
  if (!s.track) {
    s.track = [];
    s.walks.push(s.track);
  }
  s.track.push([+p.lon.toFixed(6), +p.lat.toFixed(6)]);
}

// 지금 서 있는 곳 주변은 이미 본 것으로
function surveyRevealHere() {
  const here = typeof getCurrentPosition === "function" ? getCurrentPosition() : REGIONS.gusev.currentPosition;
  if (!here) return;
  surveyRevealPath([here], { silent: true });
  survey.walks.push([[+here.lon.toFixed(6), +here.lat.toFixed(6)]]); // 지도에 점으로 표시
}

// 걸어 본 길 기록 지우기 → 처음부터 다시 (지금 서 있는 곳만 남음)
function resetSurveyWalks() {
  const s = survey;
  if (!s.loaded) return;
  s.walks = [];
  s.z.set(s.priorZ);
  s.eta.set(s.priorEta);
  s.dzKnown.fill(0);
  s.mask.fill(0);
  s.observed = 0;
  for (let i = 0; i < s.w * s.h; i++) s.slope[i] = surveySlopeAt(s, i);
  for (let i = 0; i < s.w * s.h; i++) s.rough[i] = surveyRoughAt(s, i);
  s.track = null;
  surveyRevealHere();
  for (const e of s.events) e.found = !!s.mask[e.i];
  s.version++;
  document.dispatchEvent(new CustomEvent("surveyreset"));
  document.dispatchEvent(new CustomEvent("surveychange"));
}

// ---------- 지도 표시: 탐사된 구역 ----------
// 탐사된 곳만 컬러 지도 사진, 나머지는 흑백 (지도 사진 · 배경 타일에 흑백 필터)
// 컬러 = 발자취를 따라 폭 2 × SURVEY_RADIUS_M 의 띠. 벡터(SVG 마스크)라 크게 확대해도 또렷하고, 경로선 아래에 깔림
const SURVEY_SVG_NS = "http://www.w3.org/2000/svg";
const surveyColorSvg = document.createElementNS(SURVEY_SVG_NS, "svg");
surveyColorSvg.classList.add("map__survey-color");
surveyColorSvg.setAttribute("aria-hidden", "true");
surveyColorSvg.style.display = "none"; // 레이어를 켰을 때만 보임
surveyColorSvg.innerHTML =
  `<defs><mask id="survey-mask" maskUnits="userSpaceOnUse"><g id="survey-mask-lines" fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round"></g></mask></defs>` +
  `<image id="survey-color-image" mask="url(#survey-mask)" preserveAspectRatio="none"></image>`;
mapImage.after(surveyColorSvg);
const surveyView = { on: false, mini: false, drawnVersion: -1 };

// 발자취 띠의 폭 (지도 사진 픽셀)
function surveyBandPx() {
  return (2 * SURVEY_RADIUS_M * mapImage.naturalWidth) / MAP_WIDTH_M;
}

function drawSurveyColor() {
  if (!surveyView.on || !survey.loaded || !mapImage.naturalWidth) return;
  const W = mapImage.naturalWidth, H = mapImage.naturalHeight;
  surveyColorSvg.setAttribute("width", W);
  surveyColorSvg.setAttribute("height", H);
  surveyColorSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const mask = surveyColorSvg.querySelector("#survey-mask");
  for (const [k, v] of [["x", 0], ["y", 0], ["width", W], ["height", H]]) mask.setAttribute(k, v);
  const img = surveyColorSvg.querySelector("#survey-color-image");
  img.setAttribute("href", mapImage.getAttribute("src"));
  img.setAttribute("width", W);
  img.setAttribute("height", H);
  const lines = surveyColorSvg.querySelector("#survey-mask-lines");
  lines.setAttribute("stroke-width", surveyBandPx());
  lines.replaceChildren(
    ...survey.walks.map((walk) => {
      const el = document.createElementNS(SURVEY_SVG_NS, "polyline");
      const pts = walk.map(([lon, lat]) => {
        const { x, y } = lonLatToImage(lon, lat);
        return `${x.toFixed(3)},${y.toFixed(3)}`;
      });
      if (pts.length === 1) pts.push(pts[0]); // 한 점은 둥근 점으로
      el.setAttribute("points", pts.join(" "));
      return el;
    })
  );
}

function setSurveyExploredVisible(on) {
  surveyView.on = on;
  mapEl.classList.toggle("is-survey-mode", on);
  surveyColorSvg.style.display = on ? "" : "none";
  if (on) {
    loadSurvey().then(drawSurveyColor, () => {});
    drawSurveyColor();
  }
}

// 과학 레이어 캔버스 위: 발견한 지형 변화 지점 (화면에서 같은 크기)
function drawSurveyEvents(ctx, dpr) {
  if (!survey.loaded) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  const s = view.scale;
  for (const e of survey.events) {
    if (!e.found) continue;
    const p = geoToImagePx(e.lon, e.lat);
    const x = view.x + p.x * s, y = view.y + p.y * s;
    const type = SURVEY_EVENT_TYPES[e.type];
    ctx.beginPath();
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x + 6, y);
    ctx.lineTo(x, y + 6);
    ctx.lineTo(x - 6, y);
    ctx.closePath();
    ctx.fillStyle = type.color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
    ctx.stroke();
  }
}

// 요약 (레이어 범례에 표시)
function surveySummary() {
  const s = survey;
  if (!s.loaded) return null;
  const cellKm2 = (s.dx * s.dy) / 1e6;
  let sum = 0, maxAbs = 0;
  for (let i = 0; i < s.mask.length; i++) {
    if (!s.mask[i]) continue;
    sum += Math.abs(s.dzKnown[i]);
    maxAbs = Math.max(maxAbs, Math.abs(s.dzKnown[i]));
  }
  const byType = {};
  for (const e of s.events) if (e.found) byType[e.type] = (byType[e.type] || 0) + 1;
  // 밝힌 면적: 발자취 길이 × 띠 폭 (+ 양 끝 반원)
  let trackM = 0;
  const m = (a, b) => Math.hypot((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * DEG_TO_M_SURVEY;
  for (const w of s.walks) for (let k = 1; k < w.length; k++) trackM += m(w[k - 1], w[k]);
  return {
    areaM2: trackM * 2 * SURVEY_RADIUS_M + Math.PI * SURVEY_RADIUS_M ** 2,
    trackM,
    areaKm2: s.observed * cellKm2,
    pct: (s.observed / s.mask.length) * 100,
    meanAbsDz: s.observed ? sum / s.observed : 0,
    maxAbsDz: maxAbs,
    byType,
    walks: s.walks.filter((w) => w.length > 1).length,
    years: s.years,
  };
}

document.addEventListener("surveychange", () => {
  drawSurveyColor();
  if (typeof scheduleScienceLayers === "function") scheduleScienceLayers();
});
mapImage.addEventListener("load", () => {
  surveyView.drawnVersion = -1;
  drawSurveyColor();
});

// 지형 갱신이 고도 · 지면 계수 · 길찾기 모두에 반영되도록 미리 불러 둠
if (mapImage.complete && mapImage.naturalWidth) loadSurvey();
else mapImage.addEventListener("load", () => loadSurvey(), { once: true });
