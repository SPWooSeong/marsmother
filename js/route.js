// Mars Mother - 길찾기 (실제 지형 기반)
// 출발지 → 경유지 → 도착지 사이를 실제 DEM 위에서 A* 로 탐색.
//  - 지형: HiRISE DEM 30 m 격자 (Columbia Hills 30 km 전체) · 경사는 이웃 칸 높이 차로 계산
//  - 지표: TES 열관성으로 추정한 모래 빠짐 위험 (무른 땅일수록 느리고 힘듦)
//  - 시간 · 에너지 · 산소 · 냉각수: js/eva.js 의 보행 모델
//  - 방사선: 오른쪽 위 시계의 시각부터 걸으면서 받는 양 (js/marstime.js 모델, 고도 · 계절 · 시각 반영)
//
// main.js 의 전역 값/함수를 사용: mapEl, view, applyView, positionPins, lonLatToImage,
// formatLonLat, setDrawerOpen, drawer, startMapPick, REGIONS, currentRegion
// dem.js: loadDemGrid, demElevation / eva.js / marstime.js: marsClock, radiationFactors, radiationBase

// ---------- 설정 ----------
const MARS_RADIUS_M = 3396190;
const DEG_TO_M = (Math.PI * MARS_RADIUS_M) / 180;
const MAX_WAYPOINTS = 3;

// 경로 종류 = A* 의 비용 기준
//  cost(edge) → 그 칸으로 가는 비용. maxSlope 보다 가파른 칸은 못 지나감
const ROUTE_OPTIONS = [
  {
    id: "safe",
    name: "안전한 길",
    desc: "경사 15° 미만 · 모래 지대와 비탈 피함",
    color: "#4c8dff",
    maxSlopeDeg: 15,
    // 걸리는 시간 × 위험 가중치 (8° 넘는 비탈, 모래 빠짐 위험)
    cost: (e) => e.timeS * (1 + Math.max(0, e.slopeDeg - 8) * 0.5 + (e.eta - 1.1) * 4),
  },
  {
    id: "shortest",
    name: "최단 거리",
    desc: "가장 짧은 길 · 경사 25° 까지 감수",
    color: "#7ed957",
    maxSlopeDeg: 25,
    cost: (e) => e.distM,
  },
  {
    id: "energy",
    name: "체력 아끼는 길",
    desc: "산소 · 체력 소모가 가장 적은 길",
    color: "#ffd84d",
    maxSlopeDeg: 25,
    cost: (e) => e.energyJ,
  },
];

// ---------- 상태 ----------
const nav = {
  stops: [
    { kind: "start", lonLat: null },
    { kind: "end", lonLat: null },
  ],
  results: [],
  selectedId: null,
};

const routeStopsEl = document.getElementById("route-stops");
const routeAddStopBtn = document.getElementById("route-add-stop");
const routeSwapBtn = document.getElementById("route-swap");
const routeResetBtn = document.getElementById("route-reset");
const routeFindBtn = document.getElementById("route-find");
const routeMsg = document.getElementById("route-msg");
const routeResultsEl = document.getElementById("route-results");
const navRoutesSvg = document.getElementById("nav-routes");
const navPinsEl = document.getElementById("nav-pins");

// ---------- 좌표 입력 ----------
// "14.57S, 175.47E" / "-14.57, 175.47" (위도, 경도 순) 형식 지원
function parseLonLat(text) {
  const m = text
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])?$/);
  if (!m) return null;

  let lat = parseFloat(m[1]);
  if (m[2] && m[2].toUpperCase() === "S") lat = -Math.abs(lat);
  let lon = parseFloat(m[3]);
  if (m[4] && m[4].toUpperCase() === "W") lon = -Math.abs(lon);

  if (Math.abs(lat) > 90 || lon < -180 || lon > 360) return null;
  return { lon, lat };
}

function isInsideRegion({ lon, lat }) {
  const b = REGIONS[currentRegion]?.bounds;
  return !!b && lon >= b.lonMin && lon <= b.lonMax && lat >= b.latMin && lat <= b.latMax;
}

function stopLabel(stop, index) {
  if (stop.kind === "start") return "출발지";
  if (stop.kind === "end") return "도착지";
  return `경유지 ${index}`;
}

function setRouteMsg(text, isError = false) {
  routeMsg.textContent = text;
  routeMsg.classList.toggle("is-error", isError);
}

// ---------- 현위치 ----------
// 화성에는 GPS가 없으므로 데모에서는 지역별로 정해 둔 위치를 현위치로 사용
function getCurrentPosition() {
  return REGIONS[currentRegion]?.currentPosition || null;
}

// 지도에서 위치 고르기 (기존 포인트 핀을 누르면 그 포인트로 지정됨)
function pickStopOnMap(stop, label) {
  setDrawerOpen(false);
  startMapPick(
    `${label} 위치를 지도에서 클릭하세요 (기존 핀을 눌러도 돼요)`,
    (lonLat, point) => {
      setStop(stop, lonLat, point ? point.name : null);
      setDrawerOpen(true);
    },
    () => setDrawerOpen(true)
  );
}

function setStop(stop, lonLat, name = null) {
  stop.lonLat = lonLat;
  stop.name = name;
  setRouteMsg(isInsideRegion(lonLat) ? "" : "⚠️ 현재 지도 범위 밖의 좌표예요.", !isInsideRegion(lonLat));
  onStopsChanged();
}

function stopDisplayValue(stop) {
  if (!stop.lonLat) return "";
  const coords = formatLonLat(stop.lonLat);
  return stop.name ? `${stop.name} · ${coords}` : coords;
}

// ---------- 입력창 아래 추천 목록 (현위치 / 지도에서 선택 / 기존 포인트) ----------
let suggestIndex = null; // 추천 목록이 열린 입력 줄 번호

function suggestionItems(stop, label, filterText) {
  const items = [];
  const here = getCurrentPosition();
  const q = filterText.trim().toLowerCase();

  if (here) {
    items.push({ icon: "◎", text: "현위치", sub: formatLonLat(here), cls: "is-here", run: () => setStop(stop, here, "현위치") });
  }
  items.push({ icon: "📍", text: "지도에서 선택", sub: "지도를 클릭하거나 핀을 선택", run: () => pickStopOnMap(stop, label) });

  // 기존 포인트 (경로처럼 한 점이 아닌 것은 제외)
  const points = getPoints().filter((p) => p.lon != null && p.lat != null);
  for (const p of points) {
    if (q && !p.name.toLowerCase().includes(q)) continue;
    const type = POINT_TYPES[p.type] || POINT_TYPES.custom;
    items.push({
      icon: "●",
      color: type.color,
      text: p.name,
      sub: type.label,
      run: () => setStop(stop, { lon: p.lon, lat: p.lat }, p.name),
    });
  }
  return items;
}

function renderSuggestions(li, stop, label, filterText) {
  li.querySelector(".route-suggest")?.remove();
  const ul = document.createElement("ul");
  ul.className = "route-suggest";
  ul.setAttribute("role", "listbox");

  for (const item of suggestionItems(stop, label, filterText)) {
    const opt = document.createElement("li");
    opt.className = `route-suggest__item ${item.cls || ""}`;
    opt.setAttribute("role", "option");
    if (item.color) opt.style.setProperty("--pin-color", item.color);

    const icon = document.createElement("span");
    icon.className = "route-suggest__icon";
    icon.textContent = item.icon;
    const text = document.createElement("span");
    text.className = "route-suggest__text";
    text.textContent = item.text;
    const sub = document.createElement("span");
    sub.className = "route-suggest__sub";
    sub.textContent = item.sub;
    opt.append(icon, text, sub);

    // 입력창 포커스가 먼저 빠지지 않도록 pointerdown 에서 처리
    opt.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      suggestIndex = null;
      item.run();
    });
    ul.append(opt);
  }
  li.append(ul);
}

function closeSuggestions() {
  suggestIndex = null;
  routeStopsEl.querySelectorAll(".route-suggest").forEach((el) => el.remove());
}

document.addEventListener("pointerdown", (e) => {
  if (suggestIndex !== null && !e.target.closest(".route-stop")) closeSuggestions();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSuggestions();
});

// 출발/경유/도착 입력 줄 그리기
function renderStops() {
  suggestIndex = null;
  routeStopsEl.replaceChildren();

  nav.stops.forEach((stop, i) => {
    const label = stopLabel(stop, i);
    const li = document.createElement("li");
    li.className = `route-stop is-${stop.kind}`;

    const dot = document.createElement("span");
    dot.className = "route-stop__dot";
    dot.textContent = stop.kind === "start" ? "출" : stop.kind === "end" ? "도" : i;

    const name = document.createElement("span");
    name.className = "route-stop__label";
    name.textContent = label;

    const input = document.createElement("input");
    input.className = "route-stop__input";
    input.type = "text";
    input.placeholder = "현위치 · 포인트 · 좌표 입력";
    input.title = "좌표 예: 14.57S, 175.47E";
    input.value = stopDisplayValue(stop);
    input.setAttribute("aria-label", `${label}`);
    input.setAttribute("autocomplete", "off");

    // 포커스하면 추천 목록 열기, 글자를 치면 포인트 이름으로 거르기
    input.addEventListener("focus", () => {
      suggestIndex = i;
      input.select();
      renderSuggestions(li, stop, label, "");
    });
    input.addEventListener("input", () => {
      suggestIndex = i;
      renderSuggestions(li, stop, label, input.value);
    });

    // 직접 입력한 좌표 처리
    input.addEventListener("change", () => {
      if (!input.value.trim()) {
        stop.lonLat = null;
        stop.name = null;
        input.classList.remove("is-invalid");
        onStopsChanged();
        return;
      }
      if (input.value === stopDisplayValue(stop)) return;

      const lonLat = parseLonLat(input.value.split(" · ").pop());
      if (!lonLat) {
        input.classList.add("is-invalid");
        setRouteMsg("좌표 형식을 확인하거나 목록에서 선택하세요. 예: 14.57S, 175.47E", true);
        return;
      }
      setStop(stop, lonLat, null);
    });

    const pick = document.createElement("button");
    pick.className = "route-stop__btn";
    pick.textContent = "📍";
    pick.setAttribute("aria-label", `${label} 지도에서 선택`);
    pick.addEventListener("click", () => pickStopOnMap(stop, label));

    li.append(dot, name, input, pick);

    if (stop.kind === "via") {
      const remove = document.createElement("button");
      remove.className = "route-stop__btn";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `${label} 삭제`);
      remove.addEventListener("click", () => {
        nav.stops.splice(i, 1);
        onStopsChanged();
      });
      li.append(remove);
    }

    routeStopsEl.append(li);
  });

  routeAddStopBtn.disabled = nav.stops.length - 2 >= MAX_WAYPOINTS;
}

// 입력이 바뀌면 이전 결과는 지우고 다시 그림
function onStopsChanged() {
  nav.results = [];
  nav.selectedId = null;
  renderStops();
  renderResults();
  renderNavMap();
}

routeAddStopBtn.addEventListener("click", () => {
  nav.stops.splice(nav.stops.length - 1, 0, { kind: "via", lonLat: null });
  onStopsChanged();
});

routeSwapBtn.addEventListener("click", () => {
  nav.stops.reverse();
  nav.stops.forEach((s, i) => {
    s.kind = i === 0 ? "start" : i === nav.stops.length - 1 ? "end" : "via";
  });
  onStopsChanged();
});

function resetRoute() {
  nav.stops = [
    { kind: "start", lonLat: null },
    { kind: "end", lonLat: null },
  ];
  setRouteMsg("");
  onStopsChanged();
}

routeResetBtn.addEventListener("click", resetRoute);
document.addEventListener("regionchange", resetRoute);

// ---------- 실제 길찾기 (A*) ----------
function distanceM(a, b) {
  const cos = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lon - a.lon) * cos * DEG_TO_M, (b.lat - a.lat) * DEG_TO_M);
}

// 탐색용 격자: HiRISE 30 m DEM + 칸마다 경사 · 지면 계수 (처음 한 번 만듦)
let routeGridPromise = null;
function loadRouteGrid() {
  if (!routeGridPromise) {
    routeGridPromise = loadDemGrid("hirise").then((dem) => {
      const { w, h, values: z, bounds: b } = dem;
      const lat0 = (b.latMin + b.latMax) / 2;
      const dx = ((b.lonMax - b.lonMin) / (w - 1)) * DEG_TO_M * Math.cos((lat0 * Math.PI) / 180);
      const dy = ((b.latMax - b.latMin) / (h - 1)) * DEG_TO_M;
      // 칸의 경사 (°)
      const slope = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const gx = (z[y * w + Math.min(w - 1, x + 1)] - z[y * w + Math.max(0, x - 1)]) / (2 * dx);
          const gy = (z[Math.max(0, y - 1) * w + x] - z[Math.min(h - 1, y + 1) * w + x]) / (2 * dy);
          slope[y * w + x] = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
        }
      }
      // 지면 계수: 열관성 해상도(약 7 km)가 낮아 32×32 칸 묶음으로 계산
      const eta = new Float32Array(w * h);
      const B = 32;
      for (let by = 0; by < h; by += B) {
        for (let bx = 0; bx < w; bx += B) {
          const cx = Math.min(w - 1, bx + B / 2);
          const cy = Math.min(h - 1, by + B / 2);
          const v = terrainEta(b.lonMin + (cx / (w - 1)) * (b.lonMax - b.lonMin), b.latMax - (cy / (h - 1)) * (b.latMax - b.latMin));
          for (let y = by; y < Math.min(h, by + B); y++) eta.fill(v, y * w + bx, y * w + Math.min(w, bx + B));
        }
      }
      return { w, h, z, slope, eta, b, dx, dy };
    });
    routeGridPromise.catch(() => (routeGridPromise = null));
  }
  return routeGridPromise;
}

function gridIndexOf(g, p) {
  const x = Math.round(((p.lon - g.b.lonMin) / (g.b.lonMax - g.b.lonMin)) * (g.w - 1));
  const y = Math.round(((g.b.latMax - p.lat) / (g.b.latMax - g.b.latMin)) * (g.h - 1));
  return x < 0 || y < 0 || x >= g.w || y >= g.h ? -1 : y * g.w + x;
}

function gridLonLat(g, i) {
  const x = i % g.w;
  const y = (i - x) / g.w;
  return {
    lon: g.b.lonMin + (x / (g.w - 1)) * (g.b.lonMax - g.b.lonMin),
    lat: g.b.latMax - (y / (g.h - 1)) * (g.b.latMax - g.b.latMin),
  };
}

// 이진 힙 (A* 열린 목록)
class MinHeap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }
  get size() {
    return this.keys.length;
  }
  push(key, val) {
    const k = this.keys, v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop() {
    const k = this.keys, v = this.vals;
    const top = v[0];
    const lastK = k.pop(), lastV = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lastK) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return top;
  }
}

// 16방향 이웃 (나이트 이동까지 → 경로가 덜 계단 모양)
const ROUTE_NEIGHBORS = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2],
];

// 한 칸에서 이웃 칸으로 가는 비용 요소
function edgeOf(g, i, j, ddx, ddy) {
  const horiz = Math.hypot(ddx * g.dx, ddy * g.dy);
  const rise = g.z[j] - g.z[i];
  const grade = rise / horiz;
  const eta = (g.eta[i] + g.eta[j]) / 2;
  const distM = Math.hypot(horiz, rise);
  const v = evaSpeed(grade, eta);
  const timeS = distM / v;
  return { distM, timeS, energyJ: evaMetabolicW(v, grade, eta) * timeS, slopeDeg: Math.max(g.slope[i], g.slope[j]), eta };
}

function astar(g, opt, from, to) {
  const N = g.w * g.h;
  const cost = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const tx = to % g.w, ty = (to - tx) / g.w;
  const minPerM = opt.id === "shortest" ? 1 : opt.id === "energy" ? EVA_MIN_J_PER_M : 1 / (EVA.flatSpeedMps * Math.exp(3.5 * 0.05));
  const hfun = (i) => {
    const x = i % g.w, y = (i - x) / g.w;
    return Math.hypot((x - tx) * g.dx, (y - ty) * g.dy) * minPerM;
  };
  const open = new MinHeap();
  cost[from] = 0;
  open.push(hfun(from), from);
  while (open.size) {
    const i = open.pop();
    if (closed[i]) continue;
    if (i === to) break;
    closed[i] = 1;
    const x = i % g.w, y = (i - x) / g.w;
    for (const [ddx, ddy] of ROUTE_NEIGHBORS) {
      const nx = x + ddx, ny = y + ddy;
      if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
      const j = ny * g.w + nx;
      if (closed[j]) continue;
      // 나이트 이동은 지나치는 두 칸도 지날 수 있어야 함
      if (Math.abs(ddx) + Math.abs(ddy) === 3) {
        const mx = x + Math.sign(ddx) * (Math.abs(ddx) === 2 ? 1 : 0);
        const my = y + Math.sign(ddy) * (Math.abs(ddy) === 2 ? 1 : 0);
        if (g.slope[my * g.w + mx] > opt.maxSlopeDeg) continue;
      }
      if (g.slope[j] > opt.maxSlopeDeg && j !== to) continue;
      const c = cost[i] + opt.cost(edgeOf(g, i, j, ddx, ddy));
      if (c < cost[j]) {
        cost[j] = c;
        prev[j] = i;
        open.push(c + hfun(j), j);
      }
    }
  }
  if (prev[to] === -1 && from !== to) return null;
  const cells = [];
  for (let i = to; i !== -1; i = prev[i]) cells.push(i);
  return cells.reverse();
}

// 경로를 일정 간격으로 따라가며 실제 고도 · 경사 · 시간 · 소모량 · 방사선을 계산
function measureRoute(opt, path) {
  const STEP_M = 10;
  const samples = [];
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1], b = path[k];
    const n = Math.max(1, Math.ceil(distanceM(a, b) / STEP_M));
    for (let t = k === 1 ? 0 : 1; t <= n; t++) {
      const lon = a.lon + ((b.lon - a.lon) * t) / n;
      const lat = a.lat + ((b.lat - a.lat) * t) / n;
      const e = demElevation(lon, lat);
      samples.push({ lon, lat, elev: e ? e.m : NaN });
    }
  }

  const start = marsClock.now().getTime();
  let dist = 0, climb = 0, maxSlope = 0, timeS = 0, energyJ = 0, doseMsv = 0, sandM = 0;
  const profile = [];
  samples.forEach((p, i) => {
    if (i > 0) {
      const q = samples[i - 1];
      const horiz = distanceM(q, p);
      const rise = p.elev - q.elev;
      const grade = horiz > 0 ? rise / horiz : 0;
      const eta = terrainEta(p.lon, p.lat);
      const d3 = Math.hypot(horiz, rise);
      const v = evaSpeed(grade, eta);
      const dt = d3 / v;
      dist += d3;
      if (rise > 0) climb += rise;
      if (eta > 1.1) sandM += d3;
      // 경사는 30 m 구간 기준 (DEM 잡음에 덜 흔들리게)
      const back = samples[Math.max(0, i - 3)];
      const span = distanceM(back, p);
      if (span > 0) maxSlope = Math.max(maxSlope, (Math.atan(Math.abs(p.elev - back.elev) / span) * 180) / Math.PI);
      energyJ += evaMetabolicW(v, grade, eta) * dt;
      const when = new Date(start + timeS * 1000);
      doseMsv += (radiationBase(p.elev) * radiationFactors(when, p.lon).total * dt) / 86400;
      timeS += dt;
    }
    profile.push({ dist, elev: p.elev });
  });
  const elevs = profile.map((p) => p.elev);
  const o2L = energyJ / 1000 / EVA.o2KjPerL;
  return {
    ...opt,
    path,
    profile,
    distanceM: dist,
    hours: timeS / 3600,
    climbM: climb,
    maxSlopeDeg: maxSlope,
    maxElevM: Math.max(...elevs),
    minElevM: Math.min(...elevs),
    kcal: Math.round(energyJ / 4184),
    o2L,
    o2TankPct: (o2L / EVA.o2TankL) * 100,
    waterKg: ((energyJ / 1000) * EVA.heatToWater) / EVA.sublimationKjPerKg,
    radiationUSv: doseMsv * 1000,
    sandM,
  };
}

// 출발 → 경유 → 도착 순서로 구간마다 A* 를 돌려 이어 붙임
function planRoute(g, opt, stops) {
  const path = [];
  for (let s = 0; s < stops.length - 1; s++) {
    const a = gridIndexOf(g, stops[s]);
    const b = gridIndexOf(g, stops[s + 1]);
    const cells = astar(g, opt, a, b);
    if (!cells) return null;
    if (s === 0) path.push({ ...stops[0] });
    for (const c of cells.slice(1, -1)) path.push(gridLonLat(g, c));
    path.push({ ...stops[s + 1] });
  }
  return measureRoute(opt, path);
}

async function findRoutes(stops, options = ROUTE_OPTIONS) {
  const g = await loadRouteGrid();
  await Promise.allSettled(["near", "hirise"].map(loadDemGrid)); // 고도 프로필용
  for (const p of stops) if (gridIndexOf(g, p) === -1) throw new Error("outside");
  const results = [];
  for (const opt of options) {
    await new Promise((r) => setTimeout(r)); // 화면이 멈추지 않게 경로 하나마다 쉼
    const r = planRoute(g, opt, stops);
    if (r) results.push(r);
  }
  return results;
}

routeFindBtn.addEventListener("click", async () => {
  if (!REGIONS[currentRegion]) {
    setRouteMsg("이 지역은 아직 지도 데이터가 없어요.", true);
    return;
  }
  const missing = nav.stops.findIndex((s) => !s.lonLat);
  if (missing !== -1) {
    setRouteMsg(`${stopLabel(nav.stops[missing], missing)}를 입력하거나 지도에서 선택하세요.`, true);
    return;
  }

  setRouteMsg("실제 지형(HiRISE DEM)으로 경로 계산 중…");
  routeFindBtn.disabled = true;
  try {
    const results = await findRoutes(nav.stops.map((s) => s.lonLat));
    if (!results.length) {
      setRouteMsg("경사가 너무 가팔라서 걸어서 갈 수 있는 길을 찾지 못했어요.", true);
      return;
    }
    nav.results = results;
    nav.selectedId = results[0].id;
    const missingNames = ROUTE_OPTIONS.filter((o) => !results.some((r) => r.id === o.id)).map((o) => o.name);
    setRouteMsg(
      `HiRISE DEM 30 m · 열관성 모래 위험 · 출발 ${formatClockTime(marsClock.now())} 기준` +
        (missingNames.length ? ` · ${missingNames.join(", ")}: 조건에 맞는 길 없음` : "")
    );
    renderResults();
    renderNavMap();
    fitNavRoutes();
    document.dispatchEvent(new CustomEvent("routeschange"));
  } catch (e) {
    console.warn(e);
    setRouteMsg(
      e.message === "outside"
        ? "출발지 · 경유지 · 도착지가 모두 Columbia Hills 지도(HiRISE DEM 범위) 안에 있어야 해요."
        : "지형 데이터를 읽지 못했어요. 로컬 서버(python3 -m http.server)로 열었는지 확인하세요.",
      true
    );
  } finally {
    routeFindBtn.disabled = false;
  }
});

function formatClockTime(d) {
  const t = marsTime(d, clockLocation().lon);
  return `화성 지방시 ${formatClock(t.ltst)}`;
}

// ---------- 결과 카드 ----------
function formatDuration(hours) {
  const total = Math.max(1, Math.round(hours * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}시간 ${m}분` : `${m}분`;
}

function formatDistance(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function formatElev(m) {
  return `${Math.round(m).toLocaleString()} m`;
}

// 고도 변화 그래프 (SVG)
function profileSvg(r) {
  const W = 260;
  const H = 54;
  const range = Math.max(r.maxElevM - r.minElevM, 1);
  const pts = r.profile.map((p) => {
    const x = (p.dist / r.distanceM) * W;
    const y = 4 + ((r.maxElevM - p.elev) / range) * (H - 8);
    return [x, y];
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const top = pts[r.profile.findIndex((p) => p.elev === r.maxElevM)];

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("route-card__profile");
  svg.innerHTML = `
    <polygon points="0,${H} ${line} ${W},${H}" fill="${r.color}" fill-opacity="0.15" />
    <polyline points="${line}" fill="none" stroke="${r.color}" stroke-width="2" vector-effect="non-scaling-stroke" />
    <line x1="${top[0]}" y1="${top[1]}" x2="${top[0]}" y2="${H}" stroke="#fff" stroke-opacity="0.6"
      stroke-dasharray="3 3" vector-effect="non-scaling-stroke" />`;
  return svg;
}

function renderResults() {
  routeResultsEl.replaceChildren();

  for (const r of nav.results) {
    const card = document.createElement("button");
    card.className = "route-card";
    card.classList.toggle("is-selected", r.id === nav.selectedId);
    card.style.setProperty("--route-color", r.color);
    card.setAttribute("aria-pressed", String(r.id === nav.selectedId));

    const head = document.createElement("div");
    head.className = "route-card__head";
    head.innerHTML = `<span class="route-card__name"></span><span class="route-card__desc"></span>`;
    head.children[0].textContent = r.name;
    head.children[1].textContent = r.desc;

    const summary = document.createElement("div");
    summary.className = "route-card__summary";
    summary.innerHTML = `<strong></strong><span></span>`;
    summary.children[0].textContent = formatDuration(r.hours);
    summary.children[1].textContent = ` / ${formatDistance(r.distanceM)}`;

    const axis = document.createElement("div");
    axis.className = "route-card__axis";
    axis.innerHTML = `<span>고도 ${formatElev(r.minElevM)} ~ ${formatElev(r.maxElevM)}</span><span></span>`;
    axis.children[1].textContent = formatDistance(r.distanceM);

    const stats = document.createElement("dl");
    stats.className = "route-card__stats";
    const rows = [
      ["소모 에너지", `${r.kcal.toLocaleString()} kcal`],
      ["소모 산소", `${Math.round(r.o2L).toLocaleString()} L (${Math.round(r.o2TankPct)}%)`],
      ["냉각수", `${r.waterKg.toFixed(2)} kg`],
      ["방사선 노출", `${r.radiationUSv.toFixed(1)} μSv`],
      ["최대 경사", `${r.maxSlopeDeg.toFixed(1)}°`],
      ["누적 오르막", `${Math.round(r.climbM)} m`],
      ["최고 고도", formatElev(r.maxElevM)],
      ["모래 지대", formatDistance(r.sandM)],
      ["평균 속도", `${(r.distanceM / 1000 / Math.max(r.hours, 1e-6)).toFixed(1)} km/h`],
    ];
    for (const [k, v] of rows) {
      const wrap = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      wrap.append(dt, dd);
      stats.append(wrap);
    }

    card.append(head, summary, profileSvg(r), axis, stats);
    card.addEventListener("click", () => {
      nav.selectedId = r.id;
      renderResults();
      renderNavMap();
    });
    routeResultsEl.append(card);
  }
}

// ---------- 지도에 경로 / 출발·도착 표시 ----------
function renderNavMap() {
  navRoutesSvg.replaceChildren();
  navPinsEl.replaceChildren();
  if (!REGIONS[currentRegion] || !mapImage.naturalWidth) return;

  const w = mapImage.naturalWidth;
  const h = mapImage.naturalHeight;
  navRoutesSvg.setAttribute("width", w);
  navRoutesSvg.setAttribute("height", h);
  navRoutesSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  // 선택된 경로를 맨 위에 그림
  const ordered = [...nav.results].sort((a, b) => (a.id === nav.selectedId) - (b.id === nav.selectedId));
  for (const r of ordered) {
    const points = r.path
      .map((p) => {
        const { x, y } = lonLatToImage(p.lon, p.lat);
        return `${x},${y}`;
      })
      .join(" ");
    const selected = r.id === nav.selectedId;

    if (selected) {
      const outline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      outline.setAttribute("points", points);
      outline.classList.add("nav-route", "nav-route--outline");
      navRoutesSvg.append(outline);
    }
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", points);
    line.setAttribute("stroke", r.color);
    line.classList.add("nav-route");
    line.classList.toggle("is-selected", selected);
    navRoutesSvg.append(line);
  }

  // 현위치 표시
  const here = getCurrentPosition();
  if (here) {
    const { x, y } = lonLatToImage(here.lon, here.lat);
    const dot = document.createElement("div");
    dot.className = "here-dot";
    dot.dataset.x = x;
    dot.dataset.y = y;
    dot.title = `현위치 ${formatLonLat(here)}`;
    navPinsEl.append(dot);
  }

  nav.stops.forEach((stop, i) => {
    if (!stop.lonLat) return;
    const { x, y } = lonLatToImage(stop.lonLat.lon, stop.lonLat.lat);
    const pin = document.createElement("div");
    pin.className = `nav-pin is-${stop.kind}`;
    pin.dataset.x = x;
    pin.dataset.y = y;
    pin.textContent = stop.kind === "start" ? "출발" : stop.kind === "end" ? "도착" : i;
    navPinsEl.append(pin);
  });

  positionPins();
}

// 오른쪽 아래 ◎ 버튼은 js/localize.js (현재 위치 찾기) 에서 처리

// 결과 경로 전체가 보이도록 지도 맞추기 (열려 있는 메뉴 창 오른쪽 영역 기준)
function fitNavRoutes() {
  const pts = nav.results.flatMap((r) => r.path.map((p) => lonLatToImage(p.lon, p.lat)));
  if (!pts.length) return;

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const left = drawer.classList.contains("is-open") ? drawer.getBoundingClientRect().right : 0;
  const pad = 60;
  const availW = Math.max(mapEl.clientWidth - left - pad * 2, 100);
  const availH = Math.max(mapEl.clientHeight - pad * 2, 100);
  const scale = Math.min(availW / Math.max(maxX - minX, 1), availH / Math.max(maxY - minY, 1));

  view.scale = Math.min(view.maxScale, Math.max(view.minScale, scale));
  view.x = left + pad + availW / 2 - ((minX + maxX) / 2) * view.scale;
  view.y = pad + availH / 2 - ((minY + maxY) / 2) * view.scale;
  applyView();
}

// ---------- 시작 ----------
renderStops();
// 지도 이미지가 준비되면 현위치 표시
if (mapImage.complete && mapImage.naturalWidth) renderNavMap();
else mapImage.addEventListener("load", renderNavMap);
