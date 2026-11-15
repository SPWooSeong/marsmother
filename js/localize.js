// Mars Mother - 현재 위치 찾기 (지형 매칭 기반 전역 위치 추정 · 실제 Spirit Navcam 사진 + 궤도 사진)
//
// 참고 논문: Nash et al., "Censible: A Robust and Practical Global Localization Framework
//            for Planetary Surface Missions", ICRA 2024 (NASA JPL, Perseverance 탑재)
//
// ★ 실제 데이터로 동작:
//   - 관측(로버가 본 주변 지형): NASA Spirit 로버 Navcam 이 sol 36 (2004-02-09) 에 360° 로 찍은 사진을
//     위에서 본 지형으로 투영한 '수직 투영 모자이크' (NASA PDS, 제품 2NN036EFF04VRT00P1617L000M2)
//   - 궤도 지도: data/ 의 Columbia Hills 가시광 모자이크 (HiRISE · CTX · HRSC)
//   - 정답: 이 매칭 결과를 궤도 사진에 찍힌 Spirit 착륙선 위치로 따로 확인해 둔 값
//
// 논문의 흐름                              → 이 데모
// 1) 360° 스테레오 파노라마 촬영             → Spirit Navcam 실제 사진
// 2) 정사투영 (위에서 본 지형, 3~40m)         → PDS 수직 투영 모자이크를 0.5m 격자로 (4~25m 사용)
// 3) 수정 Census 변환 (빈 데이터는 벌점 없음)  → 그대로 구현
// 4) 템플릿 매칭 (Census 해밍 거리)           → 그대로 구현. 추정 위치 ± 40m 검색
//    (+ 고도 SSD: 로버 쪽 고도 자료가 없어 이 데모에서는 생략 — 논문 실험에서도 영향이 가장 작은 항목)
// 5) 서브픽셀 2차 보정 + 신뢰도               → 1D 2차 보정 + 유일성으로 신뢰도
//
// 사용하는 전역 값: REGIONS, currentRegion, formatLonLat, setDrawerOpen, view, mapEl, mapImage,
//   flyMapTo, lonLatToImage (main.js) / renderNavMap (route.js) / globe, viewer (globe.js)

// ---------- 설정 ----------
const LOC = {
  innerM: 4, // 로버 몸체·바로 옆 그림자 제외 (m)
  outerM: 25, // 관측 사용 반경 (m) — 멀수록 투영 오차가 커서 제한
  searchM: 40, // 검색 반경 = 추정 위치의 불확실성 (m)
  priorMinM: 15, // 시연용 '추정 위치' 가 정답에서 떨어진 거리 (무작위)
  priorMaxM: 35,
};

const POPCOUNT = new Uint8Array(256).map((_, i) => {
  let n = 0;
  for (let v = i; v; v >>= 1) n += v & 1;
  return n;
});

// 3x3 이웃 8개 (자기 자신 제외)
const NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

// ---------- 요소 ----------
const locBtn = document.getElementById("locate-btn");
const locDialog = document.getElementById("loc-dialog");
const locSteps = [...document.querySelectorAll(".loc-step")];
const locCanvases = {
  obs: document.getElementById("loc-obs"),
  census: document.getElementById("loc-census"),
  map: document.getElementById("loc-map"),
  score: document.getElementById("loc-score"),
};
const locSrcCanvas = document.getElementById("loc-src");
const locOverviewCanvas = document.getElementById("loc-overview");
const locSrcCoord = document.getElementById("loc-src-coord");
const locResultEl = document.getElementById("loc-result");
const locRetryBtn = document.getElementById("loc-retry");
const locShowBtn = document.getElementById("loc-show");
const locCloseBtn = document.getElementById("loc-close");
const locPatchEl = document.getElementById("loc-patch");

const loc = { data: null, running: false, result: null };

// ---------- 데이터 불러오기 ----------
function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${src} 를 불러오지 못했어요`));
    img.src = src;
  });
}

function pixelsOf(img) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  return { w: c.width, h: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
}

async function loadLocalizeData(cfg) {
  const [obsImg, orbitImg, viewImg] = await Promise.all([loadImg(cfg.observation), loadImg(cfg.orbit), loadImg(cfg.roverView)]);

  // 관측 템플릿: 밝기 + 유효(알파) → 사용 반경(4~25m) 만 남김
  const o = pixelsOf(obsImg);
  const S = o.w;
  const half = S / 2;
  const obs = new Float32Array(S * S);
  const valid = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) {
    const x = (i % S) + 0.5 - half;
    const y = Math.floor(i / S) + 0.5 - half;
    const r = Math.hypot(x, y) * cfg.resM;
    obs[i] = o.data[i * 4];
    valid[i] = o.data[i * 4 + 3] > 0 && r >= LOC.innerM && r <= LOC.outerM ? 1 : 0;
  }

  // 궤도 지도 (0.5m 격자)
  const m = pixelsOf(orbitImg);
  const A = new Float32Array(m.w * m.h);
  for (let i = 0; i < A.length; i++) A[i] = m.data[i * 4];

  return { cfg, S, obs, valid, N: m.w, A, orbitImg, viewImg };
}

// ---------- 격자 ↔ 경위도 ----------
function gridToLonLat(cfg, N, x, y) {
  const b = cfg.orbitBounds;
  return {
    lon: b.lonMin + (x / N) * (b.lonMax - b.lonMin),
    lat: b.latMax - (y / N) * (b.latMax - b.latMin),
  };
}

function lonLatToGrid(cfg, N, p) {
  const b = cfg.orbitBounds;
  return {
    x: ((p.lon - b.lonMin) / (b.lonMax - b.lonMin)) * N,
    y: ((b.latMax - p.lat) / (b.latMax - b.latMin)) * N,
  };
}

// ---------- 3) 수정 Census 변환 ----------
// code: 이웃보다 어둡거나 같으면 1 (논문 식 4), vmask: 비교가 유효한 이웃 (둘 다 데이터가 있을 때)
function censusTransform(img, valid, w, h) {
  const code = new Uint8Array(w * h);
  const vmask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (valid && !valid[i]) continue;
      let c = 0, v = 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + NEIGHBORS[k][0];
        const ny = y + NEIGHBORS[k][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (valid && !valid[j]) continue;
        v |= 1 << k;
        if (img[i] <= img[j]) c |= 1 << k;
      }
      code[i] = c;
      vmask[i] = v;
    }
  }
  return { code, vmask };
}

// ---------- 4) 템플릿 매칭 ----------
// 관측의 유효 픽셀만 모아 두고 (지도 기준 상대 위치), 검색 영역의 각 위치에서 해밍 거리 합산
function prepareTemplate(D, obsC) {
  const offs = [], dr = [], vr = [];
  const half = D.S / 2;
  for (let y = 0; y < D.S; y++) {
    for (let x = 0; x < D.S; x++) {
      const i = y * D.S + x;
      if (!D.valid[i] || !obsC.vmask[i]) continue;
      offs.push((y - half) * D.N + (x - half));
      dr.push(obsC.code[i]);
      vr.push(obsC.vmask[i]);
    }
  }
  const bits = vr.reduce((a, b) => a + POPCOUNT[b], 0);
  return { n: offs.length, bits, offs: Int32Array.from(offs), dr: Uint8Array.from(dr), vr: Uint8Array.from(vr) };
}

// 한 후보 위치(지도 격자 인덱스 base = 로버 위치)의 점수: 비교 중 서로 다른 비율 (낮을수록 잘 맞음)
function scoreAt(base, T, mapCode) {
  const { n, offs, dr, vr } = T;
  let ham = 0;
  for (let t = 0; t < n; t++) ham += POPCOUNT[(mapCode[base + offs[t]] ^ dr[t]) & vr[t]]; // 빈 데이터 비교는 제외
  return ham / T.bits;
}

// ---------- 5) 서브픽셀 보정 + 신뢰도 ----------
function refine(scores, size, bx, by, resM) {
  const at = (x, y) => scores[y * size + x];
  const s0 = at(bx, by);
  const fit = (a, b) => {
    const curv = a - 2 * s0 + b;
    return curv > 0 ? Math.max(-0.5, Math.min(0.5, (a - b) / (2 * curv))) : 0;
  }; // 3점 2차 곡선의 꼭짓점
  const dx = bx > 0 && bx < size - 1 ? fit(at(bx - 1, by), at(bx + 1, by)) : 0;
  const dy = by > 0 && by < size - 1 ? fit(at(bx, by - 1), at(bx, by + 1)) : 0;

  // 유일성: 최저점 주변(8m)을 빼고 두 번째로 좋은 점수와의 차이
  let second = Infinity;
  const all = [];
  const exclude = 8 / resM;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = at(x, y);
      all.push(s);
      if (Math.hypot(x - bx, y - by) > exclude && s < second) second = s;
    }
  }
  all.sort((a, b) => a - b);
  const median = all[Math.floor(all.length / 2)];
  const uniqueness = (second - s0) / Math.max(median - s0, 1e-6);
  return { dx, dy, uniqueness, confidence: Math.max(0, Math.min(1, uniqueness * 3)) };
}

// ---------- 그리기 도우미 ----------
function putGray(ctx, w, h, get) {
  const id = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = get(i);
    if (v == null) {
      const c = ((i % w >> 2) + ((i / w) >> 2)) % 2 ? 26 : 34; // 빈 데이터: 어두운 체크무늬
      id.data.set([c, c, c + 4, 255], i * 4);
    } else {
      id.data.set([v, v, v, 255], i * 4);
    }
  }
  ctx.putImageData(id, 0, 0);
}

// 낮은 점수(좋음) = 밝은 색
const HEAT = [[0, 0, 4], [66, 10, 104], [147, 38, 103], [221, 81, 58], [252, 165, 10], [252, 255, 164]];
function heat(t) {
  const x = Math.max(0, Math.min(1, t)) * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(x));
  const f = x - i;
  return HEAT[i].map((c, k) => Math.round(c + (HEAT[i + 1][k] - c) * f));
}

function setupCanvas(cv, w, h) {
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d");
  g.imageSmoothingEnabled = false;
  return g;
}

function setStep(n) {
  locSteps.forEach((el, i) => {
    el.dataset.state = i + 1 < n ? "done" : i + 1 === n ? "active" : "";
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

// 실제 로버 사진 (Navcam 수직투영 모자이크) — 360° 를 돌며 드러남
function drawRoverPhoto(D, progress) {
  const size = 320;
  const g = setupCanvas(locSrcCanvas, size, size);
  g.imageSmoothingEnabled = true;
  g.fillStyle = "#111";
  g.fillRect(0, 0, size, size);
  g.save();
  g.beginPath();
  g.moveTo(size / 2, size / 2);
  g.arc(size / 2, size / 2, size / 2, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
  g.closePath();
  g.clip();
  g.drawImage(D.viewImg, 0, 0, size, size);
  g.restore();

  g.strokeStyle = "rgba(76, 201, 240, 0.9)";
  g.lineWidth = 2;
  if (progress < 1) {
    const a = -Math.PI / 2 + progress * Math.PI * 2;
    g.beginPath();
    g.moveTo(size / 2, size / 2);
    g.lineTo(size / 2 + (Math.cos(a) * size) / 2, size / 2 + (Math.sin(a) * size) / 2);
    g.stroke();
  }
  // 매칭에 쓰는 범위 (4~25m)
  const k = size / (2 * D.cfg.rover.radiusM);
  g.setLineDash([4, 4]);
  g.strokeStyle = "rgba(125, 249, 196, 0.8)";
  for (const r of [LOC.innerM, LOC.outerM]) {
    g.beginPath();
    g.arc(size / 2, size / 2, r * k, 0, Math.PI * 2);
    g.stroke();
  }
  g.setLineDash([]);
}

// 300m 주변 궤도 지도: 추정 위치·검색 범위, 끝나면 정답과 결과
function drawOverview(D, prior, truth, found) {
  const size = 240;
  const k = size / D.N;
  const g = setupCanvas(locOverviewCanvas, size, size);
  g.imageSmoothingEnabled = true;
  g.filter = "contrast(1.3)";
  g.drawImage(D.orbitImg, 0, 0, size, size);
  g.filter = "none";

  const px = LOC.searchM / D.cfg.resM;
  g.setLineDash([4, 4]);
  g.strokeStyle = "rgba(255, 90, 90, 0.9)";
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(prior.x * k, prior.y * k, px * k, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  cross(g, prior.x * k, prior.y * k, 5, "#ff5a5a", true);

  if (truth) {
    g.strokeStyle = "#fff";
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(truth.x * k, truth.y * k, (LOC.outerM / D.cfg.resM) * k, 0, Math.PI * 2);
    g.stroke();
  }
  if (found) cross(g, found.x * k, found.y * k, 6, "#7df9c4", false);
}

function cross(g, x, y, s, color, diagonal) {
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.beginPath();
  if (diagonal) {
    g.moveTo(x - s, y - s); g.lineTo(x + s, y + s);
    g.moveTo(x + s, y - s); g.lineTo(x - s, y + s);
  } else {
    g.moveTo(x - s, y); g.lineTo(x + s, y);
    g.moveTo(x, y - s); g.lineTo(x, y + s);
  }
  g.stroke();
}

// 검색 영역 패널: 추정 위치 주변 (검색 반경 + 관측 반경)
function drawMapPanel(g, bg, vSize, k, prior, { scanRow, best, done }) {
  g.drawImage(bg, 0, 0, vSize * k, vSize * k);
  const c = (vSize / 2) * k;
  const R = (LOC.searchM / loc.data.cfg.resM) * k;

  g.setLineDash([6, 5]);
  g.strokeStyle = "rgba(255, 90, 90, 0.9)";
  g.lineWidth = 2;
  g.beginPath();
  g.arc(c, c, R, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  cross(g, c, c, 7, "#ff5a5a", true);

  if (scanRow != null) {
    g.fillStyle = "rgba(125, 249, 196, 0.25)";
    g.fillRect(c - R, c - R + scanRow * k, 2 * R, 2);
  }
  if (best) {
    const x = c + best.x * k;
    const y = c + best.y * k;
    g.strokeStyle = done ? "#7df9c4" : "rgba(125, 249, 196, 0.7)";
    g.lineWidth = done ? 2.5 : 1.5;
    g.beginPath();
    g.arc(x, y, (LOC.outerM / loc.data.cfg.resM) * k, 0, Math.PI * 2); // 관측 범위
    g.stroke();
    cross(g, x, y, 9, g.strokeStyle, false);
    if (done) {
      g.strokeStyle = "rgba(255,255,255,0.8)";
      g.lineWidth = 1.5;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(c, c);
      g.lineTo(x, y);
      g.stroke();
      g.setLineDash([]);
    }
  }
}

// ---------- 전체 실행 ----------
async function runLocalization() {
  if (loc.running) return;
  const cfg = REGIONS[currentRegion]?.localize;
  if (!cfg) {
    locResultEl.innerHTML = `<p class="loc-result__warn">이 지역은 아직 위치 추정용 로버 사진/궤도 지도가 없어요.</p>`;
    return;
  }
  loc.running = true;
  locRetryBtn.disabled = true;
  locShowBtn.disabled = true;
  locResultEl.innerHTML = `<p class="loc-result__wait">로버 사진과 궤도 지도를 맞춰 보는 중…</p>`;
  Object.values(locCanvases).forEach((cv) => cv.getContext("2d").clearRect(0, 0, cv.width, cv.height));

  try {
    if (!loc.data || loc.data.cfg !== cfg) loc.data = await loadLocalizeData(cfg);
  } catch (e) {
    console.error(e);
    locResultEl.innerHTML = `<p class="loc-result__warn">데이터를 읽지 못했어요. Live Server 등 http 로 열어 주세요.</p>`;
    loc.running = false;
    locRetryBtn.disabled = false;
    return;
  }
  const D = loc.data;
  const N = D.N;
  const res = cfg.resM;

  // 정답(실제 로버 위치) 은 알고리즘에 주지 않음. '추정 위치' 는 정답에서 15~35m 떨어진 곳 (매번 무작위)
  const truth = lonLatToGrid(cfg, N, cfg.truth);
  const ang = Math.random() * Math.PI * 2;
  const dist = (LOC.priorMinM + Math.random() * (LOC.priorMaxM - LOC.priorMinM)) / res;
  const prior = { x: Math.round(truth.x + Math.cos(ang) * dist), y: Math.round(truth.y + Math.sin(ang) * dist) };

  // ① 실제 로버 사진
  setStep(1);
  locSrcCoord.textContent = "측정이 끝나면 공개 (정답)";
  drawOverview(D, prior, null, null);
  const t0 = performance.now();
  while (performance.now() - t0 < 1500) {
    drawRoverPhoto(D, Math.min(1, (performance.now() - t0) / 1400));
    await nextFrame();
  }
  drawRoverPhoto(D, 1);

  // ② 정사투영 → 0.5m 격자 관측 (사용 범위 4~25m) 이 안쪽부터 나타남
  setStep(2);
  const gObs = setupCanvas(locCanvases.obs, D.S, D.S);
  const half = D.S / 2;
  for (let r = LOC.innerM; r <= LOC.outerM + 2; r += 1) {
    putGray(gObs, D.S, D.S, (i) => {
      const x = (i % D.S) + 0.5 - half;
      const y = Math.floor(i / D.S) + 0.5 - half;
      return D.valid[i] && Math.hypot(x, y) * res <= r ? D.obs[i] : null;
    });
    await nextFrame();
  }
  await sleep(200);

  // ③ Census 변환 (관측 + 궤도 지도)
  setStep(3);
  const tc0 = performance.now();
  const obsC = censusTransform(D.obs, D.valid, D.S, D.S);
  const mapC = censusTransform(D.A, null, N, N);
  let computeMs = performance.now() - tc0;
  const gCen = setupCanvas(locCanvases.census, D.S, D.S);
  {
    const id = gCen.createImageData(D.S, D.S);
    for (let i = 0; i < D.S * D.S; i++) {
      if (!D.valid[i] || !obsC.vmask[i]) {
        id.data.set([24, 24, 28, 255], i * 4);
        continue;
      }
      const c = obsC.code[i];
      id.data.set([(c & 7) * 36, ((c >> 3) & 7) * 36, ((c >> 6) & 3) * 85, 255], i * 4); // 8비트 패턴을 색으로
    }
    gCen.putImageData(id, 0, 0);
  }
  await sleep(450);

  // ④ 템플릿 매칭: 추정 위치 ± 40m 를 한 줄씩 훑으며 점수 지도 채우기
  //    빠르게 하려고 1m 간격으로 먼저 훑고(거친 검색), 가장 좋은 곳 주변만 0.5m 간격으로 다시 봄(정밀 검색)
  setStep(4);
  const T = prepareTemplate(D, obsC);
  const SR = Math.round(LOC.searchM / res); // 검색 반경 (격자 칸)
  const size = 2 * SR + 1;
  const STEP = 2; // 거친 검색 간격 (칸) = 1m
  const cSize = Math.floor((size - 1) / STEP) + 1;
  const coarse = new Float32Array(cSize * cSize).fill(Infinity);
  const scoreAtGrid = (gx, gy) => scoreAt((prior.y - SR + gy) * N + (prior.x - SR + gx), T, mapC.code);

  const viewR = SR + Math.round(LOC.outerM / res);
  const vSize = 2 * viewR;
  const k = 1.5;
  const gMap = setupCanvas(locCanvases.map, vSize * k, vSize * k);
  const mapBg = document.createElement("canvas");
  {
    const g = setupCanvas(mapBg, vSize, vSize);
    g.imageSmoothingEnabled = true;
    g.filter = "contrast(1.3)";
    g.drawImage(D.orbitImg, prior.x - viewR, prior.y - viewR, vSize, vSize, 0, 0, vSize, vSize);
  }
  const gScore = setupCanvas(locCanvases.score, cSize, cSize);
  const scoreImg = gScore.createImageData(cSize, cSize);

  let cBest = { s: Infinity, x: 0, y: 0 };
  let lo = Infinity, hi = -Infinity;
  const ROWS_PER_FRAME = 2;
  for (let cy = 0; cy < cSize; cy += ROWS_PER_FRAME) {
    const ts = performance.now();
    const end = Math.min(cSize, cy + ROWS_PER_FRAME);
    for (let yy = cy; yy < end; yy++) {
      for (let xx = 0; xx < cSize; xx++) {
        const s = scoreAtGrid(xx * STEP, yy * STEP);
        coarse[yy * cSize + xx] = s;
        if (s < cBest.s) cBest = { s, x: xx, y: yy };
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
    }
    computeMs += performance.now() - ts;

    for (let i = 0; i < end * cSize; i++) {
      const [r, g, b] = heat(1 - (coarse[i] - lo) / Math.max(hi - lo, 1e-6));
      scoreImg.data.set([r, g, b, 255], i * 4);
    }
    gScore.putImageData(scoreImg, 0, 0);
    drawMapPanel(gMap, mapBg, vSize, k, prior, { scanRow: end * STEP, best: { x: cBest.x * STEP - SR, y: cBest.y * STEP - SR } });
    await nextFrame();
  }

  // 정밀 검색: 거친 최저점 주변 ±3칸(±1.5m) 을 0.5m 간격으로
  const tf = performance.now();
  const F = 3;
  const fSize = 2 * F + 1;
  const fine = new Float32Array(fSize * fSize);
  let best = { s: Infinity, x: 0, y: 0 };
  for (let fy = 0; fy < fSize; fy++) {
    for (let fx = 0; fx < fSize; fx++) {
      const gx = Math.max(0, Math.min(size - 1, cBest.x * STEP + fx - F));
      const gy = Math.max(0, Math.min(size - 1, cBest.y * STEP + fy - F));
      const s = scoreAtGrid(gx, gy);
      fine[fy * fSize + fx] = s;
      if (s < best.s) best = { s, x: gx, y: gy, fx, fy };
    }
  }
  computeMs += performance.now() - tf;

  // ⑤ 서브픽셀 보정 (정밀 격자) + 신뢰도 (거친 격자의 유일성)
  setStep(5);
  const sub = refine(fine, fSize, best.fx, best.fy, res);
  const uniq = refine(coarse, cSize, cBest.x, cBest.y, res * STEP);
  const ref = { dx: sub.dx, dy: sub.dy, confidence: uniq.confidence };
  const foundGrid = { x: prior.x - SR + best.x + ref.dx, y: prior.y - SR + best.y + ref.dy };
  const found = gridToLonLat(cfg, N, foundGrid.x, foundGrid.y);
  const errM = Math.hypot(foundGrid.x - truth.x, foundGrid.y - truth.y) * res;
  const moveE = (foundGrid.x - prior.x) * res;
  const moveN = -(foundGrid.y - prior.y) * res;

  gScore.strokeStyle = "#7df9c4";
  gScore.lineWidth = 1;
  gScore.strokeRect(cBest.x - 2.5, cBest.y - 2.5, 5, 5);
  drawMapPanel(gMap, mapBg, vSize, k, prior, { best: { x: best.x - SR + ref.dx, y: best.y - SR + ref.dy }, done: true });
  const candidates = cSize * cSize + fSize * fSize;

  // 정답 공개
  locSrcCoord.textContent = `${formatLonLat(cfg.truth)} (sol 36 실제 로버 위치)`;
  drawOverview(D, prior, truth, foundGrid);

  loc.result = { found, errM };
  setStep(6);
  const confPct = Math.round(ref.confidence * 100);
  const confCls = confPct >= 60 ? "high" : confPct >= 30 ? "mid" : "low";
  const confLabel = confPct >= 60 ? "높음" : confPct >= 30 ? "보통" : "낮음";
  const dirText = `${moveE >= 0 ? "동" : "서"}쪽 ${Math.abs(moveE).toFixed(1)}m, ${moveN >= 0 ? "북" : "남"}쪽 ${Math.abs(moveN).toFixed(1)}m`;
  locResultEl.innerHTML = `
    <div class="loc-result__main">
      <span class="loc-result__label">추정 현재 위치</span>
      <strong>${formatLonLat(found)}</strong>
    </div>
    <dl class="loc-result__stats">
      <div><dt>위치 보정</dt><dd>${dirText}</dd></div>
      <div><dt>신뢰도</dt><dd class="is-${confCls}">${confLabel} (${confPct}%)</dd></div>
      <div><dt>매칭 점수</dt><dd>${best.s.toFixed(3)} · 비교 ${T.n.toLocaleString()}px</dd></div>
      <div><dt>계산 시간</dt><dd>${Math.round(computeMs)} ms · 후보 ${candidates.toLocaleString()}곳</dd></div>
    </dl>
    <p class="loc-result__sim">실제 로버 위치(궤도 사진의 Spirit 착륙선으로 확인)와의 오차 <b>${errM.toFixed(2)} m</b></p>`;

  applyLocalization(found);
  loc.running = false;
  locRetryBtn.disabled = false;
  locShowBtn.disabled = false;
}

// ---------- 결과 반영: 현위치 갱신 + 지도에 고해상도 궤도 사진 ----------
function applyLocalization(found) {
  const region = REGIONS[currentRegion];
  region.currentPosition = { lon: found.lon, lat: found.lat };
  if (typeof renderNavMap === "function") renderNavMap();
  locPatchEl.src = region.localize.orbit;
  locPatchEl.dataset.ready = "1";
  positionLocPatch();
}

// 2D 지도 위에 위치 추정에 쓴 고해상도 궤도 사진을 겹쳐 보여줌 (확대하면 선명)
function positionLocPatch() {
  if (!locPatchEl) return;
  const cfg = REGIONS[currentRegion]?.localize;
  const show = locPatchEl.dataset.ready === "1" && !!cfg;
  locPatchEl.style.display = show ? "block" : "none";
  if (!show) return;
  const b = cfg.orbitBounds;
  const tl = lonLatToImage(b.lonMin, b.latMax);
  const br = lonLatToImage(b.lonMax, b.latMin);
  locPatchEl.style.transform = `translate(${view.x + tl.x * view.scale}px, ${view.y + tl.y * view.scale}px)`;
  locPatchEl.style.width = `${(br.x - tl.x) * view.scale}px`;
  locPatchEl.style.height = `${(br.y - tl.y) * view.scale}px`;
}

// ---------- 열기 / 닫기 / 지도에서 보기 ----------
locBtn.addEventListener("click", () => {
  if (locDialog.open) return;
  setDrawerOpen(false);
  locDialog.showModal();
  runLocalization();
});
locRetryBtn.addEventListener("click", runLocalization);
locCloseBtn.addEventListener("click", () => locDialog.close());
locDialog.addEventListener("cancel", (e) => {
  if (loc.running) e.preventDefault(); // 계산 중에는 닫지 않음
});

locShowBtn.addEventListener("click", () => {
  locDialog.close();
  const here = loc.result?.found;
  if (!here) return;

  if (typeof globe !== "undefined" && globe.on && viewer) {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(here.lon, here.lat - 0.004, 900, Cesium.Ellipsoid.MARS),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
      duration: 2,
    });
    return;
  }
  // 2D: 찾은 위치를 가운데에, 주변 약 150m 가 보이게 확대
  const { x, y } = lonLatToImage(here.lon, here.lat);
  const pxPerM = mapImage.naturalWidth / REGIONS.gusev.widthM;
  const scale = Math.min(mapEl.clientWidth, mapEl.clientHeight) / (150 * pxPerM);
  view.maxScale = Math.max(view.maxScale, scale * 2);
  flyMapTo({ cx: x, cy: y, scale }, 1600);
});
