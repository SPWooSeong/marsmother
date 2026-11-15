// Mars Mother
// TODO: 메뉴 슬라이드 창, HUD 모드 전환, 위성/2D 전환, 내 위치 기능

// ---------- 지도 (확대/축소, 이동, 축척) ----------
// 지역 정보(REGIONS)와 포인트 데이터는 js/data/points.js 에 있음
let currentRegion = "gusev";
// 기본 지도: Columbia Hills 가시광 모자이크 (HiRISE · CTX · HRSC) 축소본 (가로 약 29.99 km)
const MAP_WIDTH_M = REGIONS.gusev.widthM;

const mapEl = document.getElementById("map");
const mapLayer = document.getElementById("map-layer");
const mapImage = document.getElementById("map-image");
const scaleLabel = document.getElementById("scale-label");
const scaleLine = document.getElementById("scale-line");

const view = { x: 0, y: 0, scale: 1, fitScale: 1, minScale: 0.1, maxScale: 10 };

function applyView() {
  mapLayer.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  mapLayer.style.setProperty("--inv-scale", 1 / view.scale); // 경로선 굵기를 화면 기준으로 유지
  updateScaleBar();
  positionPins();
  scheduleTiles();
  if (typeof scheduleScienceLayers === "function") scheduleScienceLayers(); // 과학 레이어 (layers.js)
  if (typeof positionLocPatch === "function") positionLocPatch(); // 위치 추정용 고해상도 패치 (localize.js)
}

// ---------- 화성 전체 배경 지도 (NASA Mars Trek 타일) ----------
// 등장방형(경위도) 타일이라 우리 지도 좌표(경위도 비례)와 그대로 맞음.
// 레벨 z: 가로 2^(z+1) × 세로 2^z 장, 한 장 = 180/2^z 도, 최대 레벨 7
const BASEMAP_URL =
  "https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg";
const BASEMAP_MAX_Z = 7;
const BASEMAP_TILE_PX = 256;
const tilesEl = document.getElementById("map-tiles");
const tileEls = new Map(); // key → <img>
let tilesScheduled = false;

function scheduleTiles() {
  if (tilesScheduled) return;
  tilesScheduled = true;
  requestAnimationFrame(() => {
    tilesScheduled = false;
    renderTiles();
  });
}

function renderTiles() {
  if (!mapImage.naturalWidth) return;
  // 지도 사진(Gusev)의 경위도 범위를 기준으로 화면 좌표 계산
  const b = REGIONS.gusev.bounds;
  const pxPerDegX = (mapImage.naturalWidth / (b.lonMax - b.lonMin)) * view.scale;
  const pxPerDegY = (mapImage.naturalHeight / (b.latMax - b.latMin)) * view.scale;
  const lonToX = (lon) => view.x + (lon - b.lonMin) * pxPerDegX;
  const latToY = (lat) => view.y + (b.latMax - lat) * pxPerDegY;

  const W = mapEl.clientWidth;
  const H = mapEl.clientHeight;
  const lonL = b.lonMin - view.x / pxPerDegX;
  const lonR = b.lonMin + (W - view.x) / pxPerDegX;
  const latT = Math.min(90, b.latMax + view.y / pxPerDegY);
  const latB = Math.max(-90, b.latMax - (H - view.y) / pxPerDegY);

  // 화면 해상도에 맞는 레벨 + 그 아래 저해상도 레벨(불러오는 동안 바탕용)
  const ideal = Math.ceil(Math.log2((pxPerDegX * 180) / BASEMAP_TILE_PX));
  const z = Math.max(0, Math.min(BASEMAP_MAX_Z, ideal));
  const levels = z >= 3 ? [z - 3, z] : [z];

  const needed = new Set();
  for (const lz of levels) {
    const deg = 180 / 2 ** lz;
    const cols = 2 ** (lz + 1);
    const rows = 2 ** lz;
    const c0 = Math.floor((lonL + 180) / deg);
    const c1 = Math.min(Math.floor((lonR + 180) / deg), c0 + cols * 2); // 너무 축소해도 두 바퀴까지만
    const r0 = Math.max(0, Math.floor((90 - latT) / deg));
    const r1 = Math.min(rows - 1, Math.floor((90 - latB) / deg));

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const wrapped = ((c % cols) + cols) % cols; // 경도 180° 넘어가면 반대편 타일 사용
        const key = `${lz}/${r}/${c}`;
        needed.add(key);

        let img = tileEls.get(key);
        if (!img) {
          img = document.createElement("img");
          img.className = "map__tile";
          img.alt = "";
          img.draggable = false;
          img.decoding = "async";
          img.style.zIndex = String(lz);
          img.onerror = () => (img.style.visibility = "hidden");
          img.src = BASEMAP_URL.replace("{z}", lz).replace("{y}", r).replace("{x}", wrapped);
          tilesEl.append(img);
          tileEls.set(key, img);
        }
        const lon0 = -180 + c * deg;
        const lat0 = 90 - r * deg;
        const x = lonToX(lon0);
        const y = latToY(lat0);
        img.style.transform = `translate(${x}px, ${y}px)`;
        img.style.width = `${deg * pxPerDegX + 0.5}px`; // 이음새 틈 방지
        img.style.height = `${deg * pxPerDegY + 0.5}px`;
      }
    }
  }

  // 화면에 필요 없는 타일 정리
  for (const [key, img] of tileEls) {
    if (!needed.has(key)) {
      img.remove();
      tileEls.delete(key);
    }
  }
}

window.addEventListener("resize", scheduleTiles);

// ---------- 지역 이동 (탐색 지역 선택 시 부드럽게 날아가기) ----------
let flyAnim = null;

function cancelMapFly() {
  if (flyAnim) cancelAnimationFrame(flyAnim);
  flyAnim = null;
}

// 경위도 → 지도 사진(Gusev) 픽셀 좌표 (사진 바깥도 같은 비율로 이어짐)
function geoToImagePx(lon, lat) {
  const b = REGIONS.gusev.bounds;
  return {
    x: ((lon - b.lonMin) / (b.lonMax - b.lonMin)) * mapImage.naturalWidth,
    y: ((b.latMax - lat) / (b.latMax - b.latMin)) * mapImage.naturalHeight,
  };
}

// 지역의 중심(사진 픽셀)과 그 지역이 화면에 맞게 보이는 배율
function regionTarget(region) {
  const W = mapEl.clientWidth;
  const H = mapEl.clientHeight;
  if (REGIONS[region]) {
    // 지도 사진이 있는 지역: 사진 전체가 화면에 맞게
    const w = mapImage.naturalWidth;
    const h = mapImage.naturalHeight;
    return { cx: w / 2, cy: h / 2, scale: Math.min(W / w, H / h) };
  }
  const c = REGION_CENTERS[region];
  if (!c) return null;
  const pxPerKm = mapImage.naturalWidth / (REGIONS.gusev.widthM / 1000);
  const { x, y } = geoToImagePx(c.lon, c.lat);
  return { cx: x, cy: y, scale: Math.min(W, H) / (c.spanKm * pxPerKm) };
}

// 현재 화면 → 목표 지역으로 이동. 멀리 갈 때는 중간에 축소했다가 다시 확대
function flyMapTo(target, ms = 1800) {
  cancelMapFly();
  const W = mapEl.clientWidth;
  const H = mapEl.clientHeight;
  const s0 = view.scale;
  const c0 = { x: (W / 2 - view.x) / s0, y: (H / 2 - view.y) / s0 };
  const s1 = target.scale;
  const c1 = { x: target.cx, y: target.cy };

  // 배경 지도는 경도 360°마다 반복되므로, 출발점을 목표와 가장 가까운 '같은 위치'로 옮겨
  // 짧은 쪽(예: 경도 180° 너머)으로 날아가게 함. 화면은 똑같아 보여서 티가 나지 않음
  const b = REGIONS.gusev.bounds;
  const period = (360 / (b.lonMax - b.lonMin)) * mapImage.naturalWidth;
  c0.x += Math.round((c1.x - c0.x) / period) * period;

  // 출발지와 도착지가 한 화면에 같이 들어오는 배율까지 잠깐 축소
  const dist = Math.hypot(c1.x - c0.x, c1.y - c0.y);
  const sMid = Math.min(s0, s1, (Math.min(W, H) * 0.9) / Math.max(dist, 1));
  view.minScale = Math.min(view.minScale, sMid, s1);

  const start = performance.now();
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const logLerp = (a, b, t) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);

  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const e = ease(t);
    // 배율: 앞 절반은 s0→sMid, 뒤 절반은 sMid→s1 (로그 보간이라 확대/축소 속도가 일정해 보임)
    const scale = t < 0.5 ? logLerp(s0, sMid, ease(t * 2)) : logLerp(sMid, s1, ease(t * 2 - 1));
    const cx = c0.x + (c1.x - c0.x) * e;
    const cy = c0.y + (c1.y - c0.y) * e;
    view.scale = scale;
    view.x = W / 2 - cx * scale;
    view.y = H / 2 - cy * scale;
    applyView();
    flyAnim = t < 1 ? requestAnimationFrame(step) : null;
  };
  flyAnim = requestAnimationFrame(step);
}

document.addEventListener("regionchange", () => {
  const target = regionTarget(currentRegion);
  if (target && mapImage.naturalWidth) flyMapTo(target);
});

// 사용자가 지도를 직접 움직이면 이동 애니메이션 중단
mapEl.addEventListener("pointerdown", cancelMapFly);
mapEl.addEventListener("wheel", cancelMapFly, { passive: true });

// 화면 1px이 몇 m인지 계산해서 1·2·5 단위의 보기 좋은 길이로 축척 막대 표시
function updateScaleBar() {
  if (!mapImage.naturalWidth) return;
  const metersPerPx = MAP_WIDTH_M / mapImage.naturalWidth / view.scale;
  const maxBarPx = 120;
  const raw = metersPerPx * maxBarPx;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const nice = [5, 2, 1].map((n) => n * pow).find((n) => n <= raw);

  scaleLine.style.width = `${nice / metersPerPx}px`;
  scaleLabel.textContent = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
}

// 지도 전체가 화면에 들어오도록 맞추기
function fitMap() {
  const w = mapImage.naturalWidth;
  const h = mapImage.naturalHeight;
  const fit = Math.min(mapEl.clientWidth / w, mapEl.clientHeight / h);
  view.scale = fit;
  view.fitScale = fit;
  view.minScale = fit / 700; // 화성 전체가 보일 만큼 축소 가능
  view.maxScale = fit * 40; // 화면 가로에 약 750 m 까지 확대
  view.x = (mapEl.clientWidth - w * fit) / 2;
  view.y = (mapEl.clientHeight - h * fit) / 2;
  applyView();
}

// (cx, cy) 화면 지점을 기준으로 확대/축소
function zoomAt(factor, cx, cy) {
  const next = Math.min(view.maxScale, Math.max(view.minScale, view.scale * factor));
  const ratio = next / view.scale;
  view.x = cx - (cx - view.x) * ratio;
  view.y = cy - (cy - view.y) * ratio;
  view.scale = next;
  applyView();
}

// 마우스 휠 / 트랙패드 핀치로 확대·축소
function onMapWheel(e) {
  e.preventDefault();
  const rect = mapEl.getBoundingClientRect();
  zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX - rect.left, e.clientY - rect.top);
}
mapEl.addEventListener("wheel", onMapWheel, { passive: false });

// 더블클릭으로 2배 확대
mapEl.addEventListener("dblclick", (e) => {
  const rect = mapEl.getBoundingClientRect();
  zoomAt(2, e.clientX - rect.left, e.clientY - rect.top);
});

// 드래그로 이동 (터치는 두 손가락으로 확대·축소)
const pointers = new Map();
let lastPinchDist = 0;

mapEl.addEventListener("pointerdown", (e) => {
  mapEl.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  mapEl.classList.add("is-dragging");
});

mapEl.addEventListener("pointermove", (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;

  if (pointers.size === 1) {
    view.x += e.clientX - prev.x;
    view.y += e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    applyView();
    return;
  }

  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const [a, b] = [...pointers.values()];
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  if (lastPinchDist) {
    const rect = mapEl.getBoundingClientRect();
    zoomAt(dist / lastPinchDist, (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
  }
  lastPinchDist = dist;
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  lastPinchDist = 0;
  if (pointers.size === 0) mapEl.classList.remove("is-dragging");
}
mapEl.addEventListener("pointerup", endPointer);
mapEl.addEventListener("pointercancel", endPointer);

// ---------- 로버 경로에 마우스를 올리면: 로버가 그 자리를 지난 때 (sol · 지구 날짜) ----------
// 주행 기록의 점마다 sol 이 있음 (js/data/spirit.js). Spirit 착륙 2004-01-04 04:35 UTC = sol 1, 1솔 = 88,775.244초
const SPIRIT_LANDING_MS = Date.UTC(2004, 0, 4, 4, 35);
const routeTip = document.createElement("div");
routeTip.className = "route-tip";
routeTip.hidden = true;
mapEl.append(routeTip);

mapEl.addEventListener("pointermove", (e) => {
  let best = null;
  const overMap = e.target === mapEl || mapEl.contains(e.target);
  if (overMap && pointers.size === 0 && currentRegion === "gusev" && !hiddenPoints.has("spirit-route") && mapImage.naturalWidth) {
    const rect = mapEl.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let bestD = 10 * 10; // 화면에서 10px 안
    for (const pt of SPIRIT_TRAVERSE.path) {
      const { x, y } = lonLatToImage(pt[0], pt[1]);
      const dx = view.x + x * view.scale - mx, dy = view.y + y * view.scale - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = pt;
      }
    }
    if (best) {
      const date = new Date(SPIRIT_LANDING_MS + (best[2] - 1) * 88775244);
      routeTip.textContent = `Spirit · sol ${best[2]} · ${date.toISOString().slice(0, 10)}`;
      routeTip.style.left = `${mx + 14}px`;
      routeTip.style.top = `${my - 10}px`;
    }
  }
  routeTip.hidden = !best;
});
mapEl.addEventListener("pointerleave", () => (routeTip.hidden = true));

// ---------- 포인트 (핀 / 경로 / 추가) ----------
const SVG_NS = "http://www.w3.org/2000/svg";
const pinsEl = document.getElementById("map-pins");
const routesSvg = document.getElementById("map-routes");
const pointListEl = document.getElementById("point-list");
const pointRegionName = document.getElementById("point-region-name");
const addPointBtn = document.getElementById("add-point-btn");
const addHint = document.getElementById("add-hint");
const pointDialog = document.getElementById("point-dialog");
const pointForm = document.getElementById("point-form");
const pointDialogCoords = document.getElementById("point-dialog-coords");
const pointCancelBtn = document.getElementById("point-cancel-btn");

let selectedPointId = null;
let pendingLonLat = null;

// 사용자가 추가한 포인트는 브라우저(localStorage)에 지역별로 저장
const storageKey = (region) => `marsmother.points.${region}`;

// 단, 기지는 저장하지 않음 — 이번 접속 동안만 유지되고 새로고침하면 사라짐
const sessionBases = {}; // region → 기지 포인트들

function loadCustomPoints(region) {
  let stored = [];
  try {
    const points = JSON.parse(localStorage.getItem(storageKey(region))) || [];
    // 없어진 종류(예: 예전 '주요 지점')로 저장된 포인트는 '내 포인트'로
    stored = points.map((p) => (POINT_TYPES[p.type] ? p : { ...p, type: "custom" }));
  } catch {
    // 저장된 값이 없거나 깨짐
  }
  return [...stored.filter((p) => p.type !== "base"), ...(sessionBases[region] || [])];
}

function saveCustomPoints(region, points) {
  sessionBases[region] = points.filter((p) => p.type === "base");
  try {
    localStorage.setItem(storageKey(region), JSON.stringify(points.filter((p) => p.type !== "base")));
  } catch {
    // 저장소를 쓸 수 없는 환경(시크릿 모드 등)에서는 이번 접속 동안만 유지
  }
}

// 지도에서 숨긴 포인트 (포인트 탭에서 각각 토글, id 기준)
const HIDDEN_POINTS_KEY = "marsmother.hiddenPoints";
const hiddenPoints = new Set(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(HIDDEN_POINTS_KEY)) || [];
    } catch {
      return [];
    }
  })()
);

function setPointsVisible(ids, visible) {
  for (const id of ids) {
    if (visible) hiddenPoints.delete(id);
    else hiddenPoints.add(id);
  }
  try {
    localStorage.setItem(HIDDEN_POINTS_KEY, JSON.stringify([...hiddenPoints]));
  } catch {
    // 저장 실패 시 이번 접속 동안만 유지
  }
  renderPointList();
  renderMapOverlays();
}

// 포인트 탭에서 펼쳐 둔 그룹 (기본은 모두 접힘)
const EXPANDED_GROUPS_KEY = "marsmother.expandedGroups";
const expandedGroups = new Set(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(EXPANDED_GROUPS_KEY)) || [];
    } catch {
      return [];
    }
  })()
);

function saveExpandedGroups() {
  try {
    localStorage.setItem(EXPANDED_GROUPS_KEY, JSON.stringify([...expandedGroups]));
  } catch {
    // 저장 실패 시 이번 접속 동안만 유지
  }
}

function getPoints() {
  return [...(REGION_POINTS[currentRegion] || []), ...loadCustomPoints(currentRegion)];
}

// 경위도 ↔ 지도 이미지 픽셀 좌표 변환
// 지도 좌표 기준은 지금 깔린 지도 사진(Gusev). 사진이 없는 지역에서도 같은 기준으로 계산
function mapBounds() {
  return (REGIONS[currentRegion] || REGIONS.gusev).bounds;
}

function lonLatToImage(lon, lat) {
  const b = mapBounds();
  return {
    x: ((lon - b.lonMin) / (b.lonMax - b.lonMin)) * mapImage.naturalWidth,
    y: ((b.latMax - lat) / (b.latMax - b.latMin)) * mapImage.naturalHeight,
  };
}

function imageToLonLat(x, y) {
  const b = mapBounds();
  return {
    lon: b.lonMin + (x / mapImage.naturalWidth) * (b.lonMax - b.lonMin),
    lat: b.latMax - (y / mapImage.naturalHeight) * (b.latMax - b.latMin),
  };
}

function formatLonLat({ lon, lat }) {
  const ns = lat < 0 ? "S" : "N";
  const ew = lon < 0 ? "W" : "E";
  return `${Math.abs(lat).toFixed(4)}°${ns}, ${Math.abs(lon).toFixed(4)}°${ew}`;
}

function typeColor(type) {
  return (POINT_TYPES[type] || POINT_TYPES.custom).color;
}

// 지도 위에 핀과 경로 그리기
function renderMapOverlays() {
  pinsEl.replaceChildren();
  routesSvg.replaceChildren();
  if (!REGIONS[currentRegion] || !mapImage.naturalWidth) return;

  const w = mapImage.naturalWidth;
  const h = mapImage.naturalHeight;
  routesSvg.setAttribute("width", w);
  routesSvg.setAttribute("height", h);
  routesSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  for (const p of getPoints()) {
    if (hiddenPoints.has(p.id)) continue;

    if (p.path) {
      const line = document.createElementNS(SVG_NS, "polyline");
      line.setAttribute(
        "points",
        p.path.map(([lon, lat]) => {
          const { x, y } = lonLatToImage(lon, lat);
          return `${x},${y}`;
        }).join(" ")
      );
      line.setAttribute("stroke", typeColor(p.type));
      line.classList.add("map-route");
      line.dataset.id = p.id;
      routesSvg.append(line);
      continue;
    }

    const { x, y } = lonLatToImage(p.lon, p.lat);
    const pin = document.createElement("button");
    pin.className = "map-pin";
    pin.dataset.id = p.id;
    pin.dataset.x = x;
    pin.dataset.y = y;
    pin.style.setProperty("--pin-color", typeColor(p.type));
    pin.setAttribute("aria-label", p.name);

    const head = document.createElement("span");
    head.className = "map-pin__head";
    const label = document.createElement("span");
    label.className = "map-pin__label";
    label.textContent = p.name;
    pin.append(head, label);

    // 사진 위치: 핀 위에 작은 사진 표시
    if (p.photo) {
      pin.classList.add("has-photo");
      const thumb = document.createElement("img");
      thumb.className = "map-pin__photo";
      thumb.src = p.photo;
      thumb.alt = "";
      thumb.draggable = false;
      pin.append(thumb);
    }

    pin.addEventListener("click", () => {
      // 지도에서 위치를 고르는 중이면 이 포인트의 위치를 선택한 것으로 처리
      if (mapPick) {
        const { onPick } = mapPick;
        endMapPick();
        onPick({ lon: p.lon, lat: p.lat }, p);
        return;
      }
      // 오른쪽 정보 창에 그 포인트의 설명 + 과학 데이터 (사진 · 파노라마는 창 안의 버튼으로) — js/inspect.js
      selectPoint(p.id);
      openInspect({ lon: p.lon, lat: p.lat }, p);
    });
    pinsEl.append(pin);
  }

  positionPins();
  highlightSelected();
}

// 핀은 크기 고정, 위치만 현재 확대/이동 상태에 맞춰 갱신
function positionPins() {
  if (!pinsEl) return;
  // .map-pins: 포인트 핀, #nav-pins: 길찾기 출발/도착/경유지 표시
  for (const pin of document.querySelectorAll(".map-pins > *")) {
    pin.style.left = `${view.x + pin.dataset.x * view.scale}px`;
    pin.style.top = `${view.y + pin.dataset.y * view.scale}px`;
  }
}

// 포인트 탭 목록 그리기 (종류별 그룹)
function renderPointList() {
  const region = REGIONS[currentRegion];
  pointRegionName.textContent = region ? region.name : regionName.textContent;
  addPointBtn.disabled = !region;
  pointListEl.replaceChildren();

  if (!region) {
    const empty = document.createElement("p");
    empty.className = "drawer__empty";
    empty.textContent = "이 지역은 아직 지도·포인트 데이터가 없어요.";
    pointListEl.append(empty);
    return;
  }

  const points = getPoints();
  for (const [type, meta] of Object.entries(POINT_TYPES)) {
    const items = points.filter((p) => p.type === type);

    const ids = items.map((p) => p.id);
    const visibleCount = ids.filter((id) => !hiddenPoints.has(id)).length;

    const group = document.createElement("section");
    group.className = "point-group";
    const expanded = expandedGroups.has(type);
    group.classList.toggle("is-collapsed", !expanded);

    // 그룹 제목: 누르면 접기/펼치기
    const title = document.createElement("div");
    title.className = "point-group__title";
    title.style.setProperty("--pin-color", meta.color);
    const titleText = document.createElement("button");
    titleText.className = "point-group__fold";
    titleText.setAttribute("aria-expanded", String(expanded));
    titleText.textContent = `${meta.label} (${items.length})`;
    titleText.addEventListener("click", () => {
      const open = !expandedGroups.has(type);
      if (open) expandedGroups.add(type);
      else expandedGroups.delete(type);
      saveExpandedGroups();
      group.classList.toggle("is-collapsed", !open);
      titleText.setAttribute("aria-expanded", String(open));
    });

    // 그룹 제목의 체크박스 = 그룹 전체 켜기/끄기 (일부만 켜져 있으면 '-' 표시)
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "point-group__toggle";
    toggle.checked = items.length > 0 && visibleCount === items.length;
    toggle.indeterminate = visibleCount > 0 && visibleCount < items.length;
    toggle.disabled = !items.length;
    toggle.setAttribute("aria-label", `${meta.label} 전체 지도에 표시`);
    toggle.addEventListener("change", () => setPointsVisible(ids, toggle.checked));
    title.append(titleText, toggle);

    const ul = document.createElement("ul");
    for (const p of items) {
      const li = document.createElement("li");
      const shown = !hiddenPoints.has(p.id);
      li.className = "point-item";
      li.classList.toggle("is-off", !shown);
      li.dataset.id = p.id;
      li.style.setProperty("--pin-color", meta.color);

      const btn = document.createElement("button");
      btn.className = "point-item__main";
      const name = document.createElement("span");
      name.className = "point-item__name";
      name.textContent = p.name;
      const sub = document.createElement("span");
      sub.className = "point-item__sub";
      sub.textContent = p.note || (p.path ? `경로 · ${p.path.length}개 지점` : formatLonLat(p));
      btn.append(name, sub);
      btn.addEventListener("click", () => {
        // 꺼진 포인트를 누르면 다시 켜서 보여줌 (목록이 다시 그려지므로 펼침 상태는 유지됨)
        if (hiddenPoints.has(p.id)) setPointsVisible([p.id], true);
        selectPoint(p.id);
        focusPoint(p);
        setDrawerOpen(false);
      });

      // 포인트별 지도 표시 토글
      const itemToggle = document.createElement("input");
      itemToggle.type = "checkbox";
      itemToggle.className = "point-item__toggle";
      itemToggle.checked = shown;
      itemToggle.setAttribute("aria-label", `${p.name} 지도에 표시`);
      itemToggle.addEventListener("change", () => setPointsVisible([p.id], itemToggle.checked));

      li.append(btn, itemToggle);

      if (p.custom) {
        const del = document.createElement("button");
        del.className = "point-item__delete";
        del.textContent = "×";
        del.setAttribute("aria-label", `${p.name} 삭제`);
        del.addEventListener("click", () => deleteCustomPoint(p.id));
        li.append(del);
      }
      ul.append(li);
    }

    if (!items.length) {
      const none = document.createElement("li");
      none.className = "point-item__none";
      none.textContent = "등록된 포인트 없음";
      ul.append(none);
    }

    group.append(title, ul);
    pointListEl.append(group);
  }
  highlightSelected();
}

function selectPoint(id) {
  selectedPointId = id;
  highlightSelected();
}

function highlightSelected() {
  document.querySelectorAll(".map-pin, .map-route, .point-item").forEach((el) => {
    el.classList.toggle("is-selected", el.dataset.id === selectedPointId);
  });
}

// 선택한 포인트(또는 경로 전체)가 화면 가운데 보이도록 이동
function focusPoint(p) {
  const coords = (p.path || [[p.lon, p.lat]]).map(([lon, lat]) => lonLatToImage(lon, lat));
  const xs = coords.map((c) => c.x);
  const ys = coords.map((c) => c.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const bw = maxX - minX, bh = maxY - minY;

  let scale = view.fitScale * 4;
  if (bw > 1 || bh > 1) {
    scale = Math.min(mapEl.clientWidth / (bw * 1.6), mapEl.clientHeight / (bh * 1.6));
  }
  view.scale = Math.min(view.maxScale, Math.max(view.minScale, scale));
  view.x = mapEl.clientWidth / 2 - ((minX + maxX) / 2) * view.scale;
  view.y = mapEl.clientHeight / 2 - ((minY + maxY) / 2) * view.scale;
  applyView();
}

function deleteCustomPoint(id) {
  saveCustomPoints(currentRegion, loadCustomPoints(currentRegion).filter((p) => p.id !== id));
  if (selectedPointId === id) selectedPointId = null;
  renderPointList();
  renderMapOverlays();
  document.dispatchEvent(new CustomEvent("pointschange"));
}

// 기지 포인트 (통신 가시성 · 안전 귀환 기준 · HUD 기지 건물)
function getBases() {
  return getPoints().filter((p) => p.type === "base" && p.lon != null && p.lat != null);
}

// 지도에서 위치 하나 고르기 (포인트 추가, 길찾기 출발/도착지 등에서 공용)
// onPick(lonLat): 클릭한 위치, onCancel(): Esc로 취소했을 때
let mapPick = null;

function startMapPick(message, onPick, onCancel) {
  mapPick = { onPick, onCancel };
  addHint.firstChild.textContent = `${message} · `;
  addHint.hidden = false;
  mapEl.classList.add("is-adding");
}

function endMapPick() {
  mapPick = null;
  addHint.hidden = true;
  mapEl.classList.remove("is-adding");
}

// 포인트 추가: 버튼 → 지도 클릭 → 이름/종류 입력
addPointBtn.addEventListener("click", () => {
  setDrawerOpen(false);
  startMapPick("지도에서 추가할 위치를 클릭하세요", (lonLat) => {
    pendingLonLat = lonLat;
    pointForm.reset();
    pointDialogCoords.textContent = formatLonLat(lonLat);
    pointDialog.showModal();
  });
});

let downPos = null;
mapEl.addEventListener("pointerdown", (e) => {
  downPos = { x: e.clientX, y: e.clientY };
});

mapEl.addEventListener("pointerup", (e) => {
  if (!mapPick || !downPos) return;
  // 드래그(지도 이동)는 무시하고 '클릭'만 위치 선택으로 처리
  if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 5) return;

  const rect = mapEl.getBoundingClientRect();
  const ix = (e.clientX - rect.left - view.x) / view.scale;
  const iy = (e.clientY - rect.top - view.y) / view.scale;
  if (ix < 0 || iy < 0 || ix > mapImage.naturalWidth || iy > mapImage.naturalHeight) return;

  const { onPick } = mapPick;
  endMapPick();
  onPick(imageToLonLat(ix, iy));
});

pointCancelBtn.addEventListener("click", () => pointDialog.close("cancel"));

pointDialog.addEventListener("close", () => {
  if (pointDialog.returnValue !== "save" || !pendingLonLat) return;

  const data = new FormData(pointForm);
  const point = {
    id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: data.get("type"),
    name: data.get("name").trim() || "새 포인트",
    note: data.get("note").trim(),
    lon: pendingLonLat.lon,
    lat: pendingLonLat.lat,
    custom: true,
  };
  saveCustomPoints(currentRegion, [...loadCustomPoints(currentRegion), point]);
  pendingLonLat = null;
  pointDialog.returnValue = "";

  renderPointList();
  renderMapOverlays();
  selectPoint(point.id);
  document.dispatchEvent(new CustomEvent("pointschange"));
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && mapPick) {
    const { onCancel } = mapPick;
    endMapPick();
    onCancel?.();
  }
});

// ---------- 사진 뷰어 (360° 파노라마 + 그 외 사진) ----------
const photoViewer = document.getElementById("photo-viewer");
const pvTitle = document.getElementById("pv-title");
const pvNote = document.getElementById("pv-note");
const pvClose = document.getElementById("pv-close");
const panoView = document.getElementById("pano-view");
const panoHeading = document.getElementById("pano-heading");
const panoPlay = document.getElementById("pano-play");
const panoSlider = document.getElementById("pano-slider");
const panoFull = document.getElementById("pano-full");
const pvGalleryTitle = document.getElementById("pv-gallery-title");
const pvGallery = document.getElementById("pv-gallery");
const pvLightbox = document.getElementById("pv-lightbox");
const pvLightboxImg = document.getElementById("pv-lightbox-img");

// heading: 화면 가운데가 바라보는 방향 (0~360°, 0 = 북쪽 = 파노라마 왼쪽 끝)
// wrap: true = 좌우로 이어지는 360° 파노라마, false = 좌우 끝이 있는 사진 (끝까지만 움직임)
// photo: true = 로버 사진 (방위를 모르므로 N/E/S/W 표시 안 함)
const pano = { heading: 0, aspect: 5, raf: null, lastTime: 0, wrap: true, photo: false, dir: 1 };
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const AUTO_ROTATE_DEG_PER_SEC = 12; // 자동 회전 속도
const PANO_WRAP_MIN_ASPECT = 3; // 로버 사진: 가로/세로가 이 이상이면 360° 처럼 이어서 돌림

const pvPano = document.getElementById("pv-pano");
const panoBadge = document.getElementById("pano-badge");
const PANO_DEM_BADGE = panoBadge.textContent;

// 파노라마 이미지 바꾸기
function setPanoImage(src, { aspect, wrap = true, photo = false, badge = PANO_DEM_BADGE } = {}) {
  stopAutoRotate();
  pano.wrap = wrap;
  pano.photo = photo;
  pano.dir = 1;
  pvPano.classList.toggle("is-photo", photo);
  panoBadge.textContent = badge;
  panoView.style.backgroundImage = `url("${src}")`;
  panoView.style.backgroundRepeat = wrap ? "repeat-x" : "no-repeat";
  if (aspect) pano.aspect = aspect;
  const img = new Image();
  img.onload = () => {
    pano.aspect = img.naturalWidth / img.naturalHeight;
    setPanoHeading(pano.heading);
  };
  img.src = src;
  setPanoHeading(wrap ? 0 : 180);
}

// 로버 사진 한 장을 파노라마로
function showRoverPano(ph) {
  const aspect = ph.width / ph.height;
  setPanoImage(ph.src, {
    aspect,
    wrap: aspect >= PANO_WRAP_MIN_ASPECT,
    photo: true,
    badge: `${ph.camera} 사진 · ${ph.id} · sol ${ph.sol}`,
  });
  for (const el of pvGallery.querySelectorAll(".gallery__item")) {
    el.classList.toggle("is-active", el.dataset.src === ph.src);
  }
}

// media 형식 두 가지
//  - { panorama, gallery: [src] }  : DEM 지형 시점 + 궤도 사진 (사진 위치 포인트)
//  - { photos: [{ camera, id, sol, src, thumb, color, width, height, page, note }], pano } :
//      로버가 실제로 찍은 사진 (로버 사진 핀). 위 = photos[pano] 를 파노라마로, 아래 썸네일을 누르면 바꿔 보기
function openPhotoViewer(point) {
  const { panorama, gallery = [], photos } = point.media;
  pvTitle.textContent = point.name;
  pvNote.textContent = `${point.note ? point.note + " · " : ""}${formatLonLat(point)}`;

  // 아래: 그 외 사진
  const items = photos
    ? photos.map((ph) => ({
        src: ph.src,
        thumb: ph.thumb,
        color: ph.color,
        caption: `${ph.camera} · ${ph.id} · sol ${ph.sol}${ph.note ? ` · ${ph.note}` : ""}`,
        page: ph.page,
        onClick: () => showRoverPano(ph),
      }))
    : gallery.map((src) => ({ src, thumb: src }));
  if (photos) {
    pvGalleryTitle.textContent = `Spirit Cam · Pancam / Navcam · NASA Photojournal (${items.filter((it) => it.src).length})`;
    pvGalleryTitle.hidden = false;
  } else {
    pvGalleryTitle.textContent = `궤도 사진 · 가시광 모자이크 0.25 m/px (${items.length})`;
    pvGalleryTitle.hidden = !gallery.length; // 지점 조사(js/inspect.js)의 즉석 파노라마는 궤도 사진이 없음
  }
  pvGallery.classList.toggle("gallery__grid--wide", !!photos);
  pvGallery.replaceChildren(
    ...items.map((it, i) => {
      const fig = document.createElement("figure");
      fig.className = "gallery__cell";
      const btn = document.createElement("button");
      btn.className = "gallery__item";
      btn.classList.toggle("is-color", !!it.color);
      if (it.src) {
        btn.dataset.src = it.src;
        btn.setAttribute("aria-label", it.onClick ? `사진 ${i + 1} 파노라마로 보기` : `사진 ${i + 1} 크게 보기`);
        const thumb = document.createElement("img");
        thumb.src = it.thumb;
        thumb.alt = it.caption || "";
        thumb.loading = "lazy";
        btn.append(thumb);
        btn.addEventListener("click", () => {
          if (it.onClick) return it.onClick();
          pvLightboxImg.src = it.src;
          pvLightbox.classList.toggle("is-color", !!it.color);
          pvLightbox.hidden = false;
        });
      } else {
        // 원본 JPEG 가 없는 사진: 출처 페이지만 연결
        btn.disabled = true;
        btn.classList.add("is-missing");
        btn.textContent = "사진 파일 없음";
      }
      fig.append(btn);
      if (it.caption) {
        const cap = document.createElement("figcaption");
        cap.className = "gallery__caption";
        cap.append(it.caption + " ");
        if (it.page) {
          const a = document.createElement("a");
          a.href = it.page;
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = "출처 ↗";
          cap.append(a);
        }
        fig.append(cap);
      }
      return fig;
    })
  );
  pvLightbox.hidden = true;

  photoViewer.showModal();

  // 위: 파노라마 (dialog 가 열린 뒤에 크기를 재야 해서 showModal 다음)
  if (photos) {
    const first = photos[point.media.pano ?? 0];
    if (first?.src) showRoverPano(first);
  } else {
    setPanoImage(panorama);
  }
}

// 방향(°)에 맞춰 파노라마 위치를 옮김
//  - wrap  : 이미지가 좌우로 반복되므로 360° 이어짐
//  - !wrap : 0 = 사진 왼쪽 끝, 360 = 오른쪽 끝 (화면보다 좁은 사진은 가운데 고정)
function setPanoHeading(deg) {
  pano.heading = pano.wrap ? ((deg % 360) + 360) % 360 : Math.min(360, Math.max(0, deg));

  const fullW = panoView.clientHeight * pano.aspect; // 화면에 그려진 파노라마 한 바퀴 폭
  if (fullW) {
    if (pano.wrap) {
      const offset = (pano.heading / 360) * fullW - panoView.clientWidth / 2;
      panoView.style.backgroundPosition = `${-offset}px 0`;
    } else {
      const extra = fullW - panoView.clientWidth;
      const x = extra > 0 ? -(pano.heading / 360) * extra : -extra / 2;
      panoView.style.backgroundPosition = `${x}px 0`;
    }
    // 화면보다 좁은 사진은 움직일 수 없으므로 회전 조작 숨김
    const still = !pano.wrap && fullW <= panoView.clientWidth;
    if (still && pano.raf) stopAutoRotate();
    pvPano.classList.toggle("is-still", still);
  }

  const rounded = Math.round(pano.heading) % 360;
  panoSlider.value = String(Math.round(pano.heading));
  panoHeading.textContent = `${COMPASS[Math.round(rounded / 45) % 8]} ${rounded}°`;
}

// 드래그 1 px 이 몇 도인지: 360° 는 한 바퀴 폭, 끝이 있는 사진은 화면 밖으로 남는 폭 기준
function panoDegPerPx() {
  const fullW = panoView.clientHeight * pano.aspect;
  const span = pano.wrap ? fullW : fullW - panoView.clientWidth;
  return span > 0 ? 360 / span : 0;
}

// 드래그: 손가락/마우스를 움직인 만큼 회전 (한 바퀴 폭 = 360°)
let panoDrag = null;
panoView.addEventListener("pointerdown", (e) => {
  stopAutoRotate();
  panoView.setPointerCapture(e.pointerId);
  panoDrag = { x: e.clientX, heading: pano.heading };
  panoView.classList.add("is-dragging");
});
panoView.addEventListener("pointermove", (e) => {
  if (!panoDrag) return;
  setPanoHeading(panoDrag.heading - (e.clientX - panoDrag.x) * panoDegPerPx());
});
function endPanoDrag() {
  panoDrag = null;
  panoView.classList.remove("is-dragging");
}
panoView.addEventListener("pointerup", endPanoDrag);
panoView.addEventListener("pointercancel", endPanoDrag);

// 슬라이더: 0~360° 방향 선택
panoSlider.addEventListener("input", () => {
  stopAutoRotate();
  setPanoHeading(Number(panoSlider.value));
});

// 키보드 ← → 로도 회전
panoView.tabIndex = 0;
panoView.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") setPanoHeading(pano.heading - 10);
  if (e.key === "ArrowRight") setPanoHeading(pano.heading + 10);
});

// ▶ 자동 회전 (VR처럼 천천히 둘러보기)
function autoRotateFrame(time) {
  const dt = pano.lastTime ? (time - pano.lastTime) / 1000 : 0;
  pano.lastTime = time;
  setPanoHeading(pano.heading + dt * AUTO_ROTATE_DEG_PER_SEC * pano.dir);
  // 끝이 있는 사진: 끝에 닿으면 반대로
  if (!pano.wrap && (pano.heading >= 360 || pano.heading <= 0)) pano.dir = pano.heading >= 360 ? -1 : 1;
  pano.raf = requestAnimationFrame(autoRotateFrame);
}

function startAutoRotate() {
  pano.lastTime = 0;
  pano.raf = requestAnimationFrame(autoRotateFrame);
  panoPlay.textContent = "❚❚";
  panoPlay.setAttribute("aria-label", "자동 회전 멈춤");
}

function stopAutoRotate() {
  cancelAnimationFrame(pano.raf);
  pano.raf = null;
  panoPlay.textContent = "▶";
  panoPlay.setAttribute("aria-label", "자동 회전");
}

panoPlay.addEventListener("click", () => (pano.raf ? stopAutoRotate() : startAutoRotate()));

panoFull.addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else panoView.requestFullscreen?.();
});
document.addEventListener("fullscreenchange", () => setPanoHeading(pano.heading));

pvLightbox.addEventListener("click", () => (pvLightbox.hidden = true));
pvClose.addEventListener("click", () => photoViewer.close());
photoViewer.addEventListener("close", stopAutoRotate);
// 창 바깥(어두운 배경)을 누르면 닫기
photoViewer.addEventListener("click", (e) => {
  if (e.target === photoViewer) photoViewer.close();
});

// 핀 위에서도 휠로 확대/축소되도록
pinsEl.addEventListener("wheel", onMapWheel, { passive: false });

// ---------- 왼쪽 슬라이드 메뉴 ----------
const menuBtn = document.getElementById("menu-btn");
const drawer = document.getElementById("drawer");
const drawerBackdrop = document.getElementById("drawer-backdrop");
const drawerCloseBtn = document.getElementById("drawer-close-btn");

function setDrawerOpen(open) {
  drawer.classList.toggle("is-open", open);
  drawer.inert = !open;
  drawer.setAttribute("aria-hidden", String(!open));
  drawerBackdrop.hidden = !open;
  menuBtn.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("is-drawer-open", open); // 왼쪽 아래 HUD 창 등을 메뉴 옆으로 비켜 줌 (css)
}

menuBtn.addEventListener("click", () => setDrawerOpen(true));
drawerCloseBtn.addEventListener("click", () => setDrawerOpen(false));
// 메뉴를 연 채로 지도를 끌거나 확대할 수는 있고, 지도를 (끌지 않고) 클릭하면 메뉴가 닫힘. 그 밖에 닫기: × 버튼 · Esc
for (const el of [mapEl, document.getElementById("hud-scan")]) {
  let down = null;
  // 누를 때 메뉴가 열려 있었던 경우만 (지도에서 위치 고르기는 고른 뒤 메뉴를 다시 여므로 그건 닫지 않음)
  el.addEventListener("pointerdown", (e) => (down = drawer.classList.contains("is-open") ? { x: e.clientX, y: e.clientY } : null));
  el.addEventListener("pointerup", (e) => {
    const isClick = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
    down = null;
    if (isClick) setDrawerOpen(false);
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setDrawerOpen(false);
});

// 탭 전환 (길찾기 / 레이어 / 포인트 / 나의 정보)
const drawerTabs = drawer.querySelectorAll('[role="tab"]');

drawerTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    drawerTabs.forEach((t) => {
      const selected = t === tab;
      t.setAttribute("aria-selected", String(selected));
      document.getElementById(t.getAttribute("aria-controls")).hidden = !selected;
    });
  });
});
// 레이어 체크박스에 맞춰 지도 레이어 켜고 끄기: js/layers.js

// ---------- 탐색 지역 선택 ----------
const regionBtn = document.getElementById("region-btn");
const regionName = document.getElementById("region-name");
const regionList = document.getElementById("region-list");

function setRegionListOpen(open) {
  regionList.hidden = !open;
  regionBtn.setAttribute("aria-expanded", String(open));
}

regionBtn.addEventListener("click", () => setRegionListOpen(regionList.hidden));

regionList.addEventListener("click", (e) => {
  const item = e.target.closest("li");
  if (!item) return;

  regionList.querySelectorAll("li").forEach((li) => li.removeAttribute("aria-selected"));
  item.setAttribute("aria-selected", "true");
  regionName.textContent = item.textContent;
  setRegionListOpen(false);

  currentRegion = item.dataset.region;
  selectedPointId = null;
  renderPointList();
  renderMapOverlays();
  document.dispatchEvent(new CustomEvent("regionchange"));
  // TODO: item.dataset.region 에 맞는 지도 이미지 불러오기 (지금은 Gusev 지도만 있음)
});

// 목록 바깥을 누르거나 Esc를 누르면 닫기
document.addEventListener("click", (e) => {
  if (!e.target.closest(".region-select")) setRegionListOpen(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setRegionListOpen(false);
});

// ---------- HUD 창 (PiP) ----------
const hudWindow = document.getElementById("hud-window");
const hudCloseBtn = document.getElementById("hud-close-btn");
const hudToggleBtn = document.getElementById("hud-toggle-btn");
const hudResize = document.getElementById("hud-resize");
// HUD 창 높이를 CSS 변수로 알려 줌 → 그 위에 놓이는 버튼(현재 위치 보정)이 창과 겹치지 않게
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--hud-card-h", `${hudWindow.offsetHeight}px`);
}).observe(hudWindow);

function setHudVisible(visible) {
  hudWindow.hidden = !visible;
  hudToggleBtn.classList.toggle("is-active", visible);
  hudToggleBtn.setAttribute("aria-pressed", String(visible));
}

hudCloseBtn.addEventListener("click", () => setHudVisible(false));
hudToggleBtn.addEventListener("click", () => setHudVisible(hudWindow.hidden));

// 오른쪽 위 모서리를 끌어서 크기 조절
// (창이 왼쪽 아래에 고정돼 있으므로 오른쪽·위로 늘어남)
const MAX_RATIO = 0.6; // 화면의 60%까지만 커지게

hudResize.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  hudResize.setPointerCapture(e.pointerId);

  const startX = e.clientX;
  const startY = e.clientY;
  const startW = hudWindow.offsetWidth;
  const startH = hudWindow.offsetHeight;

  function onMove(ev) {
    const maxW = window.innerWidth * MAX_RATIO;
    const maxH = window.innerHeight * MAX_RATIO;
    const w = Math.min(maxW, startW + (ev.clientX - startX));
    const h = Math.min(maxH, startH - (ev.clientY - startY));
    hudWindow.style.width = `${w}px`;
    hudWindow.style.height = `${h}px`;
  }

  function onUp() {
    hudResize.removeEventListener("pointermove", onMove);
    hudResize.removeEventListener("pointerup", onUp);
    hudResize.removeEventListener("pointercancel", onUp);
  }

  hudResize.addEventListener("pointermove", onMove);
  hudResize.addEventListener("pointerup", onUp);
  hudResize.addEventListener("pointercancel", onUp);
});

// ---------- 시작 ----------
function initMap() {
  fitMap();
  renderMapOverlays();
}

renderPointList();
if (mapImage.complete && mapImage.naturalWidth) initMap();
else mapImage.addEventListener("load", initMap);
