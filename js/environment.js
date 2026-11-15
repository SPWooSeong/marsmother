// Mars Mother — 환경 필드: 그림자 · 통신 가시성 · 방사선 지형 차폐 · 귀환 시간/한계
// 그림자 · 거칠기 · 경사 한계는 길찾기 비용에만 쓰고 (레이어로는 안 보임), 레이어는 귀환 한계 · 통신 가시 범위 둘만
// 모두 HiRISE 30 m 격자(js/survey.js 의 "지금 아는 지형") 위에서 계산. 길찾기(route.js)와 레이어(layers.js)가 같이 씀
//
//  그림자      시계 시각의 태양 고도 · 방위(marstime.js sunPosition)로 지형 그림자를 광선 추적
//  통신 가시성  기지(포인트 종류 "기지") 안테나에서 직선으로 보이는 곳 (지형 + 화성 곡률). 기지가 없으면 계산 안 함
//  방사선 차폐  움푹한 곳은 하늘이 덜 보여 은하 우주선을 조금 덜 받음 (주변 180 m 평균보다 낮은 만큼, 최대 −20% 로 근사)
//  귀환 시간    각 칸에서 안전한 곳(출발지 · 기지)까지 걸어서 돌아오는 가장 빠른 시간
//  귀환 한계    기준점에서 다녀오는 데 드는 산소 · 시간이 (안전 여유를 뺀) 예산을 넘는 선
//  절대 장애물  경사 ABSOLUTE_SLOPE_DEG 이상 — 설정과 상관없이 통행 불가
//
// 필요: survey.js / marstime.js / eva.js / profile.js / main.js (getBases, getCurrentPosition 은 route.js)

const COMM_ANTENNA_M = 12; // 기지 통신 마스트 높이
const COMM_PERSON_M = 1.7; // 우주복 안테나 높이
const COMM_CLEARANCE_M = 4; // UHF 전파는 낮은 둔덕은 넘어감 (회절) — 이만큼 가려도 통신된다고 봄
const ENV_MARS_R = 3396190;

const env = {
  shadow: { key: null, map: null, night: false, sun: null },
  shadowCache: new Map(),
  comm: { key: null, vis: null, count: 0 },
  rad: { rate: null, min: 0 },
  ret: { key: null, frac: null, busy: false, info: null },
  canvases: {},
};

function envCellOf(p) {
  const s = survey;
  const [fx, fy] = surveyFxFy(p.lon, p.lat);
  const x = Math.round(fx), y = Math.round(fy);
  return x < 0 || y < 0 || x >= s.w || y >= s.h ? -1 : y * s.w + x;
}

// ---------- 그림자 ----------
// date 시각의 그림자 지도 (1 = 그늘). 해가 졌으면 전부 1
function envShadowMap(date) {
  const s = survey;
  const key = `${Math.floor(date.getTime() / 600000)}|${s.version}`; // 10분 단위
  if (env.shadow.key === key) return env.shadow;
  // 경로 통계는 시각별 그림자를 여러 장 씀 → 최근 것 몇 장은 기억해 둠
  if (env.shadowCache.has(key)) return (env.shadow = env.shadowCache.get(key));
  const { w, h, z, dx, dy, b } = s;
  const sun = sunPosition(date, (b.lonMin + b.lonMax) / 2, (b.latMin + b.latMax) / 2);
  const map = new Uint8Array(w * h);
  const night = sun.elevationDeg <= 0.5;
  if (night) map.fill(1);
  else {
    const horiz = Math.hypot(sun.east, sun.north);
    const tanEl = sun.up / horiz;
    // 태양 쪽으로 한 걸음: 격자에서 큰 쪽 성분이 1칸
    let sx = sun.east / horiz / dx, sy = -sun.north / horiz / dy; // 칸/m
    const norm = Math.max(Math.abs(sx), Math.abs(sy));
    const stepM = 1 / norm; // 한 걸음의 수평 거리
    sx /= norm;
    sy /= norm;
    let zMax = -Infinity;
    for (let i = 0; i < z.length; i++) if (z[i] > zMax) zMax = z[i];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const z0 = z[y * w + x] + 1.2; // 사람 가슴 높이
        const maxSteps = Math.min(400, Math.ceil((zMax - z0) / tanEl / stepM));
        let k = 1;
        while (k <= maxSteps) {
          const px = Math.round(x + sx * k), py = Math.round(y + sy * k);
          if (px < 0 || py < 0 || px >= w || py >= h) break;
          if (z[py * w + px] > z0 + k * stepM * tanEl) {
            map[y * w + x] = 1;
            break;
          }
          k += k < 12 ? 1 : Math.ceil(k * 0.12); // 멀수록 성기게
        }
      }
    }
  }
  env.shadow = { key, map, night, sun };
  env.shadowCache.set(key, env.shadow);
  if (env.shadowCache.size > 40) env.shadowCache.delete(env.shadowCache.keys().next().value);
  return env.shadow;
}

// ---------- 통신 가시성 ----------
// 기지에서 보이는 칸 (1 = 통신 가능). 기지가 없으면 null
function envCommMap() {
  const s = survey;
  const bases = typeof getBases === "function" ? getBases() : [];
  const key = `${bases.map((p) => `${p.lon},${p.lat}`).join(";")}|${s.version}`;
  if (env.comm.key === key) return env.comm.vis;
  env.comm.key = key;
  env.comm.count = bases.length;
  if (!bases.length) return (env.comm.vis = null);
  const { w, h, z, dx, dy } = s;
  const vis = new Uint8Array(w * h);
  for (const base of bases) {
    const c = envCellOf(base);
    if (c === -1) continue;
    const bx = c % w, by = (c - bx) / w;
    const zb = z[c] + COMM_ANTENNA_M;
    vis[c] = 1;
    // 기지에서 사방으로 광선을 쏘며, 그때까지 가장 높았던 지형 각도보다 위에 있는 칸만 보임
    const rMax = Math.hypot(Math.max(bx, w - bx), Math.max(by, h - by));
    const rays = Math.ceil(2 * Math.PI * rMax * 1.3);
    for (let r = 0; r < rays; r++) {
      const a = (r / rays) * 2 * Math.PI;
      const ux = Math.cos(a), uy = Math.sin(a);
      const mPerStep = Math.hypot(ux * dx, uy * dy);
      let maxTan = -Infinity;
      for (let k = 1; k < rMax; k++) {
        const x = Math.round(bx + ux * k), y = Math.round(by + uy * k);
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        const d = k * mPerStep;
        const i = y * w + x;
        const ground = z[i] - (d * d) / (2 * ENV_MARS_R) - zb; // 곡률만큼 내려감
        if ((ground + COMM_PERSON_M + COMM_CLEARANCE_M) / d >= maxTan) vis[i] = 1;
        const t = ground / d;
        if (t > maxTan) maxTan = t;
      }
    }
  }
  return (env.comm.vis = vis);
}

// ---------- 방사선: 고도 + 지형 차폐 ----------
// 칸마다 시간 계수 1 일 때의 선량률 (mSv/일). 기존 DEM 기준으로 한 번만 계산
function envRadRate() {
  if (env.rad.rate) return env.rad;
  const { w, h, priorZ: z } = survey;
  const rate = new Float32Array(w * h);
  const R = 6; // 180 m
  let min = Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let sum = 0, n = 0;
      for (const [ox, oy] of [[R, 0], [-R, 0], [0, R], [0, -R], [4, 4], [-4, 4], [4, -4], [-4, -4]]) {
        const nx = x + ox, ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        sum += z[ny * w + nx];
        n++;
      }
      const depth = n ? sum / n - z[i] : 0; // 주변보다 낮은 정도 (m)
      const shield = 1 - 0.2 * Math.max(0, Math.min(1, depth / 40));
      rate[i] = radiationBase(z[i]) * shield;
      if (rate[i] < min) min = rate[i];
    }
  }
  env.rad = { rate, min };
  return env.rad;
}

// ---------- 걸어서 가는 비용 지도 (Dijkstra, 8방향) ----------
// sources: 칸 번호들. reverse = true 면 "각 칸 → source" 방향 비용 (돌아오는 길)
// by: "time"(초) 또는 "energy"(J) 를 최소화. 둘 다 돌려줌. limit 을 넘는 칸은 Infinity
const ENV_NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
function envWalkField(sources, { reverse = false, by = "time", limit = Infinity, maxSlopeDeg = PROFILE.slopeLimitDeg } = {}) {
  const { w, h, z, slope, eta, dx, dy } = survey;
  const N = w * h;
  const cost = new Float32Array(N).fill(Infinity);
  const time = new Float32Array(N).fill(Infinity);
  const energy = new Float32Array(N).fill(Infinity);
  const heap = new KeyHeap();
  for (const c of sources) {
    if (c < 0) continue;
    cost[c] = time[c] = energy[c] = 0;
    heap.push(0, 0, c);
  }
  const lens = ENV_NEIGHBORS.map(([ox, oy]) => Math.hypot(ox * dx, oy * dy));
  while (heap.size) {
    const u = heap.pop();
    if (heap.lastK1 > cost[u]) continue;
    const x = u % w, y = (u - x) / w;
    for (let k = 0; k < 8; k++) {
      const nx = x + ENV_NEIGHBORS[k][0], ny = y + ENV_NEIGHBORS[k][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const v = ny * w + nx;
      if (slope[v] > maxSlopeDeg) continue;
      // 실제로 걷는 방향: reverse 면 v → u
      const rise = reverse ? z[u] - z[v] : z[v] - z[u];
      const grade = rise / lens[k];
      const e = (eta[u] + eta[v]) / 2;
      const sp = evaSpeed(grade, e);
      const t = Math.hypot(lens[k], rise) / sp;
      const j = evaMetabolicW(sp, grade, e) * t;
      const c = cost[u] + (by === "time" ? t : j);
      if (c < cost[v] && c <= limit) {
        cost[v] = c;
        time[v] = time[u] + t;
        energy[v] = energy[u] + j;
        heap.push(c, 0, v);
      }
    }
  }
  return { cost, time, energy };
}

// ---------- 귀환 한계 ----------
// 기준점: 현위치에서 가장 가까운 기지, 없으면 현위치
function envReturnOrigin() {
  const here = typeof getCurrentPosition === "function" ? getCurrentPosition() : null;
  const bases = typeof getBases === "function" ? getBases() : [];
  if (!bases.length) return here ? { ...here, name: "현위치", isBase: false } : null;
  const ref = here || bases[0];
  let best = bases[0], bestD = Infinity;
  for (const p of bases) {
    const d = Math.hypot((p.lon - ref.lon) * Math.cos((ref.lat * Math.PI) / 180), p.lat - ref.lat);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return { lon: best.lon, lat: best.lat, name: best.name, isBase: true };
}

// 예산: 산소(여유 제외) · 활동 시간(여유 제외) · 일몰까지 남은 시간 중 먼저 닿는 것
function envBudget(date, lonLat) {
  const sun = sunTimes(date, lonLat.lon, lonLat.lat);
  const o2J = profileUsableO2L() * EVA.o2KjPerL * 1000;
  const evaS = profileUsableHours() * 3600;
  const sunsetS = sun.isDay ? sun.msToSunset / 1000 : Infinity; // 밤에 나가면 일몰 제한은 따로 경고만
  return { o2J, evaS, sunsetS, timeS: Math.min(evaS, sunsetS), sun };
}

// 칸마다 "기준점에서 다녀오는 데 예산의 몇 배가 드는지" (1 넘으면 귀환 불가). 계산은 한 박자 뒤에 (화면이 먼저 뜨게)
function envReturnLimit(onReady) {
  const origin = envReturnOrigin();
  if (!origin || !survey.loaded) return null;
  const date = marsClock.now();
  const key = [
    origin.lon.toFixed(5), origin.lat.toFixed(5), survey.version,
    PROFILE.o2TankL, PROFILE.evaMaxHours, PROFILE.marginPct, PROFILE.slopeLimitDeg, PROFILE.bodyKg, PROFILE.walkKmh,
    Math.floor(date.getTime() / 900000), // 15분 단위 (일몰까지 남은 시간)
  ].join("|");
  if (env.ret.key === key) return env.ret;
  if (env.ret.busy) return env.ret.frac ? env.ret : null;
  env.ret.busy = true;
  setTimeout(() => {
    const c = envCellOf(origin);
    const budget = envBudget(date, origin);
    if (c !== -1) {
      // 가는 길 · 오는 길 각각 예산의 65% 까지만 탐색 (그 너머는 어차피 왕복 불가)
      const out = envWalkField([c], { by: "energy", limit: budget.o2J * 0.65 });
      const back = envWalkField([c], { by: "energy", reverse: true, limit: budget.o2J * 0.65 });
      const frac = new Float32Array(out.cost.length);
      let reachKm2 = 0, maxM = 0;
      const { w, dx, dy } = survey;
      const cx = c % w, cy = (c - cx) / w;
      for (let i = 0; i < frac.length; i++) {
        const o2 = (out.energy[i] + back.energy[i]) / budget.o2J;
        const t = (out.time[i] + back.time[i]) / budget.timeS;
        frac[i] = Math.max(o2, t); // Infinity 면 못 감
        if (frac[i] <= 1) {
          reachKm2 += (dx * dy) / 1e6;
          const x = i % w;
          const d = Math.hypot((x - cx) * dx, ((i - x) / w - cy) * dy);
          if (d > maxM) maxM = d;
        }
      }
      env.ret = { key, frac, busy: false, info: { origin, budget, reachKm2, maxM } };
    } else env.ret = { key, frac: null, busy: false, info: { origin, budget, outside: true } };
    if (onReady) onReady();
    document.dispatchEvent(new CustomEvent("envreturnchange"));
  }, 30);
  return env.ret.frac ? env.ret : null;
}

// ---------- 레이어 캔버스 ----------
function envCanvas(id) {
  if (!env.canvases[id]) {
    const c = document.createElement("canvas");
    c.width = survey.w;
    c.height = survey.h;
    env.canvases[id] = { canvas: c, key: null };
  }
  return env.canvases[id];
}

// paint(i, px, o): 칸 i 의 색을 px[o..o+3] 에 씀
function envPaint(id, key, paint) {
  if (!survey.loaded) {
    loadSurvey().then(() => scheduleScienceLayers(), () => {});
    return null;
  }
  const m = envCanvas(id);
  if (m.key !== key) {
    const g = m.canvas.getContext("2d");
    const img = g.createImageData(m.canvas.width, m.canvas.height);
    const px = img.data;
    for (let i = 0, o = 0; o < px.length; i++, o += 4) paint(i, px, o);
    g.putImageData(img, 0, 0);
    m.key = key;
  }
  return m.canvas;
}

function renderCommCanvas() {
  if (!survey.loaded) return envPaint("comm", "", () => {});
  const vis = envCommMap();
  if (!vis) return null;
  const w = survey.w;
  return envPaint("comm", env.comm.key, (i, px, o) => {
    if (vis[i]) {
      px[o] = 94;
      px[o + 1] = 234;
      px[o + 2] = 212;
      px[o + 3] = 40;
      return;
    }
    // 통신 음영: 빗금
    const x = i % w, y = (i - x) / w;
    const stripe = (x + y) % 4 < 2;
    px[o] = 255;
    px[o + 1] = 60;
    px[o + 2] = 170;
    px[o + 3] = stripe ? 95 : 0;
  });
}

const RETURN_COLORS = [
  { upTo: 0.5, rgb: [61, 220, 151], a: 70, label: "여유 (예산의 50% 이내)" },
  { upTo: 0.8, rgb: [255, 216, 77], a: 95, label: "주의 (50~80%)" },
  { upTo: 1.0, rgb: [255, 140, 40], a: 125, label: "한계 근처 (80~100%)" },
  { upTo: Infinity, rgb: [150, 20, 30], a: 150, label: "귀환 불가 — 이 선을 넘으면 돌아오기 어려움" },
];
function renderReturnCanvas() {
  if (!survey.loaded) return envPaint("return", "", () => {});
  const ret = envReturnLimit(() => scheduleScienceLayers());
  if (!ret || !ret.frac) return null;
  const f = ret.frac;
  return envPaint("return", ret.key, (i, px, o) => {
    const band = RETURN_COLORS.find((c) => f[i] <= c.upTo) || RETURN_COLORS[3];
    px[o] = band.rgb[0];
    px[o + 1] = band.rgb[1];
    px[o + 2] = band.rgb[2];
    px[o + 3] = band.a;
  });
}

// 길찾기용: 출발 시각 기준 환경 필드 묶음
//  shadow 는 출발 1시간 뒤 태양 위치 기준 (경로 계산 중에는 시간에 따라 바꾸지 않음 — 결과 통계에서는 시각별로 다시 계산)
function envForRoute(startDate, safeCells, spanS) {
  const rad = envRadRate();
  const shadow = envShadowMap(new Date(startDate.getTime() + 3600e3));
  const comm = envCommMap();
  // 안전한 곳(출발지 · 기지)까지 돌아오는 시간. 경로가 닿을 만한 범위까지만 계산하고 그 밖은 상한값
  const capS = Math.max(1800, spanS * 1.5);
  const ret = envWalkField(safeCells, { reverse: true, by: "time", limit: capS }).time;
  for (let i = 0; i < ret.length; i++) if (ret[i] === Infinity) ret[i] = capS;
  return { radRate: rad.rate, radMin: rad.min, shadow: shadow.map, night: shadow.night, comm, ret, retCapS: capS };
}

// 시각 · 기지 · 프로필이 바뀌면 켜져 있는 레이어를 다시 그림
for (const name of ["pointschange", "profilechange", "positionchange"]) {
  document.addEventListener(name, () => typeof scheduleScienceLayers === "function" && scheduleScienceLayers());
}
marsClock.onChange(() => typeof scheduleScienceLayers === "function" && scheduleScienceLayers());
