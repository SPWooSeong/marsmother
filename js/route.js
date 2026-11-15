// Mars Mother - 길찾기 (실제 지형 기반)
// 출발지 → 경유지 → 도착지 사이를 실제 DEM 위에서 D* Lite 로 탐색.
//  - 지형: HiRISE DEM 30 m 격자 (Columbia Hills 30 km 전체) · 경사는 이웃 칸 높이 차로 계산
//    탐사한 곳(js/survey.js)은 기존 DEM 대신 탐사로 잰 실제 지형을 씀
//  - HUD 에서 직접 걸으면 반경 SURVEY_RADIUS_M 안 실제 지형을 재고, 기존 지도와 다르면
//    D* Lite 가 바뀐 칸 근처만 고쳐 지금 위치부터 남은 길을 실시간으로 다시 계산 (onHudWalk)
//  - 지표: TES 열관성으로 추정한 모래 빠짐 위험 (무른 땅일수록 느리고 힘듦)
//  - 시간 · 에너지 · 산소 · 냉각수: js/eva.js 의 보행 모델 · 한도(경사 · 산소 · EVA 시간 · 안전 여유)는 나의 정보(js/profile.js)
//  - 그림자 · 통신 가시성 · 방사선 지형 차폐 · 귀환 시간: js/environment.js / 일몰 · 기온 일주기: js/marstime.js
//  - 방사선: 오른쪽 위 시계의 시각부터 걸으면서 받는 양 (js/marstime.js 모델, 고도 · 계절 · 시각 반영)
//
// main.js 의 전역 값/함수를 사용: mapEl, view, applyView, positionPins, lonLatToImage,
// formatLonLat, setDrawerOpen, drawer, startMapPick, REGIONS, currentRegion
// dem.js: loadDemGrid, demElevation / eva.js / marstime.js: marsClock, radiationFactors, radiationBase

// ---------- 설정 ----------
const MARS_RADIUS_M = 3396190;
const DEG_TO_M = (Math.PI * MARS_RADIUS_M) / 180;
const MAX_WAYPOINTS = 3;

// 경로 종류 = D* Lite 의 비용 기준
//  cost(edge) → 그 칸으로 가는 비용 / maxSlope() → 이보다 가파른 칸은 못 지나감 (나의 정보의 경사 한계 기준)
//  절대 장애물(경사 ABSOLUTE_SLOPE_DEG 이상)은 어떤 경로도 못 지나감
//
//  edge 에 들어 있는 것 (edgeOf):
//   distM · timeS · energyJ  거리 · 시간 · 대사 에너지(=산소) — 경사와 지면 계수(모래) 반영
//   slopeDeg · eta · rough   경사 · 지면 경도(모래일수록 큼) · 거칠기/암석 밀도 (발목 부상 위험)
//   radRel                   방사선 선량률 (고도 + 지형 차폐), 지도에서 가장 낮은 곳 = 1
//   shadow · comm            그늘인지 (춥고 어두움) · 기지와 통신되는지
//   retS                     그 칸에서 안전한 곳(출발지 · 기지)까지 걸어서 돌아오는 시간 (초)
const ROUTE_OPTIONS = [
  {
    // 안전 우선: 방사선 노출(선량 = 선량률 × 시간)을 줄이고, 문제가 생기면 안전한 곳으로 빨리 돌아올 수 있는 길
    //  + 통신 유지, 그늘 · 거친 지면 · 모래 · 비탈 회피. 경사 한계도 안전 여유만큼 더 낮게 잡음
    id: "safe",
    name: "안전한 길",
    desc: "방사선 최소 · 빠른 귀환 · 통신 유지",
    color: "#4c8dff",
    maxSlope: () => PROFILE.slopeLimitDeg * (1 - profileMargin()),
    cost: (e, opt) =>
      e.timeS *
      e.radRel *
      (1 +
        Math.max(0, e.slopeDeg - 0.5 * opt.maxSlopeDeg) * 0.5 + // 한계의 절반을 넘는 비탈
        Math.max(0, e.eta - 1.1) * 4 + // 모래 빠짐
        e.rough * 3 + // 발목 부상
        (e.shadow ? 0.5 : 0) + // 그늘: 춥고 어두움
        (e.comm ? 0 : 0.8) + // 통신 음영
        Math.min(2, e.retS / 2400)), // 안전한 곳에서 40분 멀어질 때마다 +1
  },
  {
    // 효율 우선: 가장 짧고 빠른 길. 위험 · 체력 소모는 한계 안에서만 따짐
    id: "shortest",
    name: "최단 거리",
    desc: "가장 짧고 빠른 길 · 위험은 한계까지 감수",
    color: "#7ed957",
    maxSlope: () => PROFILE.slopeLimitDeg,
    cost: (e) => e.distM + 0.3 * e.timeS * EVA.flatSpeedMps,
  },
  {
    // 체력 우선: 대사 에너지(= 산소 소모)가 가장 적은 길 — 오르막 · 모래를 돌아감
    id: "energy",
    name: "체력 아끼는 길",
    desc: "산소 · 체력 소모가 가장 적은 길",
    color: "#ffd84d",
    maxSlope: () => PROFILE.slopeLimitDeg,
    cost: (e) => e.energyJ,
  },
];

// 지금 설정(나의 정보)으로 굳힌 경로 종류
function routeOption(id) {
  const o = ROUTE_OPTIONS.find((x) => x.id === id);
  return { ...o, maxSlopeDeg: Math.min(ABSOLUTE_SLOPE_DEG, o.maxSlope()) };
}

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
  // HUD 모드에서는 2D 지도가 가려져 있으므로 잠깐 2D 로 바꿔서 핀을 찍고, 끝나면 HUD 로 돌아감
  const fromHud = typeof hud !== "undefined" && hud.on;
  if (fromHud) setHudMode(false);
  const finish = () => {
    if (fromHud) setHudMode(true);
    setDrawerOpen(true);
  };
  startMapPick(
    `${label} 위치를 지도에서 클릭하세요 (기존 핀을 눌러도 돼요)${fromHud ? " · 고르면 HUD 로 돌아가요" : ""}`,
    (lonLat, point) => {
      setStop(stop, lonLat, point ? point.name : null);
      finish();
    },
    finish
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

// 탐색용 격자: HiRISE 30 m DEM 격자 위의 "지금 아는 지형" (js/survey.js)
//  탐사한 칸은 실제로 잰 지형, 아닌 칸은 기존 DEM · 열관성. 탐사하면 이 배열들이 그 자리에서 바뀜
let routeGrid = null;
function loadRouteGrid() {
  return loadSurvey().then((s) => {
    if (!routeGrid) routeGrid = { w: s.w, h: s.h, z: s.z, slope: s.slope, eta: s.eta, b: s.b, dx: s.dx, dy: s.dy };
    return routeGrid;
  });
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

// 우선순위 큐: 키 두 개 (k1, k2) 사전식 비교 — D* Lite 의 열린 목록
//  같은 칸이 여러 번 들어갈 수 있음 (꺼낼 때 오래된 항목은 버림)
class KeyHeap {
  constructor() {
    this.k1 = [];
    this.k2 = [];
    this.vals = [];
    this.lastK1 = 0;
    this.lastK2 = 0;
  }
  get size() {
    return this.vals.length;
  }
  topK1() {
    return this.k1[0];
  }
  topK2() {
    return this.k2[0];
  }
  push(a, b, val) {
    const k1 = this.k1, k2 = this.k2, v = this.vals;
    let i = v.length;
    k1.push(a);
    k2.push(b);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k1[p] < a || (k1[p] === a && k2[p] <= b)) break;
      k1[i] = k1[p];
      k2[i] = k2[p];
      v[i] = v[p];
      i = p;
    }
    k1[i] = a;
    k2[i] = b;
    v[i] = val;
  }
  pop() {
    const k1 = this.k1, k2 = this.k2, v = this.vals;
    const top = v[0];
    this.lastK1 = k1[0];
    this.lastK2 = k2[0];
    const a = k1.pop(), b = k2.pop(), val = v.pop();
    const n = v.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && (k1[c + 1] < k1[c] || (k1[c + 1] === k1[c] && k2[c + 1] < k2[c]))) c++;
        if (k1[c] > a || (k1[c] === a && k2[c] >= b)) break;
        k1[i] = k1[c];
        k2[i] = k2[c];
        v[i] = v[c];
        i = c;
      }
      k1[i] = a;
      k2[i] = b;
      v[i] = val;
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
  const E = g.env;
  return {
    distM,
    timeS,
    energyJ: evaMetabolicW(v, grade, eta) * timeS,
    slopeDeg: Math.max(g.slope[i], g.slope[j]),
    eta,
    rough: g.rough ? Math.max(g.rough[i], g.rough[j]) : 0,
    radRel: E ? (E.radRate[i] + E.radRate[j]) / (2 * E.radMin) : 1,
    shadow: E ? E.shadow[j] : 0,
    comm: E && E.comm ? E.comm[j] : 1,
    retS: E ? E.ret[j] : 0,
  };
}

// ---------- D* Lite (Koenig & Likhachev, 2002 · 최적화판) ----------
// 도착지 → 출발지 방향으로 거꾸로 탐색해 두고, 걸어가다 지형이 기존 지도와 다르면
// 바뀐 칸 근처만 고쳐서 남은 길을 다시 계산 (처음부터 다시 찾지 않음)
//  g(s)   : s 에서 도착지까지 지금 알고 있는 최소 비용
//  rhs(s) : 이웃을 한 번 거쳐 본 비용 = min( c(s, s') + g(s') ). g ≠ rhs 인 칸만 열린 목록에 들어감
//  km     : 출발점(=현재 위치)이 움직인 만큼 키를 보정하는 값 (열린 목록을 다시 정렬하지 않으려고)
// 첫 계산은 A* 와 같은 길을 줌 (같은 비용 · 같은 휴리스틱)
class DStarLite {
  constructor(g, opt, start, goal) {
    const N = g.w * g.h;
    this.gr = g;
    this.opt = opt;
    this.gv = new Float64Array(N).fill(Infinity);
    this.rhs = new Float64Array(N).fill(Infinity);
    this.U = new KeyHeap();
    this.km = 0;
    this.start = start;
    this.last = start;
    this.goal = goal;
    this.expanded = 0;
    // 휴리스틱: 직선 거리 × 1 m 당 최소 비용 (실제 비용보다 크지 않음)
    //  최단: 비용 ≥ 거리 / 체력: 가장 단단한 땅 · 가장 유리한 경사의 J/m / 안전: 가장 빠른 걸음의 시간 (가중치 ≥ 1)
    this.minPerM =
      opt.id === "shortest" ? 1 : opt.id === "energy" ? evaMinJPerM() : 1 / (EVA.flatSpeedMps * Math.exp(3.5 * 0.05) * Math.sqrt(1.1));
    this.rhs[goal] = 0;
    this.U.push(this.h(start, goal), 0, goal);
  }

  h(a, b) {
    const w = this.gr.w;
    const ax = a % w, ay = (a - ax) / w;
    const bx = b % w, by = (b - bx) / w;
    return Math.hypot((ax - bx) * this.gr.dx, (ay - by) * this.gr.dy) * this.minPerM;
  }

  // u → v (v = u + (ddx, ddy)) 로 가는 비용. 너무 가파르면 Infinity
  cost(u, v, ddx, ddy) {
    const g = this.gr;
    const max = this.opt.maxSlopeDeg;
    if (g.slope[v] >= ABSOLUTE_SLOPE_DEG) return Infinity; // 절대 장애물: 도착지라도 못 감
    if (g.slope[v] > max && v !== this.goal) return Infinity;
    // 나이트 이동은 지나치는 칸도 지날 수 있어야 함
    if (Math.abs(ddx) + Math.abs(ddy) === 3) {
      const ux = u % g.w, uy = (u - ux) / g.w;
      const mx = ux + Math.sign(ddx) * (Math.abs(ddx) === 2 ? 1 : 0);
      const my = uy + Math.sign(ddy) * (Math.abs(ddy) === 2 ? 1 : 0);
      if (g.slope[my * g.w + mx] > max) return Infinity;
    }
    return this.opt.cost(edgeOf(g, u, v, ddx, ddy), this.opt);
  }

  // 이웃을 거쳐 가는 최소 비용과 그 이웃
  best(u) {
    const g = this.gr, w = g.w, H = g.h;
    const x = u % w, y = (u - x) / w;
    let bestV = Infinity, bestS = -1;
    for (const [ddx, ddy] of ROUTE_NEIGHBORS) {
      const nx = x + ddx, ny = y + ddy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= H) continue;
      const s = ny * w + nx;
      const gs = this.gv[s];
      if (gs === Infinity) continue;
      const c = this.cost(u, s, ddx, ddy) + gs;
      if (c < bestV) {
        bestV = c;
        bestS = s;
      }
    }
    return { value: bestV, next: bestS };
  }

  queue(u) {
    const g = this.gv[u], r = this.rhs[u];
    if (g === r) return;
    const m = Math.min(g, r);
    this.U.push(m + this.h(this.start, u) + this.km, m, u);
  }

  computeShortestPath() {
    const { gv, rhs, U, gr } = this;
    const w = gr.w, H = gr.h;
    let n = 0;
    while (U.size) {
      const s = this.start;
      const ms = Math.min(gv[s], rhs[s]);
      const ks1 = ms + this.km;
      const t1 = U.topK1(), t2 = U.topK2();
      if (!(t1 < ks1 || (t1 === ks1 && t2 < ms) || rhs[s] > gv[s])) break;

      const u = U.pop();
      const k1 = U.lastK1, k2 = U.lastK2;
      if (gv[u] === rhs[u]) continue; // 이미 처리된 오래된 항목
      const m = Math.min(gv[u], rhs[u]);
      const n1 = m + this.h(s, u) + this.km;
      const tol = 1e-9 * (Math.abs(n1) + 1);
      if (k1 < n1 - tol || (Math.abs(k1 - n1) <= tol && k2 < m - tol)) {
        U.push(n1, m, u); // 출발점이 움직여서 키가 커짐 → 다시 넣음
        continue;
      }
      if (k1 > n1 + tol) continue; // 더 작은 키로 다시 들어간 항목이 있음

      n++;
      const x = u % w, y = (u - x) / w;
      if (gv[u] > rhs[u]) {
        // 비용이 줄어든 칸: 이웃(선행 칸)의 rhs 를 바로 낮춤
        gv[u] = rhs[u];
        for (const [ddx, ddy] of ROUTE_NEIGHBORS) {
          const px = x - ddx, py = y - ddy;
          if (px < 0 || py < 0 || px >= w || py >= H) continue;
          const p = py * w + px;
          if (p === this.goal) continue;
          const c = this.cost(p, u, ddx, ddy) + gv[u];
          if (c < rhs[p]) {
            rhs[p] = c;
            this.queue(p);
          }
        }
      } else {
        // 비용이 늘어난 칸: u 를 거쳐 가던 이웃만 다시 계산
        const gold = gv[u];
        gv[u] = Infinity;
        if (u !== this.goal) rhs[u] = this.best(u).value;
        this.queue(u);
        for (const [ddx, ddy] of ROUTE_NEIGHBORS) {
          const px = x - ddx, py = y - ddy;
          if (px < 0 || py < 0 || px >= w || py >= H) continue;
          const p = py * w + px;
          if (p === this.goal) continue;
          const via = this.cost(p, u, ddx, ddy) + gold;
          if (Math.abs(rhs[p] - via) <= 1e-9 * (Math.abs(via) + 1)) {
            rhs[p] = this.best(p).value;
            this.queue(p);
          }
        }
      }
    }
    this.expanded += n;
    return n;
  }

  // 지형이 바뀐 칸들: 이 칸에서 나가는 비용이 바뀌었을 수 있으니 rhs 를 다시 계산
  updateCells(cells) {
    this.km += this.h(this.last, this.start);
    this.last = this.start;
    for (const u of cells) {
      if (u !== this.goal) this.rhs[u] = this.best(u).value;
      this.queue(u);
    }
  }

  reachable() {
    return this.rhs[this.start] !== Infinity || this.gv[this.start] !== Infinity;
  }

  nextStep() {
    return this.best(this.start).next;
  }

  moveTo(cell) {
    this.start = cell;
  }

  // 현재 위치 → 도착지 칸 목록 (못 가면 null)
  extractPath() {
    if (!this.reachable()) return null;
    const cells = [this.start];
    const seen = new Set(cells);
    let u = this.start;
    while (u !== this.goal) {
      u = this.best(u).next;
      if (u < 0 || seen.has(u)) return null;
      seen.add(u);
      cells.push(u);
    }
    return cells;
  }
}

function dstarPlan(g, opt, from, to) {
  const planner = new DStarLite(g, opt, from, to);
  planner.computeShortestPath();
  return planner.extractPath();
}


// 경로를 일정 간격으로 따라가며 실제 고도 · 경사 · 시간 · 소모량 · 방사선을 계산
function measureRoute(opt, path) {
  const STEP_M = 10;
  const g = routeGrid;
  const E = g && g.env;
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

  const startDate = marsClock.now();
  const start = startDate.getTime();
  const hasBase = !!(E && E.comm);
  let dist = 0, climb = 0, descent = 0, maxSlope = 0, timeS = 0, energyJ = 0, doseMsv = 0, sandM = 0;
  let roughM = 0, roughSum = 0, shadowS = 0, commS = 0, maxRetS = 0, retCapped = false, heaterWh = 0;
  let minTemp = Infinity, maxTemp = -Infinity;
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
      else descent -= rise;
      if (eta > 1.1) sandM += d3;
      // 경사는 30 m 구간 기준 (DEM 잡음에 덜 흔들리게)
      const back = samples[Math.max(0, i - 3)];
      const span = distanceM(back, p);
      if (span > 0) maxSlope = Math.max(maxSlope, (Math.atan(Math.abs(p.elev - back.elev) / span) * 180) / Math.PI);
      energyJ += evaMetabolicW(v, grade, eta) * dt;

      const when = new Date(start + timeS * 1000);
      const cell = g ? gridIndexOf(g, p) : -1;
      // 방사선: 고도 + 지형 차폐 × 그 시각의 계수
      const rate = E && cell !== -1 ? E.radRate[cell] : radiationBase(p.elev);
      doseMsv += (rate * radiationFactors(when, p.lon).total * dt) / 86400;
      let shadow = false;
      if (cell !== -1) {
        const r = g.rough[cell];
        roughSum += r * d3;
        if (r > 0.4) roughM += d3;
        shadow = !!envShadowMap(when).map[cell]; // 그 시각의 태양 위치로
        if (shadow) shadowS += dt;
        if (hasBase && E.comm[cell]) commS += dt;

      }
      // 기온 일주기 (그늘 · 모래 반영) → 우주복 히터 전력
      const temp = surfaceTempC(when, p.lon, p.lat, { shadow, eta });
      minTemp = Math.min(minTemp, temp);
      maxTemp = Math.max(maxTemp, temp);
      heaterWh += (Math.max(0, -40 - temp) * 0.8 * dt) / 3600; // −40°C 아래로 1°C 마다 0.8 W
      timeS += dt;
    }
    profile.push({ dist, elev: p.elev });
  });
  // 안전한 곳까지 귀환 시간: 실제로 밟는 칸(경로 꼭짓점) 기준
  if (E) {
    for (const p of path) {
      const cell = gridIndexOf(g, p);
      if (cell === -1) continue;
      maxRetS = Math.max(maxRetS, E.ret[cell]);
      if (E.ret[cell] >= E.retCapS) retCapped = true;
    }
  }
  const elevs = profile.map((p) => p.elev);
  const o2L = energyJ / 1000 / EVA.o2KjPerL;
  const kcal = Math.round(energyJ / 4184);
  const batteryWh = (EVA.suitPowerW * timeS) / 3600 + heaterWh;

  // 일몰: 출발지 기준
  const sun = sunTimes(startDate, path[0].lon, path[0].lat);
  const afterSunsetS = sun.isDay ? timeS - sun.msToSunset / 1000 : timeS;

  // 경고: 나의 정보의 한도(안전 여유 제외)와 비교
  const warnings = [];
  const usableO2 = profileUsableO2L(), usableH = profileUsableHours();
  if (o2L > PROFILE.o2TankL) warnings.push({ level: "danger", text: `산소 부족: ${Math.round(o2L)} L 필요 / 탱크 ${PROFILE.o2TankL} L` });
  else if (o2L > usableO2) warnings.push({ level: "caution", text: `산소 안전 여유(${PROFILE.marginPct}%) 침범: ${Math.round(o2L)} L / 사용 가능 ${Math.round(usableO2)} L` });
  if (timeS / 3600 > PROFILE.evaMaxHours) warnings.push({ level: "danger", text: `EVA 최대 시간 ${PROFILE.evaMaxHours}시간 초과` });
  else if (timeS / 3600 > usableH) warnings.push({ level: "caution", text: `EVA 시간 여유 침범 (사용 가능 ${usableH.toFixed(1)}시간)` });
  if (!sun.isDay) warnings.push({ level: "danger", text: `밤에 출발 — 일출까지 ${formatDuration(sun.msToSunrise / 3600e3)}` });
  else if (afterSunsetS > 0) warnings.push({ level: "danger", text: `일몰 ${formatDuration(afterSunsetS / 3600)} 뒤에 도착 — 야간 이동` });
  else if (-afterSunsetS < usableH * 3600 * profileMargin()) warnings.push({ level: "caution", text: `일몰 ${formatDuration(-afterSunsetS / 3600)} 전 도착 — 여유 적음` });
  if (doseMsv * 1000 > PROFILE.radLimitUSv) warnings.push({ level: "caution", text: `방사선 한도 ${PROFILE.radLimitUSv} μSv 초과` });
  if (kcal > PROFILE.fitnessKcal) warnings.push({ level: "caution", text: `하루 체력 예산 ${PROFILE.fitnessKcal.toLocaleString()} kcal 초과` });
  if (batteryWh > EVA.batteryWh) warnings.push({ level: "danger", text: "배터리 부족 (추위로 히터 전력 증가)" });
  if (hasBase && commS / Math.max(timeS, 1) < 0.5) warnings.push({ level: "caution", text: "경로의 절반 이상이 통신 음영" });

  return {
    ...opt,
    path,
    profile,
    distanceM: dist,
    hours: timeS / 3600,
    climbM: climb,
    descentM: descent,
    maxSlopeDeg: maxSlope,
    maxElevM: Math.max(...elevs),
    minElevM: Math.min(...elevs),
    kcal,
    o2L,
    o2TankPct: (o2L / EVA.o2TankL) * 100,
    waterKg: ((energyJ / 1000) * EVA.heatToWater) / EVA.sublimationKjPerKg,
    radiationUSv: doseMsv * 1000,
    sandM,
    roughM,
    ankleRisk: dist > 0 ? roughSum / dist : 0,
    shadowPct: timeS > 0 ? (shadowS / timeS) * 100 : 0,
    commPct: hasBase && timeS > 0 ? (commS / timeS) * 100 : null,
    maxReturnMin: E ? maxRetS / 60 : null,
    returnCapped: retCapped,
    minTempC: minTemp,
    maxTempC: maxTemp,
    batteryPct: (batteryWh / EVA.batteryWh) * 100,
    arrival: new Date(start + timeS * 1000),
    sunsetMarginS: sun.isDay ? -afterSunsetS : null,
    warnings,
  };
}

// 출발 → 경유 → 도착 순서로 구간마다 D* Lite 를 돌려 이어 붙임
function planRoute(g, opt, stops) {
  const path = [];
  for (let s = 0; s < stops.length - 1; s++) {
    const a = gridIndexOf(g, stops[s]);
    const b = gridIndexOf(g, stops[s + 1]);
    const cells = dstarPlan(g, opt, a, b);
    if (!cells) return null;
    if (s === 0) path.push({ ...stops[0] });
    for (const c of cells.slice(1, -1)) path.push(gridLonLat(g, c));
    path.push({ ...stops[s + 1] });
  }
  return measureRoute(opt, path);
}

// 길찾기에 쓰는 환경 필드 (js/environment.js): 방사선 · 그림자 · 통신 · 안전한 곳까지 귀환 시간
//  안전한 곳 = 출발지 + 기지 포인트
function prepareRouteEnv(g, stops) {
  g.rough = survey.rough;
  const safe = [gridIndexOf(g, stops[0]), ...getBases().map((p) => gridIndexOf(g, p))].filter((c) => c !== -1);
  let spanM = 0;
  for (let k = 1; k < stops.length; k++) spanM += distanceM(stops[k - 1], stops[k]);
  g.env = envForRoute(marsClock.now(), safe, spanM / (EVA.flatSpeedMps * 0.6));
}

async function findRoutes(stops, options = ROUTE_OPTIONS) {
  const g = await loadRouteGrid();
  await Promise.allSettled(["near", "hirise"].map(loadDemGrid)); // 고도 프로필용
  for (const p of stops) if (gridIndexOf(g, p) === -1) throw new Error("outside");
  prepareRouteEnv(g, stops);
  const results = [];
  for (const o of options) {
    await new Promise((r) => setTimeout(r)); // 화면이 멈추지 않게 경로 하나마다 쉼
    const r = planRoute(g, routeOption(o.id), stops);
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

  setRouteMsg("실제 지형(HiRISE DEM + 탐사 데이터)으로 D* Lite 경로 계산 중…");
  routeFindBtn.disabled = true;
  try {
    const results = await findRoutes(nav.stops.map((s) => s.lonLat));
    if (!results.length) {
      setRouteMsg(`경사 한계 ${PROFILE.slopeLimitDeg}° 안에서 걸어서 갈 수 있는 길을 찾지 못했어요. (나의 정보에서 조정 가능)`, true);
      return;
    }
    nav.results = results;
    nav.selectedId = results[0].id;
    const missingNames = ROUTE_OPTIONS.filter((o) => !results.some((r) => r.id === o.id)).map((o) => o.name);
    setRouteMsg(
      `D* Lite · HiRISE DEM 30 m + 탐사 데이터 · 경사 한계 ${PROFILE.slopeLimitDeg}° · 출발 ${formatClockTime(marsClock.now())} 기준` +
        (getBases().length ? "" : " · 기지 없음 (안전한 곳 = 출발지, 통신 미평가)") +
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

// 칸 목록을 r 칸만큼 넓힘
function dilateCells(g, cells, r) {
  const out = new Set();
  for (const i of cells) {
    const x = i % g.w, y = (i - x) / g.w;
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        const nx = x + ox, ny = y + oy;
        if (nx >= 0 && ny >= 0 && nx < g.w && ny < g.h) out.add(ny * g.w + nx);
      }
    }
  }
  return out;
}

// ---------- HUD 로 직접 걸을 때: 걸은 곳을 탐사 구역으로 + 고른 경로를 D* Lite 로 실시간 재계획 ----------
const HUD_WALK_STEP_M = 4; // 이만큼 움직일 때마다 주변 지형을 잼 (발자취 점 간격)
const ARRIVE_M = 40; // 경유지 · 도착지에 이만큼 다가가면 도착한 것으로
const hudWalk = { last: null, planner: null, key: null, nextStop: 1 };

function onHudWalk(here) {
  if (!survey.loaded) return;
  if (hudWalk.last && distanceM(hudWalk.last, here) < HUD_WALK_STEP_M) return;
  const prev = hudWalk.last || here;
  hudWalk.last = { lon: here.lon, lat: here.lat };
  surveyTrackPoint(here);
  const seen = surveyRevealPath([prev, hudWalk.last]);
  if (seen.cells.size) replanFromHere(hudWalk.last, seen.cells);
}

// 지금 위치 → 남은 경유지 → 도착지. 지금 구간은 D* Lite 를 이어서 쓰고 (바뀐 칸만 고침), 그 뒤 구간은 새로 계산
function replanFromHere(here, changed) {
  const g = routeGrid;
  const r = nav.results.find((x) => x.id === nav.selectedId);
  if (!g || !g.env || !r) return;
  const stops = nav.stops.map((s) => s.lonLat);
  if (stops.some((s) => !s)) return;
  const cur = gridIndexOf(g, here);
  if (cur === -1) return;

  const key = `${r.id}|${stops.map((s) => `${s.lon},${s.lat}`).join(";")}`;
  if (hudWalk.key !== key) Object.assign(hudWalk, { key, planner: null, nextStop: 1 });
  while (hudWalk.nextStop < stops.length - 1 && distanceM(here, stops[hudWalk.nextStop]) < ARRIVE_M) {
    hudWalk.nextStop++;
    hudWalk.planner = null;
  }
  const last = stops.length - 1;
  if (hudWalk.nextStop === last && distanceM(here, stops[last]) < ARRIVE_M) return; // 도착

  const opt = routeOption(r.id);
  let P = hudWalk.planner;
  const goal = gridIndexOf(g, stops[hudWalk.nextStop]);
  if (!P || P.goal !== goal || P.opt.maxSlopeDeg !== opt.maxSlopeDeg) {
    P = hudWalk.planner = new DStarLite(g, opt, cur, goal);
  } else {
    P.moveTo(cur);
    P.updateCells(dilateCells(g, changed, 2));
  }
  P.computeShortestPath();
  const cells = P.extractPath();
  if (!cells) {
    setRouteMsg("앞의 지형이 지도와 달라 지금 위치에서 갈 수 있는 길이 없어요. 다른 경로를 골라 보세요.", true);
    return;
  }
  const path = [{ ...here }];
  for (const c of cells.slice(1, -1)) path.push(gridLonLat(g, c));
  path.push({ ...stops[hudWalk.nextStop] });
  for (let s = hudWalk.nextStop; s < last; s++) {
    const seg = dstarPlan(g, opt, gridIndexOf(g, stops[s]), gridIndexOf(g, stops[s + 1]));
    if (!seg) return;
    for (const c of seg.slice(1, -1)) path.push(gridLonLat(g, c));
    path.push({ ...stops[s + 1] });
  }

  const next = measureRoute(opt, path);
  next.liveReplans = (r.liveReplans || 0) + 1;
  nav.results[nav.results.indexOf(r)] = next;
  renderResults();
  renderNavMap();
  document.dispatchEvent(new CustomEvent("routeschange"));
}

// 나의 정보(경사 한계 · 산소 · 시간 · 여유)가 바뀌면 이전 결과는 맞지 않으므로 비움
document.addEventListener("profilechange", () => {
  if (nav.results.length) {
    onStopsChanged();
    setRouteMsg("나의 정보가 바뀌었어요. 길을 다시 찾아 주세요.");
  }
});

// 탐사 기록을 지우면 길찾기가 쓰던 지형도 바뀌므로 결과를 비움
document.addEventListener("surveyreset", () => {
  if (nav.results.length) {
    onStopsChanged();
    setRouteMsg("탐사 기록을 지웠어요. 길을 다시 찾아 주세요.");
  }
});

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

  // 맨 위: 고른 길로 안내 시작
  const sel = nav.results.find((r) => r.id === nav.selectedId);
  if (sel) {
    const bar = document.createElement("div");
    bar.className = "route-start";
    const btn = document.createElement("button");
    btn.className = "route-start__btn";
    btn.style.setProperty("--route-color", sel.color);
    btn.textContent = `▶ ${sel.name}로 안내 시작`;
    btn.addEventListener("click", () => startGuidance(sel));
    const hint = document.createElement("span");
    hint.className = "route-start__hint";
    hint.textContent = "아래에서 다른 길을 눌러 바꿀 수 있어요";
    bar.append(btn, hint);
    routeResultsEl.append(bar);
  }

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
      ["누적 내리막", `${Math.round(r.descentM)} m`],
      ["모래 지대", formatDistance(r.sandM)],
      ["거친 지면", `${formatDistance(r.roughM)} (위험 ${(r.ankleRisk * 100).toFixed(0)})`],
      ["그늘 구간", `${Math.round(r.shadowPct)}%`],
      ["통신 유지", r.commPct == null ? "기지 없음" : `${Math.round(r.commPct)}%`],
      ["최대 귀환 시간", r.maxReturnMin == null ? "—" : `${r.returnCapped ? "≥ " : ""}${formatDuration(r.maxReturnMin / 60)}`],
      ["기온", `${Math.round(r.minTempC)} ~ ${Math.round(r.maxTempC)}°C`],
      ["배터리", `${Math.round(r.batteryPct)}%`],
      ["도착", `${formatClock(marsTime(r.arrival, r.path[r.path.length - 1].lon).ltst)}${r.sunsetMarginS == null ? " (밤)" : r.sunsetMarginS >= 0 ? ` · 일몰 ${formatDuration(r.sunsetMarginS / 3600)} 전` : " · 일몰 후"}`],
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

    card.append(head, summary, profileSvg(r), axis);
    // 나의 정보 한도 · 일몰 · 통신 경고
    if (r.warnings.length) {
      const warn = document.createElement("ul");
      warn.className = "route-card__warnings";
      for (const w of r.warnings) {
        const li = document.createElement("li");
        li.className = `is-${w.level}`;
        li.textContent = `${w.level === "danger" ? "⛔" : "⚠️"} ${w.text}`;
        warn.append(li);
      }
      card.append(warn);
    }
    card.append(stats);
    card.addEventListener("click", () => {
      nav.selectedId = r.id;
      renderResults();
      renderNavMap();
    });
    routeResultsEl.append(card);
  }
}

// ---------- 안내 시작: 출발점에서 고른 길을 바라보고 HUD(AR) 안내로 ----------
function startGuidance(route) {
  const region = REGIONS[currentRegion];
  if (!region || !route.path.length) return;
  nav.selectedId = route.id;

  // 내 위치 = 경로 출발점
  const start = route.path[0];
  region.currentPosition = { lon: start.lon, lat: start.lat };

  // 걸으며 재계획하는 상태도 처음부터
  Object.assign(hudWalk, { last: null, planner: null, key: null, nextStop: 1 });

  // 첫 진행 방향: 출발점에서 15m 앞 경로 지점을 바라봄
  let ahead = route.path[route.path.length - 1];
  for (const p of route.path) {
    if (distanceM(start, p) >= 15) {
      ahead = p;
      break;
    }
  }
  const cos = Math.cos((start.lat * Math.PI) / 180);
  const bearing = (Math.atan2((ahead.lon - start.lon) * cos, ahead.lat - start.lat) * 180) / Math.PI;

  renderResults();
  renderNavMap();
  setDrawerOpen(false);
  if (typeof setHudMode === "function") {
    if (!hud.on) setHudMode(true);
    hud.heading = (bearing + 360) % 360;
  }
  document.dispatchEvent(new CustomEvent("positionchange")); // HUD 내 위치 · 발밑 타일 갱신
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

  const svgEl = (tag, attrs, cls) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (cls) el.classList.add(...cls.split(" "));
    navRoutesSvg.append(el);
    return el;
  };
  const toPoints = (path) =>
    path
      .map((p) => {
        const { x, y } = lonLatToImage(p.lon, p.lat);
        return `${x},${y}`;
      })
      .join(" ");

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

    // 테두리: 어떤 레이어 색 위에서도 보이게 — 모든 경로에 어두운 테두리, 선택한 경로는 그 안에 흰 테두리까지
    for (const cls of selected ? ["nav-route--outline", "nav-route--halo"] : ["nav-route--outline"]) {
      const casing = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      casing.setAttribute("points", points);
      casing.classList.add("nav-route", cls);
      casing.classList.toggle("is-selected", selected);
      navRoutesSvg.append(casing);
    }
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", points);
    line.setAttribute("stroke", r.color);
    line.classList.add("nav-route");
    line.classList.toggle("is-selected", selected);
    navRoutesSvg.append(line);
  }

  // 현위치 표시 + 바라보는 방향 (HUD 에서 마지막으로 바라본 방향, 0° = 북쪽)
  const here = getCurrentPosition();
  if (here) {
    const { x, y } = lonLatToImage(here.lon, here.lat);
    const cone = document.createElement("div");
    cone.className = "here-cone";
    cone.dataset.x = x;
    cone.dataset.y = y;
    cone.style.setProperty("--heading", `${typeof hud !== "undefined" ? hud.heading : 0}deg`);
    navPinsEl.append(cone); // 점보다 먼저 넣어서 점 아래에 깔림
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
