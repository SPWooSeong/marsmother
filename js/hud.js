// Mars Mother - HUD 모드 (AR 데모)
// 왼쪽 아래 HUD 창을 누르면 1인칭 AR 화면으로 전환되고, 그 창은 2D 미니맵이 됨.
// 배경: data/ 의 실제 DEM(지형 높이) + 가시광 모자이크(표면 사진)로 그린 1인칭 3D 지형 (three.js).
//       3D를 쓸 수 없으면 360° 파노라마 사진으로 대신 표시.
// TODO: 카메라 영상, 실제 방위 센서, DEM 기반 위험도, 실제 생체 신호로 교체
//
// 사용하는 전역 값: REGIONS, currentRegion, POINT_TYPES, getPoints, mapImage, lonLatToImage,
// formatLonLat (main.js) / getCurrentPosition, nav, DEG_TO_M (route.js)

// ---------- 설정 ----------
const HUD_PANO = "assets/photos/pano-1.jpg";
const HORIZON_RATIO = 0.42; // 파노라마 사진에서 지평선 높이 (위에서부터 비율)
const EYE_HEIGHT_M = 1.7; // 눈높이
const SCAN_RANGE_M = 45; // 스캔 거리
const GRID_M = 1.6; // 스캔 격자 간격
const COMPASS_SPAN_DEG = 150; // 방위 표시줄에 보이는 각도 범위
const MINIMAP_ZOOM = 2.5;

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
  demoRoute: null, // 길찾기 결과가 없을 때 쓰는 데모 경로
};

// 파노라마 비율 읽기
const hudPanoImg = new Image();
hudPanoImg.onload = () => (hud.aspect = hudPanoImg.naturalWidth / hudPanoImg.naturalHeight);
hudPanoImg.src = HUD_PANO;
hudScene.style.backgroundImage = `url("${HUD_PANO}")`;

// ---------- 모드 전환 ----------
function setHudMode(on) {
  hud.on = on;
  document.body.classList.toggle("is-hud", on);
  hudView.hidden = !on;
  hudCardTitle.textContent = on ? "2D 지도" : "HUD";
  hudPreview.setAttribute("aria-label", on ? "2D 지도로 돌아가기" : "HUD 모드로 전환");
  hudPreview.classList.toggle("is-minimap", on);

  if (on) {
    setHudVisible(true); // HUD 창이 꺼져 있었다면 켜기 (돌아갈 버튼이므로)
    resizeHudCanvas();
    buildVitals();
    hud.lastCompassHeading = null;
    hud.lastT = 0;
    hud.keys.clear();
    syncWorldPosition();
    prepareDemoRoute();
    initTerrain3D(); // 처음 한 번 실제 지형 불러오기 (비동기)
    resizeTerrain3D();
    hud.raf = requestAnimationFrame(hudFrame);
  } else {
    cancelAnimationFrame(hud.raf);
    hudPreview.removeAttribute("style");
    hud.keys.clear();
    if (typeof renderNavMap === "function") renderNavMap(); // 2D 지도의 현위치 갱신
  }
}

hudPreview.addEventListener("click", () => setHudMode(!hud.on));

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

// ---------- 지형 스캔 (데모 위험도) ----------
// 실제로는 DEM 경사, 모래 지대, 방사선 등으로 계산할 값. 지금은 부드러운 가짜 노이즈.
function hazardAt(x, z) {
  return (
    0.5 +
    0.25 * Math.sin(x * 0.11 + 0.7) * Math.cos(z * 0.09 - 0.3) +
    0.2 * Math.sin((x * 0.6 + z) * 0.045 + 2) +
    0.1 * Math.sin(x * 0.31) * Math.sin(z * 0.27)
  );
}

function hazardLevel(v) {
  if (v < 0.56) return "safe";
  if (v < 0.72) return "caution";
  return "danger";
}

// 위험 이유 (데모): 위치에 따라 구역별로 하나씩 정해짐
const HAZARD_REASONS = {
  caution: ["느슨한 모래", "완만한 경사", "자갈 지대", "지면 균열"],
  danger: ["모래 함몰", "급경사", "낙석 위험", "방사선 높음"],
};
const HAZARD_NAMES = { safe: "안전", caution: "주의", danger: "위험" };

function hazardReason(level, x, z) {
  const list = HAZARD_REASONS[level];
  if (!list) return "";
  return list[Math.abs(Math.floor(x * 0.06 + z * 0.045 + 10)) % list.length];
}

function resizeHudCanvas() {
  const dpr = window.devicePixelRatio || 1;
  hudCanvas.width = hudView.clientWidth * dpr;
  hudCanvas.height = hudView.clientHeight * dpr;
  hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", () => hud.on && resizeHudCanvas());

// 이미 가진 지형 데이터로 주변 위험도를 바로 표시하고, 시야 안에서 가장 가까운 위험/주의 구역을 돌려줌
function drawScan(L) {
  const ctx = hudCtx;
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

      const level = hazardLevel(hazardAt(wx, wz));
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
          nearest[level] = { d, sx, sy, reason: hazardReason(level, wx, wz) };
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

// 바라보는 방향 바로 앞(3~25m)에서 처음 만나는 위험 요소
function updateAhead() {
  const h = (hud.heading * Math.PI) / 180;
  let found = null;
  for (let d = 3; d <= 25; d += 1) {
    const x = hud.world.e + Math.sin(h) * d;
    const z = hud.world.n + Math.cos(h) * d;
    const level = hazardLevel(hazardAt(x, z));
    if (level === "danger") {
      found = { level, d, reason: hazardReason(level, x, z) };
      break;
    }
    if (level === "caution" && !found) found = { level, d, reason: hazardReason(level, x, z) };
  }

  const level = found ? found.level : "safe";
  hudAheadEl.className = `hud-ahead is-${level}`;
  hudAheadEl.textContent = found
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

  // 길찾기 도착지가 있으면 목적지로 표시 (없으면 데모 경로의 목적지)
  const end = nav.stops[nav.stops.length - 1];
  if (end.lonLat) {
    targets.push({ name: `도착지${end.name ? " · " + end.name : ""}`, color: "#b38cff", isGoal: true, ...bearingTo(here, end.lonLat) });
  } else if (hud.demoRoute) {
    const d = hud.demoRoute;
    targets.push({ name: `목적지 · ${d.destName}`, color: "#b38cff", isGoal: true, ...bearingTo(here, d.path[d.path.length - 1]) });
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

// ---------- 생체/장비 상태 (데모 값) ----------
const vitals = [
  { id: "o2", label: "O₂", value: 72, color: "#4cc9f0", big: true, sub: "잔여 4:12" },
  { id: "fatigue", label: "피로도", value: 35, color: "#ffd166" },
  { id: "water", label: "수분", value: 64, color: "#7df9c4" },
  { id: "power", label: "전력", value: 81, color: "#c084fc" },
  { id: "rad", label: "방사선", value: 18, color: "#ff7b54", sub: "0.42 mSv" },
];

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
    .map(
      (v) => `
      <div class="hud-ring ${v.big ? "is-big" : ""}" data-id="${v.id}" title="${v.label} ${v.value}%">
        ${ringSvg(v, v.big ? 44 : 22, v.big ? 7 : 5)}
        <div class="hud-ring__text">
          <span class="hud-ring__label">${v.label}</span>
          <span class="hud-ring__num">${Math.round(v.value)}${v.big ? "" : ""}</span>
          ${v.sub ? `<span class="hud-ring__sub">${v.sub}</span>` : ""}
        </div>
      </div>`
    )
    .join("");
}

// 데모: 시간이 지나면 산소는 줄고 피로도는 늘어남
setInterval(() => {
  if (!hud.on) return;
  const o2 = vitals.find((v) => v.id === "o2");
  const fatigue = vitals.find((v) => v.id === "fatigue");
  const exertion = hud.moving ? (hud.keys.has("ShiftLeft") || hud.keys.has("ShiftRight") ? 4 : 2) : 1; // 걷거나 뛰면 더 빨리
  o2.value = Math.max(0, o2.value - 0.05 * exertion);
  fatigue.value = Math.min(100, fatigue.value + 0.03 * exertion * exertion);
  const mins = Math.round((o2.value / 72) * 252);
  o2.sub = `잔여 ${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
  buildVitals();
}, 1000);

// ---------- 미니맵 (HUD 모드에서 왼쪽 아래 창) ----------
function updateMinimap() {
  const here = getCurrentPosition();
  if (!here || !mapImage.naturalWidth) return;
  const { x, y } = lonLatToImage(here.lon, here.lat);
  const w = hudPreview.clientWidth;
  const h = hudPreview.clientHeight;
  hudPreview.style.backgroundImage = `url("${mapImage.getAttribute("src")}")`;
  hudPreview.style.backgroundSize = `${mapImage.naturalWidth * MINIMAP_ZOOM}px auto`;
  hudPreview.style.backgroundPosition = `${w / 2 - x * MINIMAP_ZOOM}px ${h / 2 - y * MINIMAP_ZOOM}px`;
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
const WALK_MPS = 3.5; // 데모라 실제 걸음(약 1.4m/s)보다 빠르게
const RUN_MPS = 9;
const TURN_DPS = 70; // ←→ 회전 속도 (°/초)
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
  if (!hud.moving) return;

  const speed = k.has("ShiftLeft") || k.has("ShiftRight") ? RUN_MPS : WALK_MPS;
  const norm = Math.hypot(fwd, side);
  const h = (hud.heading * Math.PI) / 180;
  // 바라보는 방향 기준: 앞(fwd) + 오른쪽(side) → 동/북
  const east = ((fwd * Math.sin(h) + side * Math.cos(h)) / norm) * speed * dt;
  const north = ((fwd * Math.cos(h) - side * Math.sin(h)) / norm) * speed * dt;

  here.lat += north / DEG_TO_M;
  here.lon += east / (DEG_TO_M * Math.cos((here.lat * Math.PI) / 180));
  hud.world = worldOf(here);
  hud.bob += dt * speed * 2.4;
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

// 길찾기 결과가 없으면 현위치 → (도착지 또는 Home Plate) 데모 경로를 만들어 둠
function prepareDemoRoute() {
  if (nav.results.some((r) => r.id === nav.selectedId)) return;
  const here = getCurrentPosition();
  if (!here) {
    hud.demoRoute = null;
    return;
  }
  const end = nav.stops[nav.stops.length - 1];
  let dest = end.lonLat ? { ...end.lonLat, name: end.name || "도착지" } : null;
  if (!dest) {
    const points = getPoints().filter((p) => p.lon != null);
    const p = points.find((q) => q.id === "home-plate") || points[0];
    if (p) dest = { lon: p.lon, lat: p.lat, name: p.name };
  }
  if (!dest) return;
  // route.js 의 데모 경로 생성 함수 재사용 (나중에 실제 알고리즘으로 교체)
  const r = buildDemoRoute(ROUTE_OPTIONS[0], [{ lon: here.lon, lat: here.lat }, dest]);
  hud.demoRoute = { ...r, destName: dest.name, isDemo: true };
}

function currentHudRoute() {
  const sel = nav.results.find((r) => r.id === nav.selectedId);
  if (sel) return { ...sel, destName: nav.stops[nav.stops.length - 1].name || "도착지", isDemo: false };
  return hud.demoRoute;
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
  hudGuideLabel.textContent = `${route.isDemo ? "데모 경로" : "길찾기 경로"} · ${route.name}`;
  hudGuideDest.textContent = route.destName;
  hudGuideDist.textContent = `남은 거리 ${formatKm(remaining)} · 약 ${formatDuration(remaining / speedMps / 3600)}`;

  let warn = "";
  let state = "";
  if (remaining < 8) {
    warn = "목적지에 도착했어요!";
    state = "is-arrived";
  } else if (near.d > OFF_ROUTE_M) {
    warn = `경로에서 ${Math.round(near.d)}m 벗어났어요`;
    state = "is-off";
  } else if (Math.abs(turn) > 35) {
    warn = `${turn > 0 ? "오른쪽" : "왼쪽"}으로 ${Math.round(Math.abs(turn))}° 돌아가세요`;
  }
  hudGuideWarn.textContent = warn;
  hudGuide.className = `hud-guide ${state}`;
}

function hexAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// =========================================================
// 실제 지형 1인칭 3D (data/ 의 DEM + 가시광 모자이크 → three.js)
//  - 근거리: 현위치 주변 3km, DEM 5m 간격 + 표면 사진 약 1.5m/px
//  - 원거리: 지역 전체 30km, 저해상도 높이맵 + 지도 사진 (지평선의 Columbia Hills 까지)
// =========================================================
const THREE_URL = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
const TERRAIN_BASE_M = -1913; // 3D 좌표 높이 기준 (DEM 중앙값 부근)
const HUD_PITCH_DEFAULT = -8; // 처음 고개 각도: 살짝 아래 (발밑 지형이 보이도록)
const HUD_PITCH_MIN = -70; // 발밑까지
const HUD_PITCH_MAX = 35; // 하늘 쪽
const hud3d = { ready: false, loading: false, failed: false };
const hudLoading = document.getElementById("hud-loading");
const hudTerrainCanvas = document.getElementById("hud-3d");

function loadScriptOnce(src) {
  if (window.THREE) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src} 를 불러오지 못했어요`));
    document.head.append(s);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${src} 를 불러오지 못했어요`));
    img.src = src;
  });
}

function imagePixels(img) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  return { w: c.width, h: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
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

// 월드 좌표 (지역 중심 기준 동 e, 북 n, m) 의 실제 지형 높이 (m, DEM 절대값)
function terrainHeight(e, n) {
  const near = hud3d.near;
  if (near && e >= near.e0 && e <= near.e1 && n >= near.n0 && n <= near.n1) {
    return sampleGrid(near, ((e - near.e0) / (near.e1 - near.e0)) * (near.w - 1), ((near.n1 - n) / (near.n1 - near.n0)) * (near.h - 1));
  }
  const far = hud3d.far;
  if (!far) return TERRAIN_BASE_M;
  return sampleGrid(far, ((e - far.e0) / (far.e1 - far.e0)) * (far.w - 1), ((far.n1 - n) / (far.n1 - far.n0)) * (far.h - 1));
}

// 높이 격자를 지형 메시로 (PlaneGeometry: 위쪽 줄 = 북쪽)
function terrainMesh(grid, segW, segH, texture, { lift = 0, polygonOffset = false } = {}) {
  const width = grid.e1 - grid.e0;
  const depth = grid.n1 - grid.n0;
  const geo = new THREE.PlaneGeometry(width, depth, segW, segH);
  geo.rotateX(-Math.PI / 2); // (x, y) → (x, 0, -y) : 북쪽 = -z
  const pos = geo.attributes.position;
  for (let r = 0; r <= segH; r++) {
    for (let c = 0; c <= segW; c++) {
      const i = r * (segW + 1) + c;
      const h = sampleGrid(grid, (c / segW) * (grid.w - 1), (r / segH) * (grid.h - 1));
      pos.setY(i, h - TERRAIN_BASE_M + lift);
    }
  }
  geo.computeVertexNormals();
  texture.encoding = THREE.sRGBEncoding;
  texture.anisotropy = 8;
  const mat = new THREE.MeshLambertMaterial({ map: texture, color: 0xe0a77c }); // 흑백 사진을 화성 색으로
  if (polygonOffset) Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set((grid.e0 + grid.e1) / 2, 0, -(grid.n0 + grid.n1) / 2);
  return mesh;
}

// 화성 낮 하늘 (위는 어둡고 지평선은 밝은 버터스카치 색)
function marsSky() {
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#5b4636");
  grad.addColorStop(0.55, "#b98d68");
  grad.addColorStop(1, "#e2bf98");
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  return t;
}

async function initTerrain3D() {
  const cfg = REGIONS[currentRegion]?.hudTerrain;
  if (hud3d.ready || hud3d.loading || hud3d.failed || !cfg) return;
  hud3d.loading = true;
  hudLoading.hidden = false;

  try {
    await loadScriptOnce(THREE_URL);
    const region = REGIONS[currentRegion];
    const [nearHeightImg, farHeightImg] = await Promise.all([loadImage(cfg.height), loadImage(region.terrain.heightmap)]);

    // 근거리 높이: 16bit (R 상위 + G 하위)
    const nh = imagePixels(nearHeightImg);
    const nearValues = new Float32Array(nh.w * nh.h);
    for (let i = 0; i < nearValues.length; i++) {
      const q = nh.data[i * 4] * 256 + nh.data[i * 4 + 1];
      nearValues[i] = cfg.minM + (q / 65535) * (cfg.maxM - cfg.minM);
    }
    const nb = cfg.bounds;
    const nw = worldOf({ lon: nb.lonMin, lat: nb.latMax });
    const ne = worldOf({ lon: nb.lonMax, lat: nb.latMin });
    hud3d.near = { w: nh.w, h: nh.h, values: nearValues, e0: nw.e, e1: ne.e, n0: ne.n, n1: nw.n };

    // 원거리 높이: 지역 전체 8bit
    const fh = imagePixels(farHeightImg);
    const farValues = new Float32Array(fh.w * fh.h);
    const t = region.terrain;
    for (let i = 0; i < farValues.length; i++) farValues[i] = t.minM + (fh.data[i * 4] / 255) * (t.maxM - t.minM);
    const rb = region.bounds;
    const fw = worldOf({ lon: rb.lonMin, lat: rb.latMax });
    const fe = worldOf({ lon: rb.lonMax, lat: rb.latMin });
    hud3d.far = { w: fh.w, h: fh.h, values: farValues, e0: fw.e, e1: fe.e, n0: fe.n, n1: fw.n };

    // 장면
    const renderer = new THREE.WebGLRenderer({ canvas: hudTerrainCanvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputEncoding = THREE.sRGBEncoding;
    const scene = new THREE.Scene();
    scene.background = marsSky();
    scene.fog = new THREE.Fog(0xcfa47c, 400, 14000); // 먼지 낀 대기
    const camera = new THREE.PerspectiveCamera(60, 1, 0.3, 40000);
    camera.rotation.order = "YXZ";

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const sun = new THREE.DirectionalLight(0xfff0dc, 1.05); // 낮은 태양 → 크레이터 음영
    sun.position.set(-0.6, 0.55, 0.45).normalize();
    scene.add(sun);

    const loader = new THREE.TextureLoader();
    const [nearTex, farTex] = await Promise.all([
      loader.loadAsync(cfg.surface),
      loader.loadAsync(mapImage.getAttribute("src")),
    ]);
    scene.add(terrainMesh(hud3d.far, 300, 290, farTex, { lift: -1.5 }));
    scene.add(terrainMesh(hud3d.near, nh.w - 1, nh.h - 1, nearTex, { polygonOffset: true }));

    Object.assign(hud3d, { renderer, scene, camera, ready: true });
    hudTerrainCanvas.hidden = false;
    hudScene.hidden = true; // 파노라마 대신 실제 지형
    resizeTerrain3D();
  } catch (e) {
    console.warn("실제 지형 3D 를 준비하지 못해 파노라마로 표시합니다.", e);
    hud3d.failed = true;
  } finally {
    hud3d.loading = false;
    hudLoading.hidden = true;
  }
}

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
  const bob = hud.moving ? Math.sin(hud.bob) * 0.05 : 0;
  cam.position.set(e, terrainHeight(e, n) - TERRAIN_BASE_M + EYE_HEIGHT_M + bob, -n);
  cam.rotation.y = (-hud.heading * Math.PI) / 180; // 0° = 북쪽(-z), 시계 방향으로 회전
  cam.rotation.x = (hud.pitch * Math.PI) / 180; // 고개 들기/숙이기
  cam.updateMatrixWorld();
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
}

function renderTerrain3D() {
  updateTerrainCamera();
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
    projTmp.set(e, terrainHeight(e, n) - TERRAIN_BASE_M + up, -n);
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
