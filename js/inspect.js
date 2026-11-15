// Mars Mother — 지점 조사: 지도를 클릭하면 그 자리에 핀 + 오른쪽 정보 창
//  상자 내용: 좌표 · 고도 · 경사 / 지금 시각의 기온 · 방사선 · 기압 · 태양 / 지질 시대 · 표면 물질 · 모래 위험 · 가까운 광물 · 계곡
//  버튼: 포인트에 추가 · 출발지 / 도착지로 · 360° 지형 시점 (그 자리에서 DEM 으로 바로 그림)
// 데이터: dem.js (고도) · survey.js (경사 · 거칠기 · 탐사 여부) · marstime.js (기온 · 방사선 · 태양) ·
//         environment.js (그림자 · 통신 · 지형 차폐) · data/layers.js (JMARS 지질 · TES 열관성 · 광물 · 계곡)
// 필요: main.js (mapEl, view, imageToLonLat, lonLatToImage, positionPins, openPhotoViewer, 포인트 추가 창) · route.js (setStop, distanceM)

const inspectPins = document.createElement("div");
inspectPins.className = "map-pins inspect-pins";
document.getElementById("nav-pins").after(inspectPins);
// 정보 창: 화면 오른쪽에서 밀려 나옴. 열리면 오른쪽 버튼들(HUD · 2D · ◎ · 축척 · 시계)은 그만큼 왼쪽으로 비킴 (css)
const inspectPanel = document.createElement("aside");
inspectPanel.className = "inspect-panel";
inspectPanel.setAttribute("aria-label", "지점 정보");
inspectPanel.inert = true;
document.querySelector(".app").append(inspectPanel);
let inspected = null; // { lon, lat }

// ---------- 과학 레이어에서 찾기 ----------
function pointInRings(rings, lon, lat) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// 그 위치를 덮는 다각형의 속성 (없으면 null)
function featureAt(layerId, lon, lat) {
  const fc = SCIENCE_LAYERS[layerId];
  if (!fc) return null;
  for (const f of fc.features) {
    const { type, coordinates: c } = f.geometry;
    const polys = type === "Polygon" ? [c] : type === "MultiPolygon" ? c : [];
    if (polys.some((rings) => pointInRings(rings, lon, lat))) return f.properties;
  }
  return null;
}

// 가장 가까운 점/선 도형까지의 거리 (m) 와 그 속성
function nearestFeature(layerIds, p) {
  let best = null;
  const visit = (coord, props, layerId) => {
    const d = distanceM(p, { lon: coord[0], lat: coord[1] });
    if (!best || d < best.distM) best = { distM: d, props, layerId };
  };
  for (const id of layerIds) {
    const fc = SCIENCE_LAYERS[id];
    if (!fc) continue;
    for (const f of fc.features) {
      const { type, coordinates: c } = f.geometry;
      if (type === "Point") visit(c, f.properties, id);
      else if (type === "MultiPoint" || type === "LineString") c.forEach((q) => visit(q, f.properties, id));
      else if (type === "MultiLineString") c.forEach((line) => line.forEach((q) => visit(q, f.properties, id)));
    }
  }
  return best;
}

const GEO_ERAS = [
  ["geo_noachian", "노아키안 (41~37억 년 전)"],
  ["geo_hesperian", "헤스페리안 (37~30억 년 전)"],
  ["geo_amazonian", "아마조니안 (30억 년 전~)"],
];
const MINERAL_NAMES = { phyllosilicate: "층상규산염 (점토)", sulfate: "황산염", carbonate: "탄산염" };
const WATER_NAMES = { open_basins: "열린 분지 호수", closed_basins: "닫힌 분지 호수", deltas: "삼각주" };

const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);

// ---------- 그 지점의 데이터 모으기 ----------
function inspectData(p) {
  const now = marsClock.now();
  const groups = [];
  const elev = demElevation(p.lon, p.lat);
  const cell = survey.loaded ? envCellOf(p) : -1;
  const eta = terrainEta(p.lon, p.lat);

  // 지형
  const terrain = [];
  terrain.push(["고도", elev ? `${formatElevation(elev.m)} · ${DEM_LABELS[elev.source]}` : "DEM 범위 밖"]);
  if (cell !== -1) {
    terrain.push(["경사", `${survey.slope[cell].toFixed(1)}°${survey.slope[cell] >= ABSOLUTE_SLOPE_DEG ? " · 통행 불가" : survey.slope[cell] > PROFILE.slopeLimitDeg ? " · 내 한계 초과" : ""}`]);
    const r = survey.rough[cell];
    terrain.push(["거칠기 · 암석", `${r < 0.2 ? "낮음" : r < 0.45 ? "보통" : "높음"} (${Math.round(r * 100)})${survey.mask[cell] ? " · 탐사로 확인" : " · 추정"}`]);
  }
  const here = typeof getCurrentPosition === "function" && getCurrentPosition();
  if (here) terrain.push(["현위치에서", fmtDist(distanceM(here, p))]);
  groups.push(["지형", terrain]);

  // 지금 시각의 환경
  const envRows = [];
  const sun = sunPosition(now, p.lon, p.lat);
  let shadow = false;
  if (cell !== -1) shadow = !!envShadowMap(now).map[cell];
  const temp = surfaceTempC(now, p.lon, p.lat, { shadow, eta });
  envRows.push(["기온", `${Math.round(temp)}°C${sun.elevationDeg <= 0 ? " · 밤" : shadow ? " · 그늘" : ""}`]);
  if (elev) {
    const f = radiationFactors(now, p.lon);
    const base = cell !== -1 ? envRadRate().rate[cell] : radiationBase(elev.m);
    envRows.push(["방사선", `${(base * f.total).toFixed(3)} mSv/일 (${((base * f.total * 1000) / 24).toFixed(1)} μSv/시간)`]);
    envRows.push(["기압", `${Math.round(pressureAt(elev.m, f))} Pa`]);
  }
  envRows.push(["태양", sun.elevationDeg > 0 ? `고도 ${Math.round(sun.elevationDeg)}° · 방위 ${Math.round(sun.azimuthDeg)}°` : "지평선 아래"]);
  const st = sunTimes(now, p.lon, p.lat);
  envRows.push(["일출 · 일몰", `${formatClock(st.sunrise)} · ${formatClock(st.sunset)}`]);
  if (cell !== -1) {
    const vis = envCommMap();
    envRows.push(["기지 통신", vis ? (vis[cell] ? "가능" : "음영 (지형에 가림)") : "기지 없음"]);
  }
  groups.push([`환경 · 화성 지방시 ${formatClock(sun.time.ltst)}`, envRows]);

  // 지질 · 지표 · 물의 흔적
  const geo = [];
  for (const [id, label] of GEO_ERAS) {
    const f = featureAt(id, p.lon, p.lat);
    if (f) geo.push(["지질 시대", `${label} · ${f.Unit}`], ["지질 단위", f.UnitDesc]);
  }
  const unit = featureAt("ti_surface_units", p.lon, p.lat);
  if (unit) geo.push(["표면 물질", `${unit.name_ko} · 열관성 약 ${Math.round(unit.ti_mean)} tiu`]);
  const sand = featureAt("ti_sand_trap", p.lon, p.lat);
  geo.push(["모래 빠짐", sand ? `위험 ${sand.risk_ko}` : "낮음"]);
  if (featureAt("ti_anomalies", p.lon, p.lat)) geo.push(["암반", "노출 암반 · 고결층 후보 지역"]);
  const mineral = nearestFeature(["aqueous_minerals", "hydrous_minerals"], p);
  if (mineral) {
    const name = mineral.layerId === "hydrous_minerals" ? "함수 광물" : MINERAL_NAMES[mineral.props.Class] || "수성 광물";
    geo.push(["가까운 광물", `${name} · ${fmtDist(mineral.distM)}`]);
  }
  const valley = nearestFeature(["valleys"], p);
  if (valley) geo.push(["옛 계곡", fmtDist(valley.distM)]);
  const water = nearestFeature(Object.keys(WATER_NAMES), p);
  if (water) geo.push(["호수 · 삼각주", `${WATER_NAMES[water.layerId]} · ${fmtDist(water.distM)}`]);
  groups.push(["지질 · 물의 흔적", geo]);

  return { groups, note: unit ? unit.description : sand ? sand.description : "" };
}

// ---------- 상자 그리기 ----------
function closeInspect() {
  inspected = null;
  inspectPins.replaceChildren();
  inspectPanel.inert = true;
  document.body.classList.remove("is-inspect-open");
  if (typeof selectPoint === "function") selectPoint(null);
}

// point: 기존 포인트의 핀을 눌렀을 때 그 포인트 (이름 · 설명 · 사진을 같이 보여 줌). 빈 곳을 클릭했으면 null
function openInspect(p, point = null) {
  inspected = { ...p, point };
  if (!point) selectPoint(null); // 빈 곳을 클릭했으면 포인트 선택 표시는 해제
  const { x, y } = lonLatToImage(p.lon, p.lat);
  const wrap = document.createElement("div");
  wrap.className = "inspect";
  wrap.dataset.x = x;
  wrap.dataset.y = y;
  const pin = document.createElement("span");
  pin.className = "inspect__pin";
  const card = inspectPanel;

  const head = document.createElement("header");
  head.className = "inspect__head";
  const title = document.createElement("div");
  title.className = "inspect__title";
  title.innerHTML = `<span></span><strong></strong>`;
  title.firstChild.textContent = point ? `${(POINT_TYPES[point.type] || POINT_TYPES.custom).label} · ${formatLonLat(p)}` : "선택한 지점";
  title.lastChild.textContent = point ? point.name : formatLonLat(p);
  if (point) title.firstChild.style.color = (POINT_TYPES[point.type] || POINT_TYPES.custom).color;
  const close = document.createElement("button");
  close.className = "inspect__close";
  close.textContent = "×";
  close.setAttribute("aria-label", "닫기");
  close.addEventListener("click", closeInspect);
  head.append(title, close);

  const body = document.createElement("div");
  body.className = "inspect__body";
  const fill = () => {
    body.replaceChildren();
    if (point && point.note) {
      const about = document.createElement("p");
      about.className = "inspect__about";
      about.textContent = point.note;
      body.append(about);
    }
    const { groups, note } = inspectData(p);
    for (const [name, rows] of groups) {
      if (!rows.length) continue;
      const h = document.createElement("h3");
      h.textContent = name;
      const dl = document.createElement("dl");
      for (const [k, v] of rows) {
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        dd.textContent = v;
        dl.append(dt, dd);
      }
      body.append(h, dl);
    }
    if (note) {
      const n = document.createElement("p");
      n.className = "inspect__note";
      n.textContent = note;
      body.append(n);
    }
  };

  const actions = document.createElement("div");
  actions.className = "inspect__actions";
  const btn = (label, cls, run) => {
    const b = document.createElement("button");
    b.className = `inspect__btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", run);
    actions.append(b);
    return b;
  };
  if (point && point.media) {
    // 미리 만들어 둔 360° 파노라마 + 궤도 사진
    btn("사진 · 360° 파노라마", "is-primary", () => openPhotoViewer(point));
  }
  if (!point) btn("＋ 포인트에 추가", "is-primary", () => {
    pendingLonLat = { ...p };
    pointForm.reset();
    pointDialogCoords.textContent = formatLonLat(p);
    pointDialog.showModal();
    closeInspect();
  });
  const panoBtn = point && point.media ? document.createElement("button") : btn("360° 지형 시점", "", async () => {
    panoBtn.disabled = true;
    panoBtn.textContent = "그리는 중…";
    try {
      const url = await renderDemPanorama(p);
      openPhotoViewer({
        name: "360° 지형 시점",
        note: "DEM 으로 그 자리에서 그린 지형 (사진 아님)",
        lon: p.lon,
        lat: p.lat,
        media: { panorama: url, gallery: [] },
      });
    } catch (e) {
      console.warn(e);
      panoBtn.textContent = "DEM 을 읽지 못했어요";
      return;
    }
    panoBtn.disabled = false;
    panoBtn.textContent = "360° 지형 시점";
  });
  const toRoute = (index, label) => () => {
    const stop = index === 0 ? nav.stops[0] : nav.stops[nav.stops.length - 1];
    setStop(stop, { ...p }, point ? point.name : null);
    closeInspect();
    setDrawerOpen(true);
    document.getElementById("tab-route").click();
    setRouteMsg(`${label}를 지정했어요.`);
  };
  btn("출발지로", "", toRoute(0, "출발지"));
  btn("도착지로", "", toRoute(1, "도착지"));

  card.replaceChildren(head, body, actions);
  wrap.append(pin);
  if (point) inspectPins.replaceChildren(); // 포인트는 자기 핀이 있으므로 따로 찍지 않음
  else inspectPins.replaceChildren(wrap);
  positionPins();
  inspectPanel.inert = false;
  document.body.classList.add("is-inspect-open");
  fill();
  // DEM · 탐사 격자를 아직 못 읽었으면 읽은 뒤 다시 채움
  Promise.allSettled([loadSurvey(), loadDemGrid("mola")]).then(() => inspected && inspected.lon === p.lon && inspected.lat === p.lat && fill());
}

// 시각이 바뀌면 열려 있는 상자의 기온 · 방사선도 갱신
marsClock.onChange(() => {
  if (!inspected) return;
  const open = inspected;
  clearTimeout(marsClock.inspectTimer);
  marsClock.inspectTimer = setTimeout(() => inspected === open && openInspect(open, open.point), 150);
});

// ---------- 지도 클릭 (끌기 · 위치 고르기 · 메뉴 닫는 클릭은 제외) ----------
let inspectDown = null;
mapEl.addEventListener("pointerdown", (e) => {
  const busy = mapPick || drawer.classList.contains("is-open") || pointers.size > 1 || e.button !== 0;
  inspectDown = busy ? null : { x: e.clientX, y: e.clientY };
});
mapEl.addEventListener("pointerup", (e) => {
  const d = inspectDown;
  inspectDown = null;
  if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || !mapImage.naturalWidth) return;
  const rect = mapEl.getBoundingClientRect();
  const p = imageToLonLat((e.clientX - rect.left - view.x) / view.scale, (e.clientY - rect.top - view.y) / view.scale);
  const box = DEM_DATA.mola.bounds; // 데이터가 있는 범위 (Gusev 주변 400 km)
  if (p.lon < box.lonMin || p.lon > box.lonMax || p.lat < box.latMin || p.lat > box.latMax) {
    closeInspect();
    return;
  }
  openInspect(p);
});
document.addEventListener("keydown", (e) => e.key === "Escape" && closeInspect());
document.addEventListener("regionchange", closeInspect);

// ---------- 360° 지형 시점: 그 자리에서 DEM 으로 그림 ----------
// preprocess/build_sites.py 의 render_pano 와 같은 방식 (원통 투영, 왼쪽 끝 = 북, 지평선 = 위에서 42%)
//  방향마다 가까운 곳 → 먼 곳으로 나아가며, 그때까지보다 높이 보이는 지형만 칠함. 멀수록 먼지 안개
const PANO_W = 1800, PANO_H = 360, PANO_HORIZON = 0.42, PANO_EYE_M = 1.6;
const panoCache = { shades: {}, albedo: null };

function panoShade(key) {
  if (!panoCache.shades[key] && demGrids[key]) panoCache.shades[key] = hillshadeOf(demGrids[key], key === "mola" ? 3 : 2);
  return panoCache.shades[key];
}

// 지도 사진 밝기 (지표 무늬)
function panoAlbedo() {
  if (!panoCache.albedo) {
    const c = document.createElement("canvas");
    c.width = mapImage.naturalWidth;
    c.height = mapImage.naturalHeight;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(mapImage, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    const a = new Float32Array(c.width * c.height);
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 765;
    const mean = sum / a.length;
    for (let i = 0; i < a.length; i++) a[i] = Math.max(0.3, Math.min(1.8, a[i] / mean));
    panoCache.albedo = { a, w: c.width, h: c.height, b: REGIONS.gusev.bounds };
  }
  return panoCache.albedo;
}

async function renderDemPanorama(p) {
  await Promise.allSettled(["near", "hirise", "mola"].map(loadDemGrid));
  const grids = ["near", "hirise", "mola"].filter((k) => demGrids[k]).map((k) => ({ g: demGrids[k], shade: panoShade(k) }));
  const eyeE = demElevation(p.lon, p.lat);
  if (!grids.length || !eyeE) throw new Error("DEM 없음");
  await new Promise((r) => setTimeout(r, 20)); // "그리는 중…" 이 먼저 보이게
  const eye = eyeE.m + PANO_EYE_M;
  const alb = panoAlbedo();
  const cos0 = Math.cos((p.lat * Math.PI) / 180);
  const mPerDeg = (Math.PI * 3396190) / 180;

  const canvas = document.createElement("canvas");
  canvas.width = PANO_W;
  canvas.height = PANO_H;
  const ctx = canvas.getContext("2d");
  // 하늘
  const horizon = PANO_H * PANO_HORIZON;
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, "#5b4636");
  sky.addColorStop(0.55, "#b98d68");
  sky.addColorStop(1, "#e2bf98");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, PANO_W, PANO_H);
  const img = ctx.getImageData(0, 0, PANO_W, PANO_H);
  const px = img.data;

  const STEPS = 900;
  const dist = new Float32Array(STEPS);
  for (let k = 0; k < STEPS; k++) dist[k] = 1.2 * Math.pow(160000 / 1.2, k / (STEPS - 1));
  const pxPerRad = PANO_W / (2 * Math.PI);
  const GROUND = [201, 143, 99], HAZE = [207, 164, 124];

  for (let c = 0; c < PANO_W; c++) {
    const az = ((c + 0.5) / PANO_W) * 2 * Math.PI;
    const se = Math.sin(az), cn = Math.cos(az);
    let top = PANO_H; // 지금까지 칠한 가장 높은 줄
    for (let k = 0; k < STEPS && top > 0; k++) {
      const d = dist[k];
      const lon = p.lon + (se * d) / (mPerDeg * cos0);
      const lat = p.lat + (cn * d) / mPerDeg;
      // 정밀한 격자부터
      let z = null, s = 0.6;
      for (const { g, shade } of grids) {
        const b = g.bounds;
        if (lon < b.lonMin || lon > b.lonMax || lat < b.latMin || lat > b.latMax) continue;
        const x = Math.round(((lon - b.lonMin) / (b.lonMax - b.lonMin)) * (g.w - 1));
        const y = Math.round(((b.latMax - lat) / (b.latMax - b.latMin)) * (g.h - 1));
        z = d < 400 ? demSample(g, lon, lat) : g.values[y * g.w + x];
        s = shade[y * g.w + x];
        break;
      }
      if (z === null) break; // 데이터 범위 밖
      const ang = Math.atan2(z - (d * d) / (2 * 3396190) - eye, d);
      const row = Math.max(0, Math.round(horizon - ang * pxPerRad));
      if (row >= top) continue;
      // 색: 표토 색 × 사진 밝기 × 음영, 멀수록 안개
      let a = 1;
      const ab = alb.b;
      if (lon >= ab.lonMin && lon <= ab.lonMax && lat >= ab.latMin && lat <= ab.latMax) {
        const ax = Math.min(alb.w - 1, Math.floor(((lon - ab.lonMin) / (ab.lonMax - ab.lonMin)) * alb.w));
        const ay = Math.min(alb.h - 1, Math.floor(((ab.latMax - lat) / (ab.latMax - ab.latMin)) * alb.h));
        a = alb.a[ay * alb.w + ax];
      }
      const light = a * (0.35 + 0.8 * s);
      const fog = 1 - Math.exp(-d / 45000);
      const r = GROUND[0] * light * (1 - fog) + HAZE[0] * fog;
      const gr = GROUND[1] * light * (1 - fog) + HAZE[1] * fog;
      const bl = GROUND[2] * light * (1 - fog) + HAZE[2] * fog;
      for (let y = row; y < top; y++) {
        const o = (y * PANO_W + c) * 4;
        px[o] = r;
        px[o + 1] = gr;
        px[o + 2] = bl;
      }
      top = row;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.9);
}
