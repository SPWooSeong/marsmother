// Mars Mother - HUD 모드 (AR)
// 왼쪽 아래 HUD 창을 누르면 1인칭 AR 화면으로 전환되고, 그 창은 2D 미니맵이 됨.
// 배경: data/ 의 실제 DEM(지형 높이) + 가시광 모자이크(표면 사진)로 그린 1인칭 3D 지형 (three.js).
//       발밑 3 km 는 HiRISE 2 m 격자, 그 밖 30 km 는 HiRISE 30 m, 지평선(400 km)은 MOLA.
//       3D를 쓸 수 없으면 360° 파노라마 사진으로 대신 표시.
// 지형 스캔(안전/주의/위험)은 실제 DEM 경사로 계산.
// 생체/장비 상태는 실제 지형 위를 걷는 만큼 js/eva.js 보행 모델로 계산 (산소 · 냉각수 · 전력 · 피로도),
// 방사선은 js/marstime.js 모델. 경로 안내는 길찾기 탭에서 고른 경로가 있을 때만 표시.
// 실제 장비가 생기면 바꿀 곳: 카메라 영상(배경), 방위 센서(hud.heading), 위치 장비(getCurrentPosition), 우주복 센서(evaState)
//
// 사용하는 전역 값: REGIONS, currentRegion, POINT_TYPES, getPoints, mapImage, lonLatToImage,
// formatLonLat (main.js) / getCurrentPosition, nav, DEG_TO_M (route.js)
// DEM_ORDER, DEM_LABELS, loadDemGrid, formatElevation (dem.js) / SCIENCE_LAYERS (data/layers.js)
// currentRadiation (marstime.js) / radiationRange (layers.js)

// ---------- 설정 ----------
const HUD_PANO = SITE_MEDIA.here.panorama; // 3D 를 못 그릴 때: 시작 위치에서 DEM 으로 그린 360° 지형 시점
const HORIZON_RATIO = 0.42; // 파노라마 사진에서 지평선 높이 (위에서부터 비율)
const EYE_HEIGHT_M = 1.7; // 눈높이
const SCAN_RANGE_M = 45; // 스캔 거리
const GRID_M = 1.6; // 스캔 격자 간격
const COMPASS_SPAN_DEG = 150; // 방위 표시줄에 보이는 각도 범위
const MINIMAP_ZOOM = 10; // 지도 사진 1px(약 33 m) → 미니맵 10px (가로 약 700 m 가 보임)

const HAZARD_COLORS = {
  safe: "76, 141, 255", // 파랑
  caution: "255, 216, 77", // 노랑
  danger: "255, 77, 77", // 빨강
};
const COMPASS_NAMES = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };

// ---------- 요소 ----------
const hudView = document.getElementById("hud-view");
const hudScene = document.getElementById("hud-scene");
const hudCanvas = document.getElementById("hud-scan");
const hudCtx = hudCanvas.getContext("2d");
const hudMarkersEl = document.getElementById("hud-markers");
const compassTape = document.getElementById("hud-compass-tape");
const hudHeadingEl = document.getElementById("hud-heading");
const hudCalloutsEl = document.getElementById("hud-callouts");
const hudAheadEl = document.getElementById("hud-ahead");
const hudVitalsEl = document.getElementById("hud-vitals");
const hudCardTitle = document.querySelector(".hud-card__title");
const hudPreview = document.getElementById("hud-btn");

const hud = {
  on: false,
  heading: 90, // 바라보는 방향 (0 = 북)
  pitch: -8, // 고개 각도 (°, + 위 / - 아래). 기본은 발밑이 보이게 살짝 아래
  aspect: 5, // 파노라마 가로/세로 비율
  raf: null,
  drag: null,
  lastCompassHeading: null,
  keys: new Set(), // 누르고 있는 키 (WASD, Shift, ←→)
  lastT: 0,
  bob: 0, // 걸을 때 화면 흔들림
  moving: false,
  world: { e: 0, n: 0 }, // 지역 중심 기준 내 위치 (m, 동/북)

};

// 파노라마 비율 읽기
const hudPanoImg = new Image();
hudPanoImg.onload = () => (hud.aspect = hudPanoImg.naturalWidth / hudPanoImg.naturalHeight);
hudPanoImg.src = HUD_PANO;
hudScene.style.backgroundImage = `url("${HUD_PANO}")`;

// ---------- 모드 전환 ----------
function setHudMode(on) {
  if (on) {
    setHudPeek(false);
    hud.drawerPeek = false;
    document.body.classList.remove("is-hud-drawer-peek");
  }
  hud.on = on;
  document.body.classList.toggle("is-hud", on);
  hudView.hidden = !on;
  hudCardTitle.textContent = on ? "2D 지도" : "HUD";
  hudPreview.setAttribute("aria-label", on ? "2D 지도로 돌아가기" : "HUD 모드로 전환");
  hudPreview.classList.toggle("is-minimap", on);
  hudMiniCanvas.hidden = !on;

  if (on) {
    setHudVisible(true); // HUD 창이 꺼져 있었다면 켜기 (돌아갈 버튼이므로)
    resizeHudCanvas();
    updateVitals();
    buildVitals();
    hud.lastCompassHeading = null;
    hud.lastT = 0;
    hud.keys.clear();
    syncWorldPosition();
    if (!hud.evaStart) {
      const here = getCurrentPosition();
      if (here) hud.evaStart = { lon: here.lon, lat: here.lat }; // 귀환 여유의 기준 (기지가 없을 때)
    }
    initTerrain3D(); // 처음 한 번 실제 지형(DEM) 불러오기 (비동기)
    resizeTerrain3D();
    hud.raf = requestAnimationFrame(hudFrame);
  } else {
    cancelAnimationFrame(hud.raf);
    hudPreview.removeAttribute("style");
    hud.keys.clear();
    if (typeof renderNavMap === "function") renderNavMap(); // 2D 지도의 현위치 갱신
  }
}

// HUD 모드에서 왼쪽 메뉴(≡)를 열면 2D 지도를 보여 주고, 메뉴를 닫으면 HUD 로 돌아감
function onDrawerToggle(open) {
  if (open) {
    if (hud.on) {
      setHudMode(false);
      hud.drawerPeek = true;
      document.body.classList.add("is-hud-drawer-peek"); // 메뉴를 연 동안 왼쪽 아래 HUD 창은 숨김 (css)
    }
  } else if (hud.drawerPeek) {
    setHudMode(true); // drawerPeek 는 setHudMode 가 꺼 줌
  }
}

// HUD 에서 왼쪽 아래 창을 누르면 2D 지도를 잠깐 보여 줌 (peek). 그 창을 닫거나(×) 다시 누르면 HUD 로 돌아감
const hudPeekCloseBtn = document.getElementById("hud-close-btn");
function setHudPeek(on) {
  hud.peek = on;
  document.body.classList.toggle("is-hud-peek", on);
  if (on) hudCardTitle.textContent = "HUD 로 돌아가기";
  hudPeekCloseBtn.setAttribute("aria-label", on ? "2D 지도 닫고 HUD 로 돌아가기" : "HUD 창 닫기");
  hudPeekCloseBtn.title = on ? "닫고 HUD 로 돌아가기" : "";
}

hudPreview.addEventListener("click", () => {
  if (hud.on) {
    setHudMode(false);
    setHudPeek(true);
  } else {
    setHudMode(true);
  }
});

// 2D 를 잠깐 보는 중이면 × 는 창을 숨기지 않고 HUD 로 돌아감 (main.js 의 '창 숨기기' 보다 먼저 처리)
hudPeekCloseBtn.addEventListener(
  "click",
  (e) => {
    if (!hud.peek) return;
    e.stopImmediatePropagation();
    setHudMode(true);
  },
  true
);

// 현재 위치 보정: 2D 지도의 ◎ 버튼과 같은 '지형 매칭 위치 추정' 창을 엶 (js/localize.js)
document.getElementById("hud-locate-btn").addEventListener("click", () => locBtn.click());

// 위치가 보정되면 HUD 의 내 위치 · 발밑 타일을 그곳으로
document.addEventListener("positionchange", () => {
  // 위치를 옮겨 새로 시작하면 (안내 시작 · 위치 보정) 그곳이 새 출발 지점
  const moved = getCurrentPosition();
  if (moved) hud.evaStart = { lon: moved.lon, lat: moved.lat };
  hudReturn.key = null;
  syncWorldPosition();
  if (hud3d.ready) resetHudTiles();
});

// ---------- 화면 계산 (원통형 파노라마 기준) ----------
function hudLayout() {
  const W = hudView.clientWidth;
  const H = hudView.clientHeight;
  if (hud3d.ready) {
    // 3D 카메라: 가로 시야각만 필요 (화면 좌표는 projectRel 이 카메라로 계산)
    const vfov = (hud3d.camera.fov * Math.PI) / 180;
    const fov = (2 * Math.atan(Math.tan(vfov / 2) * (W / H)) * 180) / Math.PI;
    return { W, H, fov, pxPerDeg: W / fov, pxPerRad: (W / fov) * (180 / Math.PI), horizonY: H * 0.45, fullW: (W / fov) * 360 };
  }
  const fullW = H * hud.aspect; // 360° 한 바퀴의 화면 폭
  return {
    W,
    H,
    fullW,
    fov: (W / fullW) * 360, // 화면에 보이는 가로 시야각
    pxPerDeg: fullW / 360,
    pxPerRad: fullW / (2 * Math.PI),
    horizonY: H * HORIZON_RATIO + (hud.pitch - HUD_PITCH_DEFAULT) * (fullW / 360), // 고개를 들면 지평선이 내려감
  };
}

function normDeg(d) {
  return ((d % 360) + 360) % 360;
}

// -180 ~ 180 사이 각도 차이
function deltaDeg(a, b) {
  return ((a - b + 540) % 360) - 180;
}

// ---------- 매 프레임 그리기 ----------
function hudFrame(now) {
  if (!hud.on) return;
  const L = hudLayout();
  const dt = Math.min(0.1, hud.lastT ? (now - hud.lastT) / 1000 : 0);
  hud.lastT = now;

  // 0) 키보드 이동 (WASD) / 회전 (←→)
  updateMovement(dt);

  // 1) 시야 — 실제 지형 3D (준비 전/실패 시 파노라마) · 걸을 때 살짝 흔들림
  if (hud3d.ready) {
    renderTerrain3D();
  } else {
    const offset = (hud.heading / 360) * L.fullW - L.W / 2;
    const bobY = (hud.moving ? Math.sin(hud.bob) * 3 : 0) + (hud.pitch - HUD_PITCH_DEFAULT) * L.pxPerDeg;
    hudScene.style.backgroundPosition = `${-offset}px ${bobY}px`;
  }

  // 2) 지형 스캔 + 위험 구역 표시 + 전방 상태
  updateCallouts(drawScan(L));
  updateAhead();
  updateTerrainStatus(now);

  // 2-1) AR 경로 안내 (바닥 위 경로 + 안내 카드)
  updateRouteGuide(L, now);

  // 3) AR 포인트 표시
  updateMarkers(L);

  // 4) 방위 표시줄 (방향이 바뀔 때만 다시 그림)
  const rounded = Math.round(hud.heading * 2) / 2;
  const pitchNow = Math.round(hud.pitch);
  if (rounded !== hud.lastCompassHeading || pitchNow !== hud.lastPitch || hud.moving) {
    hud.lastCompassHeading = rounded;
    hud.lastPitch = pitchNow;
    renderCompass();
  }

  // 5) 미니맵
  updateMinimap();

  hud.raf = requestAnimationFrame(hudFrame);
}

// ---------- 지형 스캔 (실제 DEM 경사) ----------
// 우주복을 입고 걷는 기준: 8° 부터 주의, 15° 부터 위험 (MER 로버의 주행 한계도 15~20°)
const SLOPE_CAUTION_DEG = 8;
const SLOPE_DANGER_DEG = 15;
const HAZARD_NAMES = { safe: "안전", caution: "주의", danger: "위험" };

function hazardLevel(slopeDeg) {
  // 위험 기준은 나의 정보의 경사 한계, 주의는 그 절반 남짓
  const danger = typeof PROFILE !== "undefined" ? PROFILE.slopeLimitDeg : SLOPE_DANGER_DEG;
  if (slopeDeg < Math.min(SLOPE_CAUTION_DEG, danger * 0.55)) return "safe";
  if (slopeDeg < danger) return "caution";
  return "danger";
}

function hazardReason(level, slopeDeg) {
  return `${level === "danger" ? "급경사" : "경사"} ${Math.round(slopeDeg)}°`;
}

// ---------- 레이어 데이터까지 합친 위험도 ----------
// 길찾기(js/route.js)와 같은 지도 칸 자료를 씀 (js/survey.js · js/environment.js)
//  - 경사: 실제 DEM
//  - 모래 함몰: 열관성(TES)으로 추정한 모래 위험 레이어 → 지면 계수 eta (탐사한 칸은 실제로 잰 값)
//  - 거친 지면 · 바위: 거칠기 / 암석 밀도 (발목 부상 위험)
//  - 그늘: 지금 시각의 태양 위치로 계산한 그림자 (춥고 어두움, 밤에는 표시 안 함)
// 가장 심한 요소가 그 칸의 위험 단계가 되고, 이유에는 그 단계의 요소를 함께 적음
const SAND_DANGER_ETA = 1.8; // 열관성 모래 위험 '높음'
const SAND_CAUTION_ETA = 1.4; // '보통'
const ROUGH_DANGER = 0.65;
const ROUGH_CAUTION = 0.4;
const LEVEL_RANK = { safe: 0, caution: 1, danger: 2 };
let hazardFrame = { shadow: null }; // 프레임마다 한 번만 구하는 값

// 월드 좌표 (지역 중심 기준 동/북 m) → 경위도 (worldOf 의 반대)
function worldToLonLat(e, n) {
  const b = (REGIONS[currentRegion] || REGIONS.gusev).bounds;
  const lat0 = (b.latMin + b.latMax) / 2;
  const lon0 = (b.lonMin + b.lonMax) / 2;
  return { lon: lon0 + e / (Math.cos((lat0 * Math.PI) / 180) * DEG_TO_M), lat: lat0 + n / DEG_TO_M };
}

function beginHazardFrame() {
  let shadow = null;
  if (typeof survey !== "undefined" && survey.loaded && typeof envShadowMap === "function" && typeof marsClock !== "undefined") {
    const sm = envShadowMap(marsClock.now());
    if (!sm.night) shadow = sm.map;
  }
  hazardFrame = { shadow };
}

// 한 지점의 위험도 { level, reason } (지형 자료가 아직 없으면 null)
function hazardAtWorld(e, n) {
  const slope = slopeAt(e, n);
  if (slope == null) return null;
  const factors = [{ level: hazardLevel(slope), text: hazardReason(hazardLevel(slope), slope) }];

  if (typeof survey !== "undefined" && survey.loaded) {
    const cell = envCellOf(worldToLonLat(e, n));
    if (cell !== -1) cellHazardFactors(cell, hazardFrame.shadow, factors);
  }

  let level = "safe";
  for (const f of factors) if (LEVEL_RANK[f.level] > LEVEL_RANK[level]) level = f.level;
  const reasons = factors.filter((f) => f.level === level && level !== "safe").map((f) => f.text);
  return { level, reason: reasons.slice(0, 2).join(" · ") };
}

// 지도 칸(30 m) 하나의 위험 요소 — 모래 · 거친 지면 · 그늘 (HUD 와 레이어 탭 '위험도' 레이어가 같이 씀)
function cellHazardFactors(cell, shadowMap, out = []) {
  const eta = survey.eta ? survey.eta[cell] : 1;
  if (eta >= SAND_DANGER_ETA) out.push({ level: "danger", text: "모래 함몰 위험" });
  else if (eta >= SAND_CAUTION_ETA) out.push({ level: "caution", text: "무른 모래" });

  const rough = survey.rough ? survey.rough[cell] : 0;
  if (rough >= ROUGH_DANGER) out.push({ level: "danger", text: "바위 많음 (발목 부상)" });
  else if (rough >= ROUGH_CAUTION) out.push({ level: "caution", text: "거친 지면" });

  if (shadowMap && shadowMap[cell]) out.push({ level: "caution", text: "그늘 (저온 · 어두움)" });
  return out;
}

// ---------- 레이어 탭 '위험도 (HUD 와 같은 기준)' 레이어 ----------
// 지도 칸마다 경사(30 m DEM) + 모래 + 거친 지면 + 그늘(지금 시각)로 HUD 와 같은 단계를 칠함
//  안전 = 투명, 주의 = 노랑, 위험 = 빨강. 시계 · 나의 정보(경사 한계) · 탐사가 바뀌면 다시 칠함
const HAZARD_LAYER_RGBA = { caution: [255, 216, 77, 120], danger: [255, 77, 77, 165] };
let hazardLayerStats = null; // 범례에 쓰는 칸 비율

function renderHazardCanvas() {
  if (!survey.loaded) return envPaint("hazard", "", () => {});
  const sm = envShadowMap(marsClock.now());
  const shadow = sm.night ? null : sm.map;
  const key = `${survey.version}|${sm.key}|${typeof PROFILE !== "undefined" ? PROFILE.slopeLimitDeg : ""}`;
  const count = { safe: 0, caution: 0, danger: 0 };
  const canvas = envPaint("hazard", key, (i, px, o) => {
    let level = hazardLevel(survey.slope[i]);
    if (level !== "danger") {
      for (const f of cellHazardFactors(i, shadow)) if (LEVEL_RANK[f.level] > LEVEL_RANK[level]) level = f.level;
    }
    count[level]++;
    const c = HAZARD_LAYER_RGBA[level];
    if (!c) {
      px[o + 3] = 0;
      return;
    }
    px[o] = c[0];
    px[o + 1] = c[1];
    px[o + 2] = c[2];
    px[o + 3] = c[3];
  });
  if (count.safe + count.caution + count.danger) hazardLayerStats = { ...count, night: sm.night };
  return canvas;
}

function resizeHudCanvas() {
  const dpr = window.devicePixelRatio || 1;
  hudCanvas.width = hudView.clientWidth * dpr;
  hudCanvas.height = hudView.clientHeight * dpr;
  hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", () => hud.on && resizeHudCanvas());

// 실제 DEM 경사 + 레이어 데이터(모래 · 거친 지면 · 그늘)로 주변 위험도를 표시하고,
// 시야 안에서 가장 가까운 위험/주의 구역을 돌려줌
function drawScan(L) {
  const ctx = hudCtx;
  beginHazardFrame();
  ctx.clearRect(0, 0, L.W, L.H);
  const nearest = { caution: null, danger: null };

  // 격자는 땅(월드 좌표)에 고정 → 걸어가도 위험 표시가 제자리에 있음
  const pe = hud.world.e;
  const pn = hud.world.n;
  const x0 = Math.floor((pe - SCAN_RANGE_M) / GRID_M) * GRID_M;
  const z0 = Math.floor((pn - SCAN_RANGE_M) / GRID_M) * GRID_M;
  for (let wx = x0; wx <= pe + SCAN_RANGE_M; wx += GRID_M) {
    for (let wz = z0; wz <= pn + SCAN_RANGE_M; wz += GRID_M) {
      const gx = wx - pe; // 나를 기준으로 한 위치
      const gz = wz - pn;
      const d = Math.hypot(gx, gz);
      if (d < 2 || d > SCAN_RANGE_M) continue;

      // 땅 위 점 → 화면 (3D 지형이면 실제 높이 위에 붙음)
      const pr = projectRel(L, gx, gz);
      if (!pr || pr.y > L.H) continue;
      const sx = pr.x;
      const sy = pr.y;

      const hz = hazardAtWorld(wx, wz);
      if (!hz) continue; // 지형 데이터를 아직 못 불러옴
      const level = hz.level;
      const near = 1 - d / SCAN_RANGE_M; // 가까울수록 1
      const alpha = Math.min(1, 0.25 + near * 0.6);
      ctx.fillStyle = `rgba(${HAZARD_COLORS[level]}, ${alpha})`;

      const size = Math.max(1, 3.2 * near + 0.6);
      if (level === "safe") {
        ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
      } else {
        const barH = (level === "danger" ? 14 : 8) * (0.3 + near);
        ctx.fillRect(sx - size / 2, sy - barH, Math.max(1.5, size * 0.8), barH);

        // 화면 가장자리에 너무 붙지 않은 것 중 가장 가까운 구역 기억
        if (sx > 80 && sx < L.W - 80 && (!nearest[level] || d < nearest[level].d)) {
          nearest[level] = { d, sx, sy, reason: hz.reason };
        }
      }
    }
  }

  return nearest;
}

// 위험/주의 구역 위에 이유와 거리를 붙여 보여줌
function updateCallouts(nearest) {
  for (const level of ["danger", "caution"]) {
    const el = hudCalloutsEl.querySelector(`.is-${level}`);
    const n = nearest[level];
    el.hidden = !n;
    if (!n) continue;
    el.style.left = `${n.sx}px`;
    el.style.top = `${n.sy}px`;
    el.querySelector(".hud-callout__text").textContent = `${n.reason} · ${Math.round(n.d)}m`;
  }
}

// 바라보는 방향 바로 앞(3~25m)에서 처음 만나는 위험 요소 (경사 + 모래 · 거친 지면 · 그늘)
function updateAhead() {
  const h = (hud.heading * Math.PI) / 180;
  let found = null;
  let hasData = false;
  for (let d = 3; d <= 25; d += 1) {
    const hz = hazardAtWorld(hud.world.e + Math.sin(h) * d, hud.world.n + Math.cos(h) * d);
    if (!hz) continue;
    hasData = true;
    if (hz.level === "danger") {
      found = { level: hz.level, d, reason: hz.reason };
      break;
    }
    if (hz.level === "caution" && !found) found = { level: hz.level, d, reason: hz.reason };
  }

  const level = found ? found.level : "safe";
  hudAheadEl.className = `hud-ahead is-${level}`;
  hudAheadEl.textContent = !hasData
    ? "지형 데이터 불러오는 중…"
    : found
      ? `전방 ${found.d}m · ${HAZARD_NAMES[level]} · ${found.reason}`
      : "전방 25m 이내 안전";
}

// ---------- AR 포인트 / 목적지 ----------
// 현위치에서 각 포인트까지의 방위각과 거리
function bearingTo(from, to) {
  const cos = Math.cos((from.lat * Math.PI) / 180);
  const east = (to.lon - from.lon) * cos * DEG_TO_M;
  const north = (to.lat - from.lat) * DEG_TO_M;
  return {
    bearing: normDeg((Math.atan2(east, north) * 180) / Math.PI),
    distance: Math.hypot(east, north),
  };
}

function arTargets() {
  const here = getCurrentPosition();
  if (!here) return [];

  const targets = getPoints()
    .filter((p) => p.lon != null && p.lat != null)
    .map((p) => ({
      name: p.name,
      color: (POINT_TYPES[p.type] || POINT_TYPES.custom).color,
      ...bearingTo(here, p),
    }));

  // 길찾기에서 경로를 골랐을 때만 도착지를 목적지로 표시
  const end = nav.stops[nav.stops.length - 1];
  if (currentHudRoute() && end.lonLat) {
    targets.push({ name: `도착지${end.name ? " · " + end.name : ""}`, color: "#b38cff", isGoal: true, ...bearingTo(here, end.lonLat) });
  }
  return targets;
}

function formatKm(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function updateMarkers(L) {
  const targets = arTargets();
  // 개수가 바뀌면 다시 만들기
  if (hudMarkersEl.children.length !== targets.length) {
    hudMarkersEl.replaceChildren(
      ...targets.map(() => {
        const el = document.createElement("div");
        el.className = "hud-marker";
        el.innerHTML = `<span class="hud-marker__name"></span><span class="hud-marker__dist"></span><span class="hud-marker__diamond"></span>`;
        return el;
      })
    );
  }

  targets.forEach((t, i) => {
    const el = hudMarkersEl.children[i];
    const delta = deltaDeg(t.bearing, hud.heading);
    let pos = null;
    if (hud3d.ready) {
      // 실제 지형 위 그 지점의 25m 위에 표시
      const b = (t.bearing * Math.PI) / 180;
      const pr = projectRel(L, Math.sin(b) * t.distance, Math.cos(b) * t.distance, 25);
      if (pr) pos = { x: pr.x, y: pr.y };
    } else if (Math.abs(delta) < L.fov / 2) {
      // 멀수록 지평선 가까이
      pos = { x: L.W / 2 + delta * L.pxPerDeg, y: L.horizonY - 20 - Math.min(60, 60000 / Math.max(t.distance, 500)) };
    }
    el.hidden = !pos;
    if (!pos) return;

    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    el.style.setProperty("--pin-color", t.color);
    el.classList.toggle("is-goal", !!t.isGoal);
    el.children[0].textContent = t.name;
    el.children[1].textContent = formatKm(t.distance);
  });
}

// ---------- 방위 표시줄 ----------
function renderCompass() {
  const width = compassTape.clientWidth;
  const pxPerDeg = width / COMPASS_SPAN_DEG;
  const items = [];

  const start = Math.floor((hud.heading - COMPASS_SPAN_DEG / 2) / 5) * 5;
  for (let d = start; d <= hud.heading + COMPASS_SPAN_DEG / 2; d += 5) {
    const x = width / 2 + (d - hud.heading) * pxPerDeg;
    const deg = normDeg(d);
    if (deg % 15 === 0) {
      const name = COMPASS_NAMES[deg];
      items.push(
        `<span class="hud-compass__tick is-major" style="left:${x}px"></span>` +
          `<span class="hud-compass__label ${name ? "is-cardinal" : ""}" style="left:${x}px">${name || deg}</span>`
      );
    } else {
      items.push(`<span class="hud-compass__tick" style="left:${x}px"></span>`);
    }
  }

  // 포인트·목적지 방향 표시
  for (const t of arTargets()) {
    const delta = deltaDeg(t.bearing, hud.heading);
    if (Math.abs(delta) > COMPASS_SPAN_DEG / 2) continue;
    const x = width / 2 + delta * pxPerDeg;
    items.push(`<span class="hud-compass__mark ${t.isGoal ? "is-goal" : ""}" style="left:${x}px;--pin-color:${t.color}"></span>`);
  }

  compassTape.innerHTML = items.join("");
  const tilt = Math.round(hud.pitch);
  hudHeadingEl.textContent = `${Math.round(normDeg(hud.heading)) % 360}°  ${tilt >= 0 ? "▲" : "▼"}${Math.abs(tilt)}°`;
}

// ---------- 생체/장비 상태 (js/eva.js 보행 모델) ----------
// 우주복 탱크 · 배터리가 가득 찬 상태로 시작해서, 실제 지형 위를 걷는 만큼 (경사 · 속도 · 지면) 줄어듦
const evaState = {
  o2L: EVA.o2TankL,
  waterKg: EVA.waterKg,
  batteryWh: EVA.batteryWh,
  energyKj: 0,
  metabolicW: evaMetabolicW(0, 0),
  doseUSv: 0,
};

// 오른쪽 아래 링: 산소(큰 링) · 피로도 · 방사선(누적/한도) · 귀환 여유
//  냉각수 · 전력은 평소엔 숨김 — 둘 다 산소보다 늦게 떨어지게 돼 있어 따로 볼 필요가 없고,
//  20% 아래로 내려갔을 때만 경고 링(low)으로 나타남
const VITAL_LOW_PCT = 20;
const vitals = [
  { id: "o2", label: "O₂", value: 100, color: "#4cc9f0", big: true, sub: "" },
  { id: "fatigue", label: "피로도", value: 0, color: "#ffd166" },
  { id: "rad", label: "방사선", value: 0, color: "#ff7b54", sub: "계산 중" },
  { id: "ret", label: "귀환", value: 100, color: "#7df9c4", num: "—", sub: "계산 중" },
  { id: "low", label: "", value: 0, color: "#ff5f5f", hidden: true },
];

// 매 프레임: 지금 소비 전력만큼 산소 · 냉각수 · 전력을 씀 (dt: 실제 흐른 초)
function updateEva(dt, speed, grade, eta) {
  const W = evaMetabolicW(speed, grade, eta);
  evaState.metabolicW = W;
  evaState.o2L = Math.max(0, evaState.o2L - evaO2LPerS(W) * dt);
  evaState.waterKg = Math.max(0, evaState.waterKg - evaWaterKgPerS(W) * dt);
  evaState.batteryWh = Math.max(0, evaState.batteryWh - (EVA.suitPowerW * dt) / 3600);
  evaState.energyKj += (W * dt) / 1000;
  const r = currentRadiation();
  if (r.dose != null) evaState.doseUSv += (r.dose * 1000 * dt) / 86400;
}

function hoursLeft(amount, perHour) {
  const h = amount / Math.max(perHour, 1e-9);
  return `${Math.floor(h)}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;
}

function updateVitals() {
  const byId = Object.fromEntries(vitals.map((v) => [v.id, v]));
  const W = evaState.metabolicW;
  byId.o2.value = (evaState.o2L / EVA.o2TankL) * 100;
  byId.o2.num = Math.round(byId.o2.value);
  byId.o2.sub = `잔여 ${hoursLeft(evaState.o2L, evaO2LPerS(W) * 3600)}`;
  byId.fatigue.value = Math.min(100, (evaState.energyKj / EVA.dailyEnergyKj) * 100);
  byId.fatigue.num = Math.round(byId.fatigue.value);
  byId.fatigue.sub = `${Math.round(W)} W`;
  // 냉각수 · 전력: 20% 아래로 떨어진 것이 있을 때만 (더 낮은 쪽) 경고 링
  const waterPct = (evaState.waterKg / EVA.waterKg) * 100;
  const powerPct = (evaState.batteryWh / EVA.batteryWh) * 100;
  const low = waterPct <= powerPct ? { label: "냉각수", pct: waterPct } : { label: "전력", pct: powerPct };
  byId.low.hidden = low.pct >= VITAL_LOW_PCT;
  byId.low.label = low.label;
  byId.low.value = low.pct;
  byId.low.num = Math.round(low.pct);
  byId.low.sub = "부족";
  updateRadiationVital();
  updateReturnVital();
}

function ringSvg(v, r, stroke) {
  const c = 2 * Math.PI * r;
  const size = (r + stroke) * 2;
  return `
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="rgba(10,14,20,0.75)" stroke="rgba(255,255,255,0.15)" stroke-width="${stroke}" />
      <circle class="hud-ring__value" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${v.color}"
        stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - v.value / 100)}"
        transform="rotate(-90 ${size / 2} ${size / 2})" />
    </svg>`;
}

function buildVitals() {
  hudVitalsEl.innerHTML = vitals
    .filter((v) => !v.hidden)
    .map(
      (v) => `
      <div class="hud-ring ${v.big ? "is-big" : ""}" data-id="${v.id}" title="${v.label} ${v.value}%">
        ${ringSvg(v, v.big ? 47 : 27, v.big ? 8 : 5)}
        <div class="hud-ring__text">
          <span class="hud-ring__label">${v.label}</span>
          <span class="hud-ring__num">${v.num ?? Math.round(v.value)}</span>
          ${v.sub ? `<span class="hud-ring__sub">${v.sub}</span>` : ""}
        </div>
      </div>`
    )
    .join("");
}

// 방사선: 이번 EVA 에서 지금까지 받은 누적량 ÷ 나의 정보의 EVA 방사선 한도 → 걸을수록 차오르는 링
//  (선량률은 고도 · 시각으로만 정해져 걸어도 거의 안 변하므로 아래에 작게만 표시. 모델은 marstime.js)
function updateRadiationVital() {
  const v = vitals.find((x) => x.id === "rad");
  const r = currentRadiation();
  if (r.dose == null) return;
  const limit = typeof PROFILE !== "undefined" ? PROFILE.radLimitUSv : 300;
  const pct = (evaState.doseUSv / limit) * 100;
  v.value = Math.max(0, Math.min(100, pct));
  v.num = evaState.doseUSv < 100 ? evaState.doseUSv.toFixed(1) : Math.round(evaState.doseUSv);
  v.sub = `/${limit} μSv`;
  v.color = pct >= 100 ? "#ff5f5f" : "#ff7b54";
}

// ---------- 귀환 여유 ----------
// "지금 돌아가면 산소가 충분한가": 현위치 → 안전한 곳까지 실제 지형으로 걸어 돌아가는 데 드는 산소 · 시간
//  안전한 곳 = 가장 가까운 기지, 기지가 없으면 HUD 로 걷기 시작한 지점
//  링 = 쓸 수 있는 산소(안전 여유 제외) 중 귀환에 쓰고 남는 비율, 숫자 = 걸어서 돌아가는 시간(분)
const hudReturn = { key: null, field: null };
const RETURN_FIELD_M = 4000; // 이 거리(평지 기준)까지만 계산 — 그보다 멀면 '범위 밖'

function hudHome() {
  const here = getCurrentPosition();
  const bases = typeof getBases === "function" ? getBases() : [];
  if (here && bases.length) {
    let best = bases[0], bestD = Infinity;
    for (const b of bases) {
      const d = bearingTo(here, b).distance;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return { lon: best.lon, lat: best.lat, name: best.name };
  }
  return hud.evaStart ? { ...hud.evaStart, name: "출발 지점" } : null;
}

function updateReturnVital() {
  const v = vitals.find((x) => x.id === "ret");
  const here = getCurrentPosition();
  const home = hudHome();
  if (!here || !home || typeof survey === "undefined" || !survey.loaded || typeof envWalkField !== "function") {
    Object.assign(v, { value: 0, num: "—", sub: "계산 중", color: "#7df9c4" });
    return;
  }
  const homeCell = envCellOf(home);
  const cell = envCellOf(here);
  // 각 칸 → 안전한 곳까지의 비용 지도. 30초마다 (걸으며 밝혀진 지형 반영) 또는 안전한 곳 · 나의 정보가 바뀌면 다시 계산
  const key = `${homeCell}|${PROFILE.slopeLimitDeg}|${EVA.bodyKg}|${EVA.flatSpeedMps}|${Math.floor(Date.now() / 30000)}`;
  if (hudReturn.key !== key && homeCell !== -1) {
    const v0 = evaSpeed(0);
    const flatJPerM = evaMetabolicW(v0, 0) / v0;
    hudReturn.field = envWalkField([homeCell], { reverse: true, by: "energy", limit: flatJPerM * RETURN_FIELD_M * 1.6 });
    hudReturn.key = key;
  }
  const f = hudReturn.field;
  const needJ = f && cell !== -1 ? f.energy[cell] : Infinity;
  if (!Number.isFinite(needJ)) {
    Object.assign(v, { value: 0, num: "—", sub: "범위 밖", color: "#ff5f5f" });
    return;
  }
  const needL = needJ / (EVA.o2KjPerL * 1000);
  const margin = typeof profileMargin === "function" ? profileMargin() : 0.2;
  const usableL = evaState.o2L - EVA.o2TankL * margin; // 안전 여유는 남겨 둠
  const pct = usableL > 0 ? (1 - needL / usableL) * 100 : -1;
  v.value = Math.max(0, Math.min(100, pct));
  v.num = `${Math.max(0, Math.round(f.time[cell] / 60))}분`;
  v.sub = pct > 0 ? `여유 ${Math.round(pct)}%` : "귀환 불가";
  v.color = pct <= 0 ? "#ff5f5f" : pct < 30 ? "#ffd166" : "#7df9c4";
}

// 1초마다 숫자 갱신 (값 자체는 매 프레임 updateEva 에서 줄어듦)
setInterval(() => {
  if (!hud.on) return;
  updateVitals();
  buildVitals();
}, 1000);

// ---------- 미니맵 (HUD 모드에서 왼쪽 아래 창) ----------
// 흑백 지도 위에 우리가 걸어서 밝힌 곳만 컬러 (js/survey.js 의 탐사 구역) + 지금 고른 경로 (걸으면서 D* Lite 로 바뀌는 것이 보임)
const hudMiniCanvas = document.createElement("canvas");
hudMiniCanvas.className = "hud-mini";
hudMiniCanvas.hidden = true;
hudPreview.append(hudMiniCanvas);
const MINI_MAP_FILTER = "sepia(0.55) saturate(1.7) hue-rotate(-12deg) brightness(1.05)"; // 지도 사진과 같은 화성 색

function updateMinimap() {
  const here = getCurrentPosition();
  if (!here || !mapImage.naturalWidth) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = hudPreview.clientWidth, h = hudPreview.clientHeight;
  if (hudMiniCanvas.width !== Math.round(w * dpr) || hudMiniCanvas.height !== Math.round(h * dpr)) {
    hudMiniCanvas.width = Math.round(w * dpr);
    hudMiniCanvas.height = Math.round(h * dpr);
  }
  const Z = MINIMAP_ZOOM;
  const c = lonLatToImage(here.lon, here.lat);
  const g = hudMiniCanvas.getContext("2d");
  // 지도 사진 픽셀 → 미니맵 (내 위치가 가운데)
  g.setTransform(dpr * Z, 0, 0, dpr * Z, dpr * (w / 2 - c.x * Z), dpr * (h / 2 - c.y * Z));
  g.clearRect(c.x - w / Z, c.y - h / Z, (2 * w) / Z, (2 * h) / Z);
  g.imageSmoothingEnabled = true;

  // 1) 미탐험: 어두운 흑백
  g.filter = "grayscale(1) brightness(0.5) contrast(1.1)";
  g.drawImage(mapImage, 0, 0);
  // 2) 밝힌 곳: 발자취를 따라 폭 2 × SURVEY_RADIUS_M 띠만 컬러 (따로 그려서 띠 모양으로 오려 냄) + 가장자리에 옅은 빛
  if (survey.loaded) {
    const m = (hudMiniCanvas.reveal = hudMiniCanvas.reveal || document.createElement("canvas"));
    if (m.width !== hudMiniCanvas.width || m.height !== hudMiniCanvas.height) {
      m.width = hudMiniCanvas.width;
      m.height = hudMiniCanvas.height;
    }
    const mg = m.getContext("2d");
    mg.setTransform(1, 0, 0, 1, 0, 0);
    mg.globalCompositeOperation = "source-over";
    mg.clearRect(0, 0, m.width, m.height);
    mg.setTransform(g.getTransform());
    mg.lineJoin = mg.lineCap = "round";
    mg.lineWidth = Math.max(surveyBandPx(), 5 / Z); // 너무 가늘면 안 보이므로 미니맵에서는 최소 5px
    mg.strokeStyle = "#fff";
    for (const walk of survey.walks) {
      mg.beginPath();
      walk.forEach(([lon, lat], i) => {
        const q = lonLatToImage(lon, lat);
        if (i) mg.lineTo(q.x, q.y);
        else mg.moveTo(q.x, q.y);
      });
      if (walk.length === 1) mg.lineTo(lonLatToImage(walk[0][0], walk[0][1]).x + 1e-3, lonLatToImage(walk[0][0], walk[0][1]).y);
      mg.stroke();
    }
    mg.globalCompositeOperation = "source-in";
    mg.filter = MINI_MAP_FILTER;
    mg.drawImage(mapImage, 0, 0);
    mg.filter = "none";
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.filter = `drop-shadow(0 0 ${2.5 * dpr}px rgba(255, 214, 150, 0.95))`;
    g.drawImage(m, 0, 0);
    g.restore();
  }
  g.filter = "none";

  // 3) 고른 경로 (지금 위치부터 남은 길) + 도착지
  const route = currentHudRoute();
  if (route) {
    g.beginPath();
    route.path.forEach((p, i) => {
      const q = lonLatToImage(p.lon, p.lat);
      if (i) g.lineTo(q.x, q.y);
      else g.moveTo(q.x, q.y);
    });
    g.lineJoin = g.lineCap = "round";
    g.strokeStyle = "rgba(0, 0, 0, 0.75)";
    g.lineWidth = 5 / Z;
    g.stroke();
    g.strokeStyle = route.color;
    g.lineWidth = 2.6 / Z;
    g.stroke();
    const end = lonLatToImage(route.path[route.path.length - 1].lon, route.path[route.path.length - 1].lat);
    g.beginPath();
    g.arc(end.x, end.y, 4.5 / Z, 0, Math.PI * 2);
    g.fillStyle = "#b38cff";
    g.fill();
    g.strokeStyle = "#fff";
    g.lineWidth = 1.5 / Z;
    g.stroke();
  }
  // 4) 걸으며 발견한 지형 변화 지점
  if (survey.loaded) {
    for (const e of survey.events) {
      if (!e.found) continue;
      const q = lonLatToImage(e.lon, e.lat);
      const r = 4 / Z;
      g.beginPath();
      g.moveTo(q.x, q.y - r);
      g.lineTo(q.x + r, q.y);
      g.lineTo(q.x, q.y + r);
      g.lineTo(q.x - r, q.y);
      g.closePath();
      g.fillStyle = SURVEY_EVENT_TYPES[e.type].color;
      g.fill();
      g.strokeStyle = "rgba(0, 0, 0, 0.8)";
      g.lineWidth = 1 / Z;
      g.stroke();
    }
  }
  hudPreview.style.setProperty("--heading", `${hud.heading}deg`);
}

// ---------- 둘러보기 (드래그 / 키보드) ----------
hudCanvas.addEventListener("pointerdown", (e) => {
  hudCanvas.setPointerCapture(e.pointerId);
  hud.drag = { x: e.clientX, y: e.clientY, heading: hud.heading, pitch: hud.pitch };
  hudCanvas.classList.add("is-dragging");
});
hudCanvas.addEventListener("pointermove", (e) => {
  if (!hud.drag) return;
  const L = hudLayout();
  hud.heading = normDeg(hud.drag.heading - (e.clientX - hud.drag.x) / L.pxPerDeg);
  setPitch(hud.drag.pitch + (e.clientY - hud.drag.y) / L.pxPerDeg); // 아래로 끌면 고개를 듦
});
function endHudDrag() {
  hud.drag = null;
  hudCanvas.classList.remove("is-dragging");
}
hudCanvas.addEventListener("pointerup", endHudDrag);
hudCanvas.addEventListener("pointercancel", endHudDrag);

// WASD: 이동, Shift: 달리기, ←→: 회전 (한글 입력 상태에서도 되도록 e.code 사용)
const HUD_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
document.addEventListener("keydown", (e) => {
  if (!hud.on || e.target.closest("input, select, textarea, dialog")) return;
  if (!HUD_KEYS.includes(e.code)) return;
  e.preventDefault();
  hud.keys.add(e.code);
});
document.addEventListener("keyup", (e) => hud.keys.delete(e.code));
window.addEventListener("blur", () => hud.keys.clear());

// ---------- 이동 (WASD) ----------
// 걷는 속도는 발밑 실제 경사 · 지면에 따라 정해짐 (js/eva.js). Shift: 뛰기
// 시뮬레이션 배속: 1 = 실제 시간. 올리면 이동 · 산소 등 소모가 같은 배수로 빨라짐
const HUD_TIME_SCALE = 1;const TURN_DPS = 70; // ←→ 회전 속도 (°/초)
const PITCH_DPS = 50; // ↑↓ 고개 속도 (°/초)

function setPitch(deg) {
  hud.pitch = Math.max(HUD_PITCH_MIN, Math.min(HUD_PITCH_MAX, deg));
}

// 지역 중심 기준 미터 좌표 (스캔 격자를 땅에 고정하는 데 사용)
function worldOf(p) {
  const b = (REGIONS[currentRegion] || REGIONS.gusev).bounds;
  const lat0 = (b.latMin + b.latMax) / 2;
  const lon0 = (b.lonMin + b.lonMax) / 2;
  return {
    e: (p.lon - lon0) * Math.cos((lat0 * Math.PI) / 180) * DEG_TO_M,
    n: (p.lat - lat0) * DEG_TO_M,
  };
}

function syncWorldPosition() {
  const here = getCurrentPosition();
  if (here) hud.world = worldOf(here);
}

function updateMovement(dt) {
  const k = hud.keys;
  if (k.has("ArrowLeft")) hud.heading = normDeg(hud.heading - TURN_DPS * dt);
  if (k.has("ArrowRight")) hud.heading = normDeg(hud.heading + TURN_DPS * dt);
  if (k.has("ArrowUp")) setPitch(hud.pitch + PITCH_DPS * dt);
  if (k.has("ArrowDown")) setPitch(hud.pitch - PITCH_DPS * dt);

  const fwd = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
  const side = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
  const here = getCurrentPosition();
  hud.moving = !!(here && (fwd || side));
  const simDt = dt * HUD_TIME_SCALE;
  if (!hud.moving) {
    hud.speed = 0;
    updateEva(simDt, 0, 0);
    return;
  }

  const norm = Math.hypot(fwd, side);
  const h = (hud.heading * Math.PI) / 180;
  const dirE = (fwd * Math.sin(h) + side * Math.cos(h)) / norm; // 가는 방향 (동/북 단위 벡터)
  const dirN = (fwd * Math.cos(h) - side * Math.sin(h)) / norm;
  // 가는 방향 2 m 앞의 실제 높이 차로 경사, 지면은 열관성 모래 위험으로
  const { e, n } = hud.world;
  const grade = (terrainHeight(e + dirE * 2, n + dirN * 2) - terrainHeight(e, n)) / 2;
  const eta = terrainEta(here.lon, here.lat);
  const running = k.has("ShiftLeft") || k.has("ShiftRight");
  const speed = evaSpeed(grade, eta) * (running ? EVA.runFactor : 1);
  hud.speed = speed;
  hud.grade = grade;
  updateEva(simDt, speed, grade, eta);
  // 뛰면 대사량이 더 큼 (걷기 대비 속도² 만큼 늘어나는 Pandolf 항이 이미 반영됨)

  // 기지 건물은 뚫고 지나갈 수 없음: 막히면 벽을 따라 미끄러지고, 그것도 안 되면 멈춤
  let mE = dirE * speed * simDt, mN = dirN * speed * simDt;
  if (baseBlocksMove(e, n, mE, mN)) {
    if (!baseBlocksMove(e, n, mE, 0)) mN = 0;
    else if (!baseBlocksMove(e, n, 0, mN)) mE = 0;
    else mE = mN = 0;
  }
  here.lat += mN / DEG_TO_M;
  here.lon += mE / (DEG_TO_M * Math.cos((here.lat * Math.PI) / 180));
  hud.world = worldOf(here);
  hud.bob += simDt * speed * 2.4;
  // 걸어 다닌 곳은 탐사된 구역이 되고, 지형이 지도와 다르면 고른 경로를 D* Lite 로 다시 계산 (js/route.js)
  if (typeof onHudWalk === "function") onHudWalk(here);
}

// ---------- AR 경로 안내 ----------
const hudGuide = document.getElementById("hud-guide");
const hudGuideArrow = document.getElementById("hud-guide-arrow");
const hudGuideLabel = document.getElementById("hud-guide-label");
const hudGuideDest = document.getElementById("hud-guide-dest");
const hudGuideDist = document.getElementById("hud-guide-dist");
const hudGuideWarn = document.getElementById("hud-guide-warn");
const ROUTE_AHEAD_M = 160; // 바닥에 그릴 경로 길이 (앞쪽)
const OFF_ROUTE_M = 15;

// HUD 경로 = 길찾기 탭에서 고른 경로 (없으면 경로 안내 없이 주변 모습만)
function currentHudRoute() {
  const sel = nav.results.find((r) => r.id === nav.selectedId);
  return sel ? { ...sel, destName: nav.stops[nav.stops.length - 1].name || "도착지" } : null;
}

// 경로 → 지역 기준 미터 좌표 + 누적 거리 (경로가 바뀔 때만 계산)
const routeCache = new WeakMap();
function routeGeometry(route) {
  if (routeCache.has(route.path)) return routeCache.get(route.path);
  const pts = route.path.map(worldOf);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].e - pts[i - 1].e, pts[i].n - pts[i - 1].n));
  const geo = { pts, cum, total: cum[cum.length - 1] };
  routeCache.set(route.path, geo);
  return geo;
}

// 경로 위 '출발점에서 s 미터' 지점
function pointAlong(geo, s) {
  const { pts, cum } = geo;
  s = Math.max(0, Math.min(geo.total, s));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const t = (s - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-6);
  return { e: pts[i - 1].e + (pts[i].e - pts[i - 1].e) * t, n: pts[i - 1].n + (pts[i].n - pts[i - 1].n) * t };
}

// 내 위치에서 가장 가까운 경로 지점 (거리, 경로상 위치)
function nearestOnRoute(geo, me) {
  let best = { d: Infinity, along: 0 };
  for (let i = 1; i < geo.pts.length; i++) {
    const a = geo.pts[i - 1], b = geo.pts[i];
    const vx = b.e - a.e, vy = b.n - a.n;
    const len2 = vx * vx + vy * vy || 1e-6;
    const t = Math.max(0, Math.min(1, ((me.e - a.e) * vx + (me.n - a.n) * vy) / len2));
    const d = Math.hypot(a.e + vx * t - me.e, a.n + vy * t - me.n);
    if (d < best.d) best = { d, along: geo.cum[i - 1] + Math.sqrt(len2) * t };
  }
  return best;
}

// 땅 위 한 점(나 기준 동/북 m)을 화면 좌표로
function projectGround(L, de, dn) {
  return projectRel(L, de, dn, 0.15);
}

function updateRouteGuide(L, now) {
  const route = currentHudRoute();
  hudGuide.hidden = !route;
  if (!route) return;

  const geo = routeGeometry(route);
  const me = hud.world;
  const near = nearestOnRoute(geo, me);
  const remaining = geo.total - near.along;

  // 바닥 위 경로: 빛나는 선 + 진행 방향 화살표(›)
  const ctx = hudCtx;
  const start = Math.max(0, near.along - 4);
  const end = Math.min(geo.total, near.along + ROUTE_AHEAD_M);
  const samples = [];
  for (let s = start; s <= end; s += 1.2) {
    const p = pointAlong(geo, s);
    samples.push({ s, p: projectGround(L, p.e - me.e, p.n - me.n) });
  }

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = route.color;
  ctx.shadowBlur = 12;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].p, b = samples[i].p;
    if (!a || !b) continue;
    const near01 = Math.max(0, 1 - a.d / ROUTE_AHEAD_M);
    ctx.strokeStyle = hexAlpha(route.color, 0.25 + 0.6 * near01);
    ctx.lineWidth = 2 + 16 * near01 * near01;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  // 진행 방향 화살표: 6m 간격, 시간에 따라 앞으로 흐르는 느낌
  ctx.shadowBlur = 0;
  const flow = ((now / 1000) * 4) % 6;
  for (let s = Math.ceil((start - flow) / 6) * 6 + flow; s < end - 1; s += 6) {
    const p0 = pointAlong(geo, s), p1 = pointAlong(geo, s + 1);
    const a = projectGround(L, p0.e - me.e, p0.n - me.n);
    const b = projectGround(L, p1.e - me.e, p1.n - me.n);
    if (!a || !b) continue;
    const near01 = Math.max(0, 1 - a.d / ROUTE_AHEAD_M);
    const size = 3 + 14 * near01 * near01;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.6 * near01})`;
    ctx.lineWidth = 1 + 2.5 * near01;
    ctx.beginPath();
    ctx.moveTo(a.x + Math.cos(ang + 2.5) * size, a.y + Math.sin(ang + 2.5) * size);
    ctx.lineTo(a.x, a.y);
    ctx.lineTo(a.x + Math.cos(ang - 2.5) * size, a.y + Math.sin(ang - 2.5) * size);
    ctx.stroke();
  }
  ctx.restore();

  // 안내 카드: 15m 앞 경로 지점 방향으로 화살표
  const ahead = pointAlong(geo, near.along + 15);
  const bearing = normDeg((Math.atan2(ahead.e - me.e, ahead.n - me.n) * 180) / Math.PI);
  const turn = deltaDeg(bearing, hud.heading);
  hudGuideArrow.style.transform = `rotate(${turn}deg)`;

  const speedMps = route.distanceM / Math.max(route.hours * 3600, 1);
  hudGuideLabel.textContent = `길찾기 경로 · ${route.name}`;
  hudGuideDest.textContent = route.destName;
  hudGuideDist.textContent = `남은 거리 ${formatKm(remaining)} · 약 ${formatDuration(remaining / speedMps / 3600)}`;

  let warn = "";
  let state = "";
  if (remaining < 8) {
    warn = "목적지 도착";
    state = "is-arrived";
  } else if (near.d > OFF_ROUTE_M) {
    warn = `경로 이탈 ${Math.round(near.d)}m`;
    state = "is-off";
  } else if (Math.abs(turn) > 35) {
    warn = `${turn > 0 ? "오른쪽" : "왼쪽"}으로 ${Math.round(Math.abs(turn))}° 회전`;
  }
  hudGuideWarn.textContent = warn;
  hudGuide.className = `hud-guide ${state}`;
}

function hexAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// =========================================================
// 실제 지형 (data/ 의 DEM → js/dem.js) + 1인칭 3D (three.js)
//  - near   : 현위치 주변 3 km, HiRISE 2 m 격자 + 표면 사진 약 1.5 m/px
//  - hirise : Columbia Hills 30 km, 30 m 격자 + 지도 사진
//  - mola   : Gusev 주변 400 km, MOLA 400 m 격자 → 지평선의 크레이터 테두리까지
// =========================================================
const THREE_URL = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
const TERRAIN_BASE_M = -1913; // 3D 좌표 높이 기준 (DEM 중앙값 부근)
const HUD_PITCH_DEFAULT = -8; // 처음 고개 각도: 살짝 아래 (발밑 지형이 보이도록)
const HUD_PITCH_MIN = -70; // 발밑까지
const HUD_PITCH_MAX = 35; // 하늘 쪽
const hud3d = {
  ready: false,
  loading: false,
  failed: false,
  grids: [], // 월드 좌표로 옮긴 DEM 격자 (정밀한 것부터) — 고도 · 경사 조회용
  dataPromise: null,
  origin: { e: 0, n: 0 }, // 화성 곡률 계산의 기준점 (처음 서 있던 곳)
  tiles: new Map(), // "r-c" → { mesh, loading } 발밑 고해상도 타일
  tileCheckT: 0,
};
const hudLoading = document.getElementById("hud-loading");
const hudTerrainCanvas = document.getElementById("hud-3d");
const hudTerrainStatus = document.getElementById("hud-terrain");

function loadScriptOnce(src) {
  if (window.THREE) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src} 불러오기 실패`));
    document.head.append(s);
  });
}

// 높이 격자에서 (fx, fy) 위치 값 (bilinear)
function sampleGrid(grid, fx, fy) {
  const x = Math.max(0, Math.min(grid.w - 1.001, fx));
  const y = Math.max(0, Math.min(grid.h - 1.001, fy));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const ax = x - x0, ay = y - y0;
  const i = y0 * grid.w + x0;
  const v = grid.values;
  return (v[i] * (1 - ax) + v[i + 1] * ax) * (1 - ay) + (v[i + grid.w] * (1 - ax) + v[i + grid.w + 1] * ax) * ay;
}

// ---------- DEM 격자 → 월드 좌표 + 경사 ----------
// 격자 한 칸마다 경사(°)를 미리 계산 (0.5° 단위로 저장). 이웃 칸과의 실제 높이 차로 계산
function slopeGrid(g) {
  const { w, h, values: v } = g;
  const dx = (g.e1 - g.e0) / (w - 1);
  const dy = (g.n1 - g.n0) / (h - 1);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const yu = Math.max(0, y - 1), yd = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1);
      const gx = (v[y * w + xr] - v[y * w + xl]) / ((xr - xl) * dx);
      const gy = (v[yu * w + x] - v[yd * w + x]) / ((yd - yu) * dy);
      out[y * w + x] = Math.min(255, Math.round(((Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI) * 2));
    }
  }
  return out;
}

function worldGrid(dem) {
  const b = dem.bounds;
  const nw = worldOf({ lon: b.lonMin, lat: b.latMax });
  const se = worldOf({ lon: b.lonMax, lat: b.latMin });
  const g = { key: dem.key, w: dem.w, h: dem.h, values: dem.values, e0: nw.e, e1: se.e, n0: se.n, n1: nw.n };
  g.slope = slopeGrid(g);
  return g;
}

// DEM 불러오기 (three.js 없이도 고도 · 경사 위험도는 동작)
function loadHudTerrainData() {
  if (!hud3d.dataPromise) {
    hud3d.dataPromise = Promise.allSettled(DEM_ORDER.map(loadDemGrid)).then((results) => {
      hud3d.grids = results.filter((r) => r.status === "fulfilled").map((r) => worldGrid(r.value));
      const failed = results.find((r) => r.status === "rejected");
      if (failed) console.warn("DEM 일부 불러오기 실패", failed.reason);
    });
  }
  return hud3d.dataPromise;
}

function gridAt(e, n) {
  for (const g of hud3d.grids) {
    if (e >= g.e0 && e <= g.e1 && n >= g.n0 && n <= g.n1) return g;
  }
  return null;
}

// 월드 좌표 (지역 중심 기준 동 e, 북 n, m) 의 실제 지형 높이 (m, DEM 절대값)
function terrainHeight(e, n) {
  const g = gridAt(e, n);
  if (!g) return TERRAIN_BASE_M;
  return sampleGrid(g, ((e - g.e0) / (g.e1 - g.e0)) * (g.w - 1), ((g.n1 - n) / (g.n1 - g.n0)) * (g.h - 1));
}

// 월드 좌표의 실제 경사 (°). 지형 데이터가 없으면 null
function slopeAt(e, n) {
  const g = gridAt(e, n);
  if (!g) return null;
  const x = Math.round(((e - g.e0) / (g.e1 - g.e0)) * (g.w - 1));
  const y = Math.round(((g.n1 - n) / (g.n1 - g.n0)) * (g.h - 1));
  return g.slope[y * g.w + x] / 2;
}

// 3D 장면 속 높이: 화성이 둥글어서 멀리 있는 지형은 그만큼 아래로 내려가 보임 (80 km 밖 → 약 940 m)
function sceneY(e, n, h = terrainHeight(e, n)) {
  const de = e - hud3d.origin.e;
  const dn = n - hud3d.origin.n;
  return h - TERRAIN_BASE_M - (de * de + dn * dn) / (2 * MARS_RADIUS_M);
}

// 아래 가운데 지형 정보 캡슐: 고도 · 발밑 경사 · 모래 빠짐 위험 · 데이터 출처
// 기지와의 통신 상태: 기지 안테나에서 지금 서 있는 곳이 직선으로 보이는지 (js/environment.js envCommMap, 지형 + 화성 곡률)
//  연결 = 가까운 기지까지 거리와 함께 · 음영 = 지형에 가려 끊김 · 기지 없음 = 아직 기지를 세우지 않음
function baseCommItem(here, item) {
  if (!here || typeof getBases !== "function") return "";
  const bases = getBases();
  if (!bases.length) return item("기지 통신", "기지 없음", `<i class="hud-terrain__dot is-off"></i>`);
  const nearest = Math.min(...bases.map((b) => distanceM(here, b)));
  let linked = false;
  if (typeof survey !== "undefined" && survey.loaded && typeof envCommMap === "function") {
    const vis = envCommMap();
    const cell = envCellOf(here);
    linked = !!(vis && cell !== -1 && vis[cell]);
  }
  return linked
    ? item("기지 통신", `연결 · ${formatKm(nearest)}`, `<i class="hud-terrain__dot"></i>`)
    : item("기지 통신", "음영", `<i class="hud-terrain__dot is-high"></i>`);
}

let terrainStatusT = 0;
function updateTerrainStatus(now) {
  if (now - terrainStatusT < 250) return;
  terrainStatusT = now;
  const { e, n } = hud.world;
  const g = gridAt(e, n);
  if (!g) {
    hudTerrainStatus.innerHTML = `<span class="hud-terrain__msg">${hud3d.grids.length ? "DEM 범위 밖" : "지형 데이터 불러오는 중…"}</span>`;
    return;
  }
  const here = getCurrentPosition();
  const sand = here && sandRiskAt(here.lon, here.lat);
  const item = (label, value, extra = "") =>
    `<div class="hud-terrain__item"><span class="hud-terrain__label">${label}</span><span class="hud-terrain__value">${extra}${value}</span></div>`;
  hudTerrainStatus.innerHTML =
    item("고도", formatElevation(terrainHeight(e, n))) +
    item("발밑 경사", `${slopeAt(e, n).toFixed(1)}°`) +
    (sand ? item("모래 빠짐", sand.name, `<i class="hud-terrain__dot is-${sand.risk}"></i>`) : "") +
    baseCommItem(here, item) +
    `<span class="hud-terrain__src">${DEM_LABELS[g.key]}</span>`;
}

// ---------- 3D 지형 메시 ----------
// 높이 격자를 지형 메시로 (PlaneGeometry: 위쪽 줄 = 북쪽)
//  hole: 더 정밀한 격자가 덮는 범위 → 그 안쪽 칸은 만들지 않음 (겹쳐서 깜빡이는 것 방지)
function terrainMesh(grid, segW, segH, material, { lift = 0, hole = null } = {}) {
  const width = grid.e1 - grid.e0;
  const depth = grid.n1 - grid.n0;
  const cx = (grid.e0 + grid.e1) / 2;
  const cn = (grid.n0 + grid.n1) / 2;
  const geo = new THREE.PlaneGeometry(width, depth, segW, segH);
  geo.rotateX(-Math.PI / 2); // (x, y) → (x, 0, -y) : 북쪽 = -z
  const pos = geo.attributes.position;
  for (let r = 0; r <= segH; r++) {
    for (let c = 0; c <= segW; c++) {
      const h = sampleGrid(grid, (c / segW) * (grid.w - 1), (r / segH) * (grid.h - 1));
      pos.setY(r * (segW + 1) + c, sceneY(grid.e0 + (c / segW) * width, grid.n1 - (r / segH) * depth, h) + lift);
    }
  }
  geo.computeVertexNormals();

  if (hole) {
    const cw = width / segW;
    const ch = depth / segH;
    const src = geo.index.array;
    const kept = [];
    for (let r = 0; r < segH; r++) {
      for (let c = 0; c < segW; c++) {
        const e0 = grid.e0 + c * cw, n1 = grid.n1 - r * ch;
        // 한 칸 여유를 두고 완전히 안쪽에 있는 칸만 뺌 (가장자리는 겹쳐서 틈이 없게)
        if (e0 - cw >= hole.e0 && e0 + 2 * cw <= hole.e1 && n1 + ch <= hole.n1 && n1 - 2 * ch >= hole.n0) continue;
        const i = (r * segW + c) * 6;
        for (let k = 0; k < 6; k++) kept.push(src[i + k]);
      }
    }
    geo.setIndex(kept);
  }

  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(cx, 0, -cn);
  return mesh;
}

function photoMaterial(texture) {
  texture.encoding = THREE.sRGBEncoding;
  texture.anisotropy = 8;
  return new THREE.MeshLambertMaterial({ map: texture, color: 0xe0a77c }); // 흑백 사진을 화성 색으로
}

// 화성 낮 하늘 (위는 어둡고 지평선은 밝은 버터스카치 색)
function marsSky() {
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 256;
  const t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  paintSky(t, SKY_DAY);
  return t;
}

// ---------- 생생함: 화성 시각에 맞는 해 · 하늘 · 별 · 떠다니는 먼지 ----------
// 하늘 색 [위, 가운데, 지평선] + 안개 색. 낮 = 버터스카치, 해 질 녘 = 푸르스름한 회색 (화성 노을은 파란색), 밤 = 거의 검정
const SKY_DAY = { top: [91, 70, 54], mid: [185, 141, 104], low: [226, 191, 152], fog: [207, 164, 124] };
const SKY_DUSK = { top: [38, 40, 58], mid: [96, 96, 112], low: [150, 158, 176], fog: [120, 118, 126] };
const SKY_NIGHT = { top: [3, 4, 8], mid: [8, 9, 15], low: [20, 17, 16], fog: [14, 12, 12] };

function mixRgb(a, b, t) {
  return a.map((v, i) => v + (b[i] - v) * t);
}
function mixSky(a, b, t) {
  return { top: mixRgb(a.top, b.top, t), mid: mixRgb(a.mid, b.mid, t), low: mixRgb(a.low, b.low, t), fog: mixRgb(a.fog, b.fog, t) };
}
const cssRgb = (c) => `rgb(${c.map(Math.round).join(",")})`;
const smooth01 = (x) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

function paintSky(texture, sky) {
  const g = texture.image.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, cssRgb(sky.top));
  grad.addColorStop(0.55, cssRgb(sky.mid));
  grad.addColorStop(1, cssRgb(sky.low));
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  texture.needsUpdate = true;
}

// 가운데가 밝고 가장자리로 사라지는 둥근 점 (해 · 먼지 알갱이)
function glowTexture(stops) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

const DUST_COUNT = 420;
const DUST_BOX_M = 36; // 나를 중심으로 이 크기 상자 안에서만 떠다님 (벗어나면 반대편으로)
const DUST_TOP_M = 7;

function buildAtmosphere(scene, ambient, sun) {
  // 해: 작은 원반 + 넓은 빛무리
  const sunSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture([[0, "rgba(255,255,255,1)"], [0.06, "rgba(255,255,255,1)"], [0.1, "rgba(255,255,255,0.45)"], [0.35, "rgba(255,255,255,0.12)"], [1, "rgba(255,255,255,0)"]]),
      fog: false,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  sunSprite.scale.set(52000, 52000, 1);
  sunSprite.renderOrder = -1;
  scene.add(sunSprite);

  // 별: 밤에만 보임
  const starPos = new Float32Array(700 * 3);
  for (let i = 0; i < 700; i++) {
    const az = Math.random() * Math.PI * 2;
    const el = Math.asin(Math.random()); // 지평선 위 반구
    starPos.set([Math.cos(el) * Math.sin(az) * 300000, Math.sin(el) * 300000 + 1500, Math.cos(el) * Math.cos(az) * 300000], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0, depthWrite: false }));
  stars.frustumCulled = false;
  scene.add(stars);

  // 먼지: 바람에 실려 흘러가는 작은 알갱이
  const dustPos = new Float32Array(DUST_COUNT * 3);
  for (let i = 0; i < DUST_COUNT; i++) {
    dustPos.set([(Math.random() - 0.5) * DUST_BOX_M, Math.random() * DUST_TOP_M, (Math.random() - 0.5) * DUST_BOX_M], i * 3);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(
    dustGeo,
    new THREE.PointsMaterial({
      map: glowTexture([[0, "rgba(255,255,255,1)"], [0.4, "rgba(255,255,255,0.5)"], [1, "rgba(255,255,255,0)"]]),
      color: 0xf6d9b8,
      size: 0.12,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    })
  );
  dust.frustumCulled = false;
  scene.add(dust);

  hud3d.atmo = { ambient, sun, sunSprite, stars, dust, checkT: 0, key: "", lastT: 0 };
}

// 화성 시각(시계)의 태양 위치로 해 방향 · 빛 · 하늘 색을 맞춤. 시계를 돌리면 HUD 도 같이 바뀜
function updateAtmosphere(now) {
  const A = hud3d.atmo;
  if (!A) return;
  const cam = hud3d.camera;

  if (now - A.checkT > 500) {
    A.checkT = now;
    const here = getCurrentPosition();
    const sp = here ? sunPosition(marsClock.now(), here.lon, here.lat) : { elevationDeg: 45, azimuthDeg: 120 };
    const key = `${sp.elevationDeg.toFixed(1)}|${sp.azimuthDeg.toFixed(1)}`;
    if (key !== A.key) {
      A.key = key;
      const el = (sp.elevationDeg * Math.PI) / 180;
      const az = (sp.azimuthDeg * Math.PI) / 180;
      A.dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)); // 동 x · 위 y · 북 −z
      const day = smooth01((sp.elevationDeg + 5) / 17); // −5° 아래 = 밤, 12° 위 = 한낮
      const dusk = Math.max(0, 1 - Math.abs(sp.elevationDeg - 2) / 11); // 해가 지평선 근처일 때
      const sky = mixSky(mixSky(SKY_NIGHT, SKY_DAY, day), SKY_DUSK, dusk * 0.75);
      paintSky(hud3d.scene.background, sky);
      hud3d.scene.fog.color.setRGB(sky.fog[0] / 255, sky.fog[1] / 255, sky.fog[2] / 255).convertSRGBToLinear();
      // 빛: 낮에는 따뜻한 햇빛, 해가 낮으면 붉고 약하게, 밤에는 푸른 어스름만
      A.sun.position.copy(A.dir.y > 0.08 ? A.dir : new THREE.Vector3(A.dir.x, 0.08, A.dir.z)).normalize();
      A.sun.intensity = 0.8 * day; // 해가 높아도 땅이 하얗게 날아가지 않을 만큼만
      A.sun.color.setRGB(1, 0.94 - 0.2 * dusk, 0.86 - 0.36 * dusk);
      A.ambient.intensity = 0.2 + 0.25 * day;
      A.ambient.color.setRGB(0.72 + 0.28 * day, 0.78 + 0.22 * day, 1);
      // 해: 낮 = 흰 노랑, 노을 = 푸른 흰색 (화성 대기 먼지가 푸른 빛을 앞으로 산란)
      A.sunSprite.visible = sp.elevationDeg > -3;
      A.sunSprite.material.color.setRGB(1 - 0.35 * dusk, 0.95 - 0.12 * dusk, 0.84 + 0.16 * dusk);
      A.sunSprite.material.opacity = 0.35 + 0.65 * smooth01((sp.elevationDeg + 3) / 8);
      A.stars.material.opacity = 0.9 * (1 - day);
      A.dust.material.opacity = 0.14 + 0.42 * day;
    }
  }
  if (A.dir) A.sunSprite.position.copy(cam.position).addScaledVector(A.dir, 250000);
  A.stars.position.set(cam.position.x, cam.position.y - 1500, cam.position.z);

  // 먼지: 바람(서 → 동, 약 1.3 m/s) + 살짝 일렁임. 나를 따라오는 상자 안에서 돌고 돎
  const dt = Math.min(0.1, A.lastT ? (now - A.lastT) / 1000 : 0);
  A.lastT = now;
  const pos = A.dust.geometry.attributes.position;
  const arr = pos.array;
  const half = DUST_BOX_M / 2;
  const t = now / 1000;
  for (let i = 0; i < DUST_COUNT; i++) {
    const j = i * 3;
    arr[j] += (1.3 + 0.5 * Math.sin(t * 0.7 + i)) * dt;
    arr[j + 1] += 0.12 * Math.sin(t * 1.1 + i * 1.7) * dt;
    arr[j + 2] += 0.35 * Math.cos(t * 0.5 + i * 0.9) * dt;
    // 상자 밖으로 나가면 반대편에서 다시 (내가 걸어가도 항상 주변에 있게)
    let dx = arr[j] - cam.position.x;
    let dz = arr[j + 2] - cam.position.z;
    if (dx > half) arr[j] -= DUST_BOX_M;
    else if (dx < -half) arr[j] += DUST_BOX_M;
    if (dz > half) arr[j + 2] -= DUST_BOX_M;
    else if (dz < -half) arr[j + 2] += DUST_BOX_M;
    const ground = cam.position.y - EYE_HEIGHT_M;
    if (arr[j + 1] < ground + 0.1) arr[j + 1] = ground + DUST_TOP_M - 0.2;
    else if (arr[j + 1] > ground + DUST_TOP_M) arr[j + 1] = ground + 0.2;
  }
  pos.needsUpdate = true;
}

async function initTerrain3D() {
  const cfg = REGIONS[currentRegion]?.hudTerrain;
  if (hud3d.ready || hud3d.loading || hud3d.failed || !cfg) return;
  hud3d.loading = true;
  hudLoading.hidden = false;

  try {
    await loadHudTerrainData(); // 고도 · 경사는 여기까지만 돼도 동작
    const grid = (key) => hud3d.grids.find((g) => g.key === key);
    const near = grid("near"), far = grid("hirise"), wide = grid("mola");
    if (!near || !far) throw new Error("DEM 불러오기 실패 (file:// 로 열었다면 로컬 서버 필요)");
    hud3d.origin = { ...hud.world };

    await loadScriptOnce(THREE_URL);

    // 장면
    const renderer = new THREE.WebGLRenderer({ canvas: hudTerrainCanvas, antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputEncoding = THREE.sRGBEncoding;
    const scene = new THREE.Scene();
    scene.background = marsSky();
    scene.fog = new THREE.Fog(0xcfa47c, 600, 200000); // 먼지 낀 대기 (80 km 밖 크레이터 테두리가 흐릿하게 보일 정도)
    const camera = new THREE.PerspectiveCamera(60, 1, 0.3, 400000);
    camera.rotation.order = "YXZ";

    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xfff0dc, 1.05); // 방향 · 세기는 화성 시각에 맞춰 updateAtmosphere 가 정함
    sun.position.set(-0.6, 0.55, 0.45).normalize();
    scene.add(sun);
    buildAtmosphere(scene, ambient, sun);

    const loader = new THREE.TextureLoader();
    const [nearTex, farTex] = await Promise.all([
      loader.loadAsync(cfg.surface),
      loader.loadAsync(mapImage.getAttribute("src")),
    ]);
    // 광역(MOLA)은 사진이 없어 화성 색 + 음영만
    if (wide) scene.add(terrainMesh(wide, 516, 500, new THREE.MeshLambertMaterial({ color: 0x8a6548 }), { lift: -3, hole: far }));
    scene.add(terrainMesh(far, 300, 290, photoMaterial(farTex), { lift: -1.5, hole: near }));
    // 5 m 간격 (경사 계산은 2 m 격자 그대로). 발밑은 고해상도 타일이 덮으므로 그 아래로 살짝 내림
    scene.add(terrainMesh(near, 600, 600, photoMaterial(nearTex), { lift: -0.4 }));

    Object.assign(hud3d, { renderer, scene, camera, ready: true });
    rebuildHudBases();
    hudTerrainCanvas.hidden = false;
    hudScene.hidden = true; // 파노라마 대신 실제 지형
    resizeTerrain3D();
  } catch (e) {
    console.warn("실제 지형 3D 준비 실패 → 파노라마로 표시", e);
    hud3d.failed = true;
  } finally {
    hud3d.loading = false;
    hudLoading.hidden = true;
  }
}

// ---------- 기지 건물 (포인트 종류 "기지") ----------
// 돔형 거주동 + 원통 모듈 2개 + 에어록 + 온실 + 통신 마스트 + 태양광 패널 + 착륙 패드. 단위 m
function buildBaseMesh() {
  const T = THREE;
  const mat = (color, extra) => new T.MeshLambertMaterial({ color, ...extra });
  const hull = mat(0xe9e4dc);
  const hullDark = mat(0xb9b2a8);
  const metal = mat(0x6f7378);
  const glow = new T.MeshBasicMaterial({ color: 0xffd98a });
  const g = new T.Group();
  const add = (geo, m, x, y, z, rot) => {
    const mesh = new T.Mesh(geo, m);
    mesh.position.set(x, y, z);
    if (rot) mesh.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
    g.add(mesh);
    return mesh;
  };

  // 기초 (땅이 기울어도 뜨지 않게 아래로 깊이) + 착륙 패드
  add(new T.CylinderGeometry(27, 29, 8, 40), mat(0x7a5a44), 0, -3.6, 0);
  add(new T.CylinderGeometry(11, 11, 0.3, 32), mat(0x4a4744), 46, 0.3, 10);
  add(new T.RingGeometry(7.5, 8.3, 32), new T.MeshBasicMaterial({ color: 0xf2f2f2, side: T.DoubleSide }), 46, 0.5, 10, [-Math.PI / 2]);

  // 중앙 돔 거주동
  add(new T.CylinderGeometry(9, 9, 2.4, 32), hullDark, 0, 1.6, 0);
  add(new T.SphereGeometry(9, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), hull, 0, 2.8, 0);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    add(new T.BoxGeometry(1.5, 0.9, 0.3), glow, Math.sin(a) * 8.6, 4.6, Math.cos(a) * 8.6, [0, a]); // 창문
  }
  add(new T.CylinderGeometry(1.6, 2.2, 1.2, 16), hullDark, 0, 12.1, 0); // 천장 해치

  // 양옆 원통 모듈 (실험동 · 숙소) + 연결 통로
  for (const side of [-1, 1]) {
    const x = side * 19;
    add(new T.CylinderGeometry(3.4, 3.4, 15, 24), hull, x, 3.6, 0, [Math.PI / 2]);
    add(new T.SphereGeometry(3.4, 24, 12), hull, x, 3.6, 7.5);
    add(new T.SphereGeometry(3.4, 24, 12), hull, x, 3.6, -7.5);
    add(new T.CylinderGeometry(1.5, 1.5, 9, 16), hullDark, side * 12, 3, 0, [0, 0, Math.PI / 2]);
    for (const z of [-4, 0, 4]) add(new T.BoxGeometry(0.3, 0.9, 1.6), glow, x + side * 3.3, 4.2, z);
    for (const z of [-5, 5]) add(new T.BoxGeometry(5.5, 0.6, 0.8), metal, x, 0.5, z); // 받침
  }

  // 에어록 (남쪽 = +z) : 문 + 경사로
  add(new T.BoxGeometry(4.2, 3.6, 6), hullDark, 0, 2.2, 11.5);
  add(new T.BoxGeometry(2, 2.5, 0.2), mat(0x34373c), 0, 1.9, 14.55);
  add(new T.BoxGeometry(2.6, 0.2, 4), metal, 0, 0.45, 16.4, [0.12]);
  add(new T.BoxGeometry(0.5, 0.5, 0.25), new T.MeshBasicMaterial({ color: 0x59ff9c }), 1.5, 3.4, 14.6); // 상태등

  // 온실 (반원통, 반투명 초록)
  add(
    new T.CylinderGeometry(4, 4, 13, 24, 1, false, 0, Math.PI),
    mat(0x8fe3a2, { transparent: true, opacity: 0.55, side: T.DoubleSide }),
    0, 0.7, -17, [0, 0, Math.PI / 2]
  );
  add(new T.BoxGeometry(13, 0.5, 8), mat(0x3d5a3a), 0, 0.6, -17);

  // 통신 마스트 (높이 = 통신 가시성 계산의 안테나 높이) + 접시 + 경고등
  const mastH = typeof COMM_ANTENNA_M === "number" ? COMM_ANTENNA_M : 12;
  add(new T.CylinderGeometry(0.18, 0.3, mastH, 8), metal, -9, mastH / 2 + 0.8, -9);
  add(new T.ConeGeometry(1.7, 0.9, 20, 1, true), mat(0xdddddd, { side: T.DoubleSide }), -9, mastH - 1, -8.2, [Math.PI / 2.6]);
  const beacon = add(new T.SphereGeometry(0.35, 10, 8), new T.MeshBasicMaterial({ color: 0xff3b30 }), -9, mastH + 1.1, -9);
  beacon.name = "beacon";

  // 태양광 패널 3열
  for (let k = 0; k < 3; k++) {
    const z = -8 + k * 8;
    add(new T.BoxGeometry(9, 0.15, 5), mat(0x1b2d5c), -36, 2.3, z, [0, 0, -0.45]);
    add(new T.BoxGeometry(8.6, 0.05, 4.6), new T.MeshBasicMaterial({ color: 0x2f4f9e }), -36.03, 2.42, z, [0, 0, -0.45]);
    add(new T.CylinderGeometry(0.12, 0.12, 2.4, 6), metal, -36, 1.1, z);
  }
  // 연료 · 물 탱크
  for (const z of [-3, 3]) add(new T.SphereGeometry(2.2, 16, 12), mat(0xc9ccd1), 33, 2.4, z);
  add(new T.BoxGeometry(6, 0.5, 11), metal, 33, 0.4, 0);
  return g;
}

// 기지 건물의 충돌 범위 (buildBaseMesh 와 같은 좌표: x = 동쪽, z = 남쪽, 단위 m). 사람 몸 두께만큼 여유 0.6 m
const BASE_PAD_M = 0.6;
const BASE_SOLIDS = [
  { circle: [0, 0, 9] }, // 중앙 돔
  { box: [-22.4, -11, -15.6, 11] }, // 서쪽 모듈 (x0, z0, x1, z1)
  { box: [15.6, -11, 22.4, 11] }, // 동쪽 모듈
  { box: [-16.5, -1.5, 16.5, 1.5] }, // 연결 통로
  { box: [-2.1, 8, 2.1, 14.6] }, // 에어록
  { box: [-6.5, -21, 6.5, -13] }, // 온실
  { box: [-40.5, -10.6, -31.5, 10.6] }, // 태양광 패널
  { box: [30, -5.5, 36, 5.5] }, // 연료 · 물 탱크
  { circle: [-9, -9, 0.4] }, // 통신 마스트
];

function insideBase(e, n) {
  for (const p of typeof getBases === "function" ? getBases() : []) {
    const b = worldOf(p);
    const x = e - b.e, z = -(n - b.n);
    if (Math.abs(x) > 45 || Math.abs(z) > 30) continue;
    for (const s of BASE_SOLIDS) {
      if (s.circle) {
        if (Math.hypot(x - s.circle[0], z - s.circle[1]) < s.circle[2] + BASE_PAD_M) return true;
      } else if (x > s.box[0] - BASE_PAD_M && x < s.box[2] + BASE_PAD_M && z > s.box[1] - BASE_PAD_M && z < s.box[3] + BASE_PAD_M) {
        return true;
      }
    }
  }
  return false;
}

// (e, n) 에서 (mE, mN) 만큼 움직이는 길이 건물에 막히는지. 빨리 움직여도 얇은 벽을 건너뛰지 않게 0.4 m 씩 확인
// 이미 건물 안에 있으면 (기지를 내 발밑에 세운 경우) 빠져나올 수 있게 막지 않음
function baseBlocksMove(e, n, mE, mN) {
  if (insideBase(e, n)) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(mE, mN) / 0.4));
  for (let k = 1; k <= steps; k++) {
    if (insideBase(e + (mE * k) / steps, n + (mN * k) / steps)) return true;
  }
  return false;
}

function rebuildHudBases() {
  if (!hud3d.ready) return;
  if (hud3d.bases) hud3d.scene.remove(hud3d.bases);
  hud3d.bases = new THREE.Group();
  for (const p of typeof getBases === "function" ? getBases() : []) {
    const { e, n } = worldOf(p);
    const mesh = buildBaseMesh();
    mesh.position.set(e, sceneY(e, n), -n);
    hud3d.bases.add(mesh);
  }
  hud3d.scene.add(hud3d.bases);
}
document.addEventListener("pointschange", rebuildHudBases);
document.addEventListener("regionchange", rebuildHudBases);

function resizeTerrain3D() {
  if (!hud3d.ready) return;
  const w = hudView.clientWidth;
  const h = hudView.clientHeight;
  hud3d.renderer.setSize(w, h, false);
  hud3d.camera.aspect = w / h;
  hud3d.camera.updateProjectionMatrix();
}
window.addEventListener("resize", () => hud.on && resizeTerrain3D());

// 내 위치·방향으로 카메라를 옮기고 그리기
function updateTerrainCamera() {
  const cam = hud3d.camera;
  const { e, n } = hud.world;
  // 걸음: 위아래 출렁임 + 좌우로 살짝 기우뚱. 멈추면 서서히 가라앉고, 서 있을 때는 숨 쉬는 정도로만 움직임
  hud.walkAmp = (hud.walkAmp || 0) + ((hud.moving ? 1 : 0) - (hud.walkAmp || 0)) * 0.12;
  const breath = Math.sin(performance.now() / 1900) * 0.006;
  const bob = Math.sin(hud.bob) * 0.06 * hud.walkAmp + breath;
  cam.position.set(e, sceneY(e, n) + EYE_HEIGHT_M + bob, -n);
  cam.rotation.y = (-hud.heading * Math.PI) / 180; // 0° = 북쪽(-z), 시계 방향으로 회전
  cam.rotation.x = (hud.pitch * Math.PI) / 180; // 고개 들기/숙이기
  cam.rotation.z = Math.sin(hud.bob / 2) * 0.007 * hud.walkAmp; // 한 걸음마다 좌 · 우
  cam.updateMatrixWorld();
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
}

// ---------- 발밑 고해상도 타일 (0.25 m/px 사진 + 2 m 간격 지형) ----------
// 근거리 3 km 를 250 m 타일 12 × 12 장으로 나눠 두고 (js/data/hud_tiles.js),
// 서 있는 타일과 그 주변 8장만 불러옴. 멀어진 타일은 메모리에서 지움.
const TILE_SEGMENTS = 125; // 250 m / 2 m (근거리 DEM 간격)
const TILE_KEEP = 2; // 이 칸 수보다 멀어지면 지움

function tileWorldBounds(r, c) {
  const t = HUD_TILES;
  const b = t.bounds;
  const dLon = (b.lonMax - b.lonMin) / t.cols;
  const dLat = (b.latMax - b.latMin) / t.rows;
  const nw = worldOf({ lon: b.lonMin + c * dLon, lat: b.latMax - r * dLat });
  const se = worldOf({ lon: b.lonMin + (c + 1) * dLon, lat: b.latMax - (r + 1) * dLat });
  return { e0: nw.e, e1: se.e, n0: se.n, n1: nw.n };
}

function tileMesh(r, c, texture) {
  const { e0, e1, n0, n1 } = tileWorldBounds(r, c);
  const seg = TILE_SEGMENTS;
  const geo = new THREE.PlaneGeometry(e1 - e0, n1 - n0, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  for (let y = 0; y <= seg; y++) {
    for (let x = 0; x <= seg; x++) {
      const e = e0 + ((e1 - e0) * x) / seg;
      const n = n1 - ((n1 - n0) * y) / seg;
      const i = y * (seg + 1) + x;
      pos.setY(i, sceneY(e, n));
      // 음영용 법선: 타일 경계에서도 이어지도록 메시가 아니라 지형 기울기에서 직접 계산 (장면 좌표: x = 동, y = 위, z = -북)
      const ge = (terrainHeight(e + 2, n) - terrainHeight(e - 2, n)) / 4;
      const gn = (terrainHeight(e, n + 2) - terrainHeight(e, n - 2)) / 4;
      const len = Math.hypot(ge, 1, gn);
      nor.setXYZ(i, -ge / len, 1 / len, gn / len);
    }
  }
  const mesh = new THREE.Mesh(geo, photoMaterial(texture));
  mesh.position.set((e0 + e1) / 2, 0, -(n0 + n1) / 2);
  return mesh;
}

function updateHudTiles(now) {
  if (typeof HUD_TILES === "undefined" || now - hud3d.tileCheckT < 300) return;
  hud3d.tileCheckT = now;
  const here = getCurrentPosition();
  const t = HUD_TILES;
  const b = t.bounds;
  const c0 = Math.floor(((here.lon - b.lonMin) / (b.lonMax - b.lonMin)) * t.cols);
  const r0 = Math.floor(((b.latMax - here.lat) / (b.latMax - b.latMin)) * t.rows);

  // 필요한 타일 불러오기 (가까운 것부터)
  const wanted = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r >= 0 && c >= 0 && r < t.rows && c < t.cols) wanted.push([Math.abs(dr) + Math.abs(dc), r, c]);
    }
  }
  wanted.sort((a, b) => a[0] - b[0]);
  for (const [, r, c] of wanted) {
    const key = `${r}-${c}`;
    if (hud3d.tiles.has(key)) continue;
    const entry = { loading: true, mesh: null };
    hud3d.tiles.set(key, entry);
    new THREE.TextureLoader().load(
      t.url.replace("{r}", r).replace("{c}", c),
      (tex) => {
        if (hud3d.tiles.get(key) !== entry) return tex.dispose(); // 그 사이 지워짐
        entry.mesh = tileMesh(r, c, tex);
        entry.loading = false;
        hud3d.scene.add(entry.mesh);
      },
      undefined,
      () => {
        if (hud3d.tiles.get(key) === entry) hud3d.tiles.delete(key); // 실패하면 다음 확인 때 다시 시도
      }
    );
  }

  // 멀어진 타일 지우기
  for (const [key, entry] of hud3d.tiles) {
    const [r, c] = key.split("-").map(Number);
    if (Math.abs(r - r0) <= TILE_KEEP && Math.abs(c - c0) <= TILE_KEEP) continue;
    if (entry.mesh) {
      hud3d.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.mesh.material.map.dispose();
      entry.mesh.material.dispose();
    }
    hud3d.tiles.delete(key);
  }
}

// 위치가 크게 바뀌면 (위치 보정 등) 타일을 모두 새로 고름
function resetHudTiles() {
  for (const [key] of hud3d.tiles) {
    const entry = hud3d.tiles.get(key);
    if (entry.mesh) {
      hud3d.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.mesh.material.map.dispose();
      entry.mesh.material.dispose();
    }
  }
  hud3d.tiles.clear();
  hud3d.tileCheckT = 0;
}

function renderTerrain3D() {
  updateHudTiles(performance.now());
  // 기지 통신 마스트 경고등 깜빡임
  if (hud3d.bases) {
    const on = Math.floor(performance.now() / 600) % 2 === 0;
    hud3d.bases.traverse((o) => o.name === "beacon" && (o.visible = on));
  }
  updateTerrainCamera();
  updateAtmosphere(performance.now());
  hud3d.renderer.render(hud3d.scene, hud3d.camera);
}

// ---------- 공통 투영: 나 기준 (동 de, 북 dn) m 지점 → 화면 좌표 ----------
// 3D 지형이면 그 지점의 실제 지형 높이(+up) 를 카메라로 투영, 아니면 파노라마(원통) 투영
let projTmp = null;
function projectRel(L, de, dn, up = 0.08) {
  const d = Math.hypot(de, dn);
  if (hud3d.ready) {
    const e = hud.world.e + de;
    const n = hud.world.n + dn;
    projTmp = projTmp || new THREE.Vector3();
    projTmp.set(e, sceneY(e, n) + up, -n);
    projTmp.applyMatrix4(hud3d.camera.matrixWorldInverse);
    if (projTmp.z > -0.3) return null; // 카메라 뒤
    projTmp.applyMatrix4(hud3d.camera.projectionMatrix);
    const x = ((projTmp.x + 1) / 2) * L.W;
    const y = ((1 - projTmp.y) / 2) * L.H;
    if (x < -80 || x > L.W + 80 || y < -80 || y > L.H + 200) return null;
    return { x, y, d };
  }
  const h = (hud.heading * Math.PI) / 180;
  const forward = de * Math.sin(h) + dn * Math.cos(h);
  const right = de * Math.cos(h) - dn * Math.sin(h);
  if (forward <= 0.4) return null;
  const angle = (Math.atan2(right, forward) * 180) / Math.PI;
  if (Math.abs(angle) > L.fov / 2 + 10) return null;
  return { x: L.W / 2 + angle * L.pxPerDeg, y: L.horizonY + Math.atan(EYE_HEIGHT_M / Math.max(d, 0.1)) * L.pxPerRad - (up > 1 ? 40 : 0), d };
}
