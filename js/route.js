// Mars Mother - 길찾기 (데모)
// 실제 길찾기 알고리즘 대신, 출발지→경유지→도착지를 잇는 "그럴듯한 가짜 경로"와 수치를 만들어
// 화면 흐름만 보여줌.
// TODO: buildDemoRoute() 를 실제 알고리즘(DEM·위험지역 기반 탐색)으로 교체
//
// main.js 의 전역 값/함수를 사용: mapEl, view, applyView, positionPins, lonLatToImage,
// formatLonLat, setDrawerOpen, drawer, startMapPick, REGIONS, currentRegion

// ---------- 설정 ----------
const MARS_RADIUS_M = 3396190;
const DEG_TO_M = (Math.PI * MARS_RADIUS_M) / 180;
const BASE_ELEVATION_M = -1913; // Gusev DEM 중앙값 (preprocess/out/report.json)
const SURFACE_RADIATION_USV_PER_H = 27; // 화성 표면 평균 약 0.65 mSv/일
const MAX_WAYPOINTS = 3;

// 경로 종류: 데모용으로 경로 모양(bend: 휘는 정도)과 지형 굴곡, 이동 속도 등을 다르게 줌
const ROUTE_OPTIONS = [
  {
    id: "safe",
    name: "안전한 길",
    desc: "위험 지역 우회 · 완만한 경사",
    color: "#4c8dff",
    bend: 0.28,
    roughness: 14,
    speedKmh: 2.6,
    o2LPerHour: 70,
    radiationFactor: 0.8,
  },
  {
    id: "shortest",
    name: "최단 거리",
    desc: "가장 짧지만 경사가 가파름",
    color: "#7ed957",
    bend: 0.03,
    roughness: 70,
    speedKmh: 3.0,
    o2LPerHour: 85,
    radiationFactor: 1,
  },
  {
    id: "easy",
    name: "편안한 길",
    desc: "평탄한 지형 위주 · 거리가 김",
    color: "#ffd84d",
    bend: -0.42,
    roughness: 7,
    speedKmh: 3.4,
    o2LPerHour: 60,
    radiationFactor: 1,
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

// ---------- 데모 경로 만들기 ----------
function distanceM(a, b) {
  const cos = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lon - a.lon) * cos * DEG_TO_M, (b.lat - a.lat) * DEG_TO_M);
}

// 가짜 지형 고도: 위치 기반 굴곡 + 경로 종류별 잔굴곡
function demoElevation(p, d, opt) {
  const terrain = 30 * Math.sin(p.lon * 150) + 25 * Math.cos(p.lat * 200);
  const bumps = opt.roughness * (0.6 * Math.sin(d / 230 + 1.3) + 0.4 * Math.sin(d / 97 + 0.4));
  return BASE_ELEVATION_M + terrain + bumps;
}

function buildDemoRoute(opt, stops) {
  // 1) 경로 모양: 각 구간을 옆으로 휘게 만든 곡선
  const path = [];
  for (let s = 0; s < stops.length - 1; s++) {
    const a = stops[s];
    const b = stops[s + 1];
    const cos = Math.cos((a.lat * Math.PI) / 180);
    const dx = (b.lon - a.lon) * cos;
    const dy = b.lat - a.lat;
    const len = Math.hypot(dx, dy);
    const N = 40;

    for (let k = s === 0 ? 0 : 1; k <= N; k++) {
      const t = k / N;
      let x = dx * t;
      let y = dy * t;
      if (len > 0) {
        const off = len * (opt.bend * Math.sin(Math.PI * t) + 0.04 * Math.sin(3 * Math.PI * t));
        x += (-dy / len) * off;
        y += (dx / len) * off;
      }
      path.push({ lon: a.lon + x / cos, lat: a.lat + y });
    }
  }

  // 2) 거리·고도 프로필
  let dist = 0;
  let climb = 0;
  let maxSlope = 0;
  const profile = [];
  path.forEach((p, i) => {
    if (i > 0) dist += distanceM(path[i - 1], p);
    const elev = demoElevation(p, dist, opt);
    if (i > 0) {
      const prev = profile[i - 1];
      const de = elev - prev.elev;
      const dd = dist - prev.dist;
      if (de > 0) climb += de;
      if (dd > 0) maxSlope = Math.max(maxSlope, (Math.atan(Math.abs(de) / dd) * 180) / Math.PI);
    }
    profile.push({ dist, elev });
  });

  // 3) 시간과 소모량 (데모 공식)
  const hours = dist / 1000 / opt.speedKmh + climb / 400;
  const elevs = profile.map((p) => p.elev);

  return {
    ...opt,
    path,
    profile,
    distanceM: dist,
    hours,
    climbM: climb,
    maxSlopeDeg: maxSlope,
    maxElevM: Math.max(...elevs),
    minElevM: Math.min(...elevs),
    kcal: Math.round((hours * 280 + climb * 1.5) / 10) * 10,
    o2L: Math.round(hours * opt.o2LPerHour),
    radiationUSv: hours * SURFACE_RADIATION_USV_PER_H * opt.radiationFactor,
  };
}

routeFindBtn.addEventListener("click", () => {
  if (!REGIONS[currentRegion]) {
    setRouteMsg("이 지역은 아직 지도 데이터가 없어요.", true);
    return;
  }
  const missing = nav.stops.findIndex((s) => !s.lonLat);
  if (missing !== -1) {
    setRouteMsg(`${stopLabel(nav.stops[missing], missing)}를 입력하거나 지도에서 선택하세요.`, true);
    return;
  }

  const points = nav.stops.map((s) => s.lonLat);
  nav.results = ROUTE_OPTIONS.map((opt) => buildDemoRoute(opt, points));
  nav.selectedId = nav.results[0].id;
  setRouteMsg("※ 데모 결과예요. 실제 길찾기 알고리즘은 아직 적용되지 않았어요.");
  renderResults();
  renderNavMap();
  fitNavRoutes();
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
      ["소모 칼로리", `${r.kcal.toLocaleString()} kcal`],
      ["소모 산소", `${r.o2L.toLocaleString()} L`],
      ["방사선 노출", `${r.radiationUSv.toFixed(1)} μSv`],
      ["최고 고도", formatElev(r.maxElevM)],
      ["최대 경사", `${r.maxSlopeDeg.toFixed(1)}°`],
      ["누적 오르막", `${Math.round(r.climbM)} m`],
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
