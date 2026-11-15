// Mars Mother — 레이어 탭: 체크박스에 맞춰 지도 레이어 켜고 끄기 + 범례
// 데이터: js/data/layers.js (preprocess/build_layers.py 가 data/ 원본에서 만들어 냄)
// 필요: main.js 의 mapEl, mapImage, view, geoToImagePx / dem.js / marstime.js (방사선 레이어)

const LAYER_STATE_KEY = "marsmother.layers";
const layerListEl = document.getElementById("layer-list");
const scienceCanvas = document.getElementById("science-layers");

// ---------- 레이어 정의 ----------
// 벡터 레이어는 sources 의 GeoJSON 을 style(feature) 에 맞춰 그림
//   style → { color, width?, opacity? }  (도형 종류는 GeoJSON 의 점/선/면을 따름)
// 아래 순서대로 쌓임 (면 → 선 → 점)
const fixed = (color, extra) => () => ({ color, ...extra });
const byColorProp = (f) => ({ color: f.properties.color });

const GEOLOGY = [
  { id: "geo_noachian", color: "#b07a3c", label: "노아키안 (41~37억 년 전)" },
  { id: "geo_hesperian", color: "#e8893a", label: "헤스페리안 (37~30억 년 전)" },
  { id: "geo_amazonian", color: "#a8a29e", label: "아마조니안 (30억 년 전~)" },
];
const WATER_BODIES = [
  { id: "open_basins", color: "#3b82f6", label: "열린 분지 호수" },
  { id: "closed_basins", color: "#22d3ee", label: "닫힌 분지 호수" },
  { id: "deltas", color: "#fde047", label: "삼각주" },
  { id: "sparse_valleys", color: "#93c5fd", label: "계곡 (2005 목록)" },
];
const MINERAL_CLASSES = {
  phyllosilicate: { color: "#34d399", label: "층상규산염 (점토)" },
  sulfate: { color: "#fbbf24", label: "황산염" },
  carbonate: { color: "#f472b6", label: "탄산염" },
};
const HYDROUS = { color: "#a78bfa", label: "함수 광물 (CRISM · OMEGA)" };
const VALLEY_COLOR = "#4fc3ff";

const VECTOR_LAYERS = [
  {
    id: "geology",
    sources: GEOLOGY.map((g) => ({ id: g.id, style: fixed(g.color) })),
    legend: GEOLOGY.map((g) => ({ color: g.color, label: g.label })),
    note: "USGS 화성 지질도(SIM 3292). 노아키안 = 물이 가장 많던 시대",
  },
  {
    id: "ti_surface_units",
    sources: [{ id: "ti_surface_units", style: byColorProp }],
    legend: SCIENCE_LAYER_META.tiLegend.surface_units.map((u) => ({ color: u.color, label: u.name_ko })),
  },
  {
    id: "ti_sand_trap",
    sources: [{ id: "ti_sand_trap", style: byColorProp }],
    legend: SCIENCE_LAYER_META.tiLegend.sand_trap_risk.map((r) => ({ color: r.color, label: `위험 ${r.name_ko}` })),
    note: "열관성만으로 추정 — 굳은 표면 아래 무른 층은 잡히지 않음",
  },
  {
    id: "ti_anomalies",
    sources: [{ id: "ti_anomalies", style: byColorProp }],
    legend: [{ color: "#e11d48", label: "노출 암반 · 고결층 후보" }],
    note: "주변(약 45 km)보다 열관성이 뚜렷이 높은 곳",
  },
  {
    id: "ti_contours",
    sources: [
      {
        id: "ti_contours",
        style: (f) =>
          f.properties.major
            ? { color: "#ffffff", width: 1.6, opacity: 0.85 }
            : { color: "#ffffff", width: 0.8, opacity: 0.5 },
      },
    ],
    legend: [
      { color: "#ffffff", label: "100 tiu 단위", shape: "line" },
      { color: "rgba(255,255,255,0.5)", label: "50 tiu 단위", shape: "line" },
    ],
  },
  {
    id: "valleys",
    sources: [
      {
        id: "valleys",
        style: (f) => ({ color: VALLEY_COLOR, width: 1 + 0.6 * Math.min(f.properties.VNOrder || 1, 5) }),
      },
    ],
    legend: [{ color: VALLEY_COLOR, label: "옛 강이 파낸 계곡 (굵을수록 큰 줄기)", shape: "line" }],
  },
  {
    id: "water_bodies",
    sources: WATER_BODIES.map((w) => ({ id: w.id, style: fixed(w.color) })),
    legend: WATER_BODIES.map((w) => ({ color: w.color, label: w.label, shape: "dot" })),
  },
  {
    id: "minerals",
    sources: [
      {
        id: "aqueous_minerals",
        style: (f) => ({ color: (MINERAL_CLASSES[f.properties.Class] || HYDROUS).color }),
      },
      { id: "hydrous_minerals", style: fixed(HYDROUS.color) },
    ],
    legend: [...Object.values(MINERAL_CLASSES), HYDROUS].map((m) => ({ ...m, shape: "dot" })),
    note: "물이 있어야 생기는 광물이 궤도에서 검출된 곳",
  },
];

// ---------- 상태 (브라우저에 저장) ----------
function loadLayerState() {
  try {
    return JSON.parse(localStorage.getItem(LAYER_STATE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveLayerState() {
  const state = {};
  layerListEl.querySelectorAll("input[data-layer]").forEach((input) => {
    state[input.dataset.layer] = input.checked;
  });
  try {
    localStorage.setItem(LAYER_STATE_KEY, JSON.stringify(state));
  } catch {
    // 저장 실패 시 이번 접속 동안만 유지
  }
}

// ---------- 캔버스 그리기 ----------
// 400 km 범위라 지도 레이어(#map-layer) 안에 넣으면 축소 시 선이 사라지고 GPU 타일이 빠짐
// → 화면 크기 캔버스에 지금 보이는 배율로 매번 다시 그림 (배경 타일과 같은 방식)
// 도형은 처음 켤 때 지도 사진 픽셀 좌표의 Path2D 로 한 번만 만들어 둠
const scienceCtx = scienceCanvas.getContext("2d");
const enabledLayers = new Set();
const layerDrawCache = new Map(); // layer id → [{ kind, path, color, width, opacity }] 또는 점 목록

// 이미지 레이어 (지도 위에 반투명하게 덮는 색 지도)
//  image: 미리 만들어 둔 그림 / render: 브라우저에서 계산해 그리는 캔버스 (방사선)
const IMAGE_LAYERS = {
  mola_dem: { render: () => renderDemCanvas("mola_dem"), bounds: DEM_DATA.mola.bounds, alpha: 0.72 },
  hirise_dem: { render: () => renderDemCanvas("hirise_dem"), bounds: DEM_DATA.hirise.bounds, alpha: 0.85 },
  // HiRISE DEM 을 켜면 현위치 주변 3 km 는 2 m 격자로 더 선명하게 덮어 그림
  hirise_near: { render: () => renderDemCanvas("hirise_near"), bounds: DEM_DATA.near.bounds, alpha: 0.85 },
  ti_overlay: { ...SCIENCE_LAYER_META.tiOverlay, alpha: 0.6 },
  radiation: { render: renderRadiationCanvas, bounds: DEM_DATA.mola.bounds, alpha: 0.65 },
  // 환경 필드 (js/environment.js) — 색의 투명도는 캔버스에 들어 있음
  return_limit: { render: renderReturnCanvas, bounds: DEM_DATA.hirise.bounds, alpha: 1 },
  comm_view: { render: renderCommCanvas, bounds: DEM_DATA.hirise.bounds, alpha: 1 },
  // HUD 와 같은 기준의 위험도 (js/hud.js — 이 파일보다 늦게 실행되므로 그릴 때 부름)
  hazard_level: { render: () => renderHazardCanvas(), bounds: DEM_DATA.hirise.bounds, alpha: 1 },
};

// ---------- 고도(DEM) 레이어: 고도 격자를 브라우저에서 직접 칠함 ----------
// 색 기준 두 가지:
//  - 전체 범위: MOLA 400 km 전체 (−3,000 ~ 2,800 m) → 지역끼리 비교하기 좋음
//  - 현재 화면: 지금 화면에 보이는 고도의 1~99% 범위 → HiRISE 의 몇 m 차이도 보임 (지도를 움직이면 다시 맞춤)
const DEM_LAYER_SOURCES = {
  mola_dem: { key: "mola", exaggeration: 3 },
  hirise_dem: { key: "hirise", exaggeration: 2 },
  hirise_near: { key: "near", exaggeration: 1.5 },
};
// 정밀한 것부터 (범위 계산 때 위에 덮인 거친 격자 값은 뺌)
const DEM_FINE_ORDER = ["hirise_near", "hirise_dem", "mola_dem"];
const DEM_MODE_KEY = "marsmother.demColorMode";
const demColor = {
  mode: (() => {
    try {
      return localStorage.getItem(DEM_MODE_KEY) === "view" ? "view" : "full";
    } catch {
      return "full";
    }
  })(),
  range: DEM_DATA.mola.reliefRange.slice(), // 지금 칠하는 기준 [낮음, 높음]
  lut: null,
  maps: {}, // layer id → { grid, canvas, shade, drawnRange, loading }
  recolorTimer: null,
};

function hillshadeOf(grid, exaggeration) {
  const { w, h, values: z, bounds: b } = grid;
  const lat0 = (b.latMin + b.latMax) / 2;
  const dx = (((b.lonMax - b.lonMin) / (w - 1)) * Math.PI * 3396190 * Math.cos((lat0 * Math.PI) / 180)) / 180 / exaggeration;
  const dy = (((b.latMax - b.latMin) / (h - 1)) * Math.PI * 3396190) / 180 / exaggeration;
  const shade = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = (z[y * w + Math.min(w - 1, x + 1)] - z[y * w + Math.max(0, x - 1)]) / (2 * dx);
      const gy = (z[Math.max(0, y - 1) * w + x] - z[Math.min(h - 1, y + 1) * w + x]) / (2 * dy);
      shade[y * w + x] = Math.max(0, Math.min(1, (0.64 + 0.54 * (-gx + gy)) / Math.sqrt(1 + gx * gx + gy * gy)));
    }
  }
  return shade;
}

function renderDemCanvas(id) {
  let m = demColor.maps[id];
  if (!m) {
    m = demColor.maps[id] = { loading: true };
    const src = DEM_LAYER_SOURCES[id];
    loadDemGrid(src.key)
      .then((grid) => {
        const canvas = document.createElement("canvas");
        canvas.width = grid.w;
        canvas.height = grid.h;
        Object.assign(m, { grid, canvas, shade: hillshadeOf(grid, src.exaggeration), drawnRange: null, loading: false });
        updateDemRange(true);
        scheduleScienceLayers();
      })
      .catch((e) => console.warn("고도 레이어: DEM 을 읽지 못했어요 (file:// 로 열었다면 로컬 서버로 열어야 해요).", e));
    return null;
  }
  if (!m.canvas) return null;
  const [lo, hi] = demColor.range;
  if (!m.drawnRange || m.drawnRange[0] !== lo || m.drawnRange[1] !== hi) {
    demColor.lut = demColor.lut || colorLut(DEM_DATA.colormap);
    const lut = demColor.lut;
    const { grid, canvas, shade } = m;
    const g = canvas.getContext("2d");
    const img = g.createImageData(canvas.width, canvas.height);
    const px = img.data;
    const z = grid.values;
    const scale = 255 / Math.max(hi - lo, 0.1);
    for (let i = 0; i < z.length; i++) {
      const t = Math.max(0, Math.min(255, Math.round((z[i] - lo) * scale))) * 4;
      const s = 0.35 + 0.75 * shade[i];
      px[i * 4] = lut[t] * s;
      px[i * 4 + 1] = lut[t + 1] * s;
      px[i * 4 + 2] = lut[t + 2] * s;
      px[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    m.drawnRange = [lo, hi];
  }
  return m.canvas;
}

// 지금 화면에 보이는 경위도 범위
function visibleLonLatBox() {
  const tl = imageToLonLat(-view.x / view.scale, -view.y / view.scale);
  const br = imageToLonLat((mapEl.clientWidth - view.x) / view.scale, (mapEl.clientHeight - view.y) / view.scale);
  return { lonMin: tl.lon, lonMax: br.lon, latMin: br.lat, latMax: tl.lat };
}

// 화면 안에 켜진 DEM 레이어가 보여 주는 고도의 1~99% 범위
function visibleDemRange() {
  const box = visibleLonLatBox();
  const vals = [];
  const covered = []; // 이미 센, 더 정밀한 격자들의 범위
  for (const id of DEM_FINE_ORDER) {
    const grid = enabledLayers.has(id) && demColor.maps[id]?.grid;
    if (!grid) continue;
    const b = grid.bounds;
    const x0 = Math.max(0, Math.floor(((box.lonMin - b.lonMin) / (b.lonMax - b.lonMin)) * (grid.w - 1)));
    const x1 = Math.min(grid.w - 1, Math.ceil(((box.lonMax - b.lonMin) / (b.lonMax - b.lonMin)) * (grid.w - 1)));
    const y0 = Math.max(0, Math.floor(((b.latMax - box.latMax) / (b.latMax - b.latMin)) * (grid.h - 1)));
    const y1 = Math.min(grid.h - 1, Math.ceil(((b.latMax - box.latMin) / (b.latMax - b.latMin)) * (grid.h - 1)));
    if (x1 >= x0 && y1 >= y0) {
      const step = Math.max(1, Math.round(Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / 40000)));
      for (let y = y0; y <= y1; y += step) {
        const lat = b.latMax - (y / (grid.h - 1)) * (b.latMax - b.latMin);
        for (let x = x0; x <= x1; x += step) {
          const lon = b.lonMin + (x / (grid.w - 1)) * (b.lonMax - b.lonMin);
          if (covered.some((c) => lon >= c.lonMin && lon <= c.lonMax && lat >= c.latMin && lat <= c.latMax)) continue;
          vals.push(grid.values[y * grid.w + x]);
        }
      }
    }
    covered.push(b);
  }
  if (vals.length < 4) return null;
  vals.sort((a, b) => a - b);
  let lo = vals[Math.floor(vals.length * 0.01)];
  let hi = vals[Math.ceil(vals.length * 0.99) - 1];
  if (hi - lo < 2) {
    const mid = (lo + hi) / 2;
    lo = mid - 1;
    hi = mid + 1;
  }
  return [Math.floor(lo), Math.ceil(hi)];
}

// 색 기준 다시 정하기. 지도를 움직이는 중에는 기다렸다가 멈추면 다시 칠함 (immediate: 바로)
function updateDemRange(immediate = false) {
  const anyOn = Object.keys(DEM_LAYER_SOURCES).some((id) => enabledLayers.has(id));
  demControlEl.hidden = !anyOn;
  if (!anyOn) return;
  const apply = () => {
    const next = demColor.mode === "view" ? visibleDemRange() || DEM_DATA.mola.reliefRange : DEM_DATA.mola.reliefRange;
    if (next[0] !== demColor.range[0] || next[1] !== demColor.range[1]) {
      demColor.range = [next[0], next[1]];
      scheduleScienceLayers();
    }
    renderDemLegend();
  };
  clearTimeout(demColor.recolorTimer);
  if (immediate) apply();
  else demColor.recolorTimer = setTimeout(apply, 180);
}

// 고도 레이어 아래의 공용 범례 + 색 기준 전환
const demControlEl = document.createElement("li");
demControlEl.className = "dem-control";
demControlEl.hidden = true;
demControlEl.innerHTML = `
  <div class="dem-control__modes" role="radiogroup" aria-label="고도 색 기준">
    <button type="button" data-mode="full" role="radio">전체 범위</button>
    <button type="button" data-mode="view" role="radio">현재 화면</button>
  </div>
  <span class="layer-legend__ramp" style="background: linear-gradient(to right, ${DEM_DATA.colormap.join(", ")})"></span>
  <span class="layer-legend__ramp-labels"><span data-v="lo"></span><span data-v="mid"></span><span data-v="hi"></span></span>
  <span class="layer-legend__note" data-v="note"></span>`;
demControlEl.querySelectorAll("[data-mode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    demColor.mode = btn.dataset.mode;
    try {
      localStorage.setItem(DEM_MODE_KEY, demColor.mode);
    } catch {
      // 저장 실패 시 이번 접속 동안만 유지
    }
    updateDemRange(true);
  });
});

function renderDemLegend() {
  const [lo, hi] = demColor.range;
  const q = (k) => demControlEl.querySelector(`[data-v="${k}"]`);
  q("lo").textContent = formatElevation(lo);
  q("mid").textContent = formatElevation((lo + hi) / 2);
  q("hi").textContent = formatElevation(hi);
  q("note").textContent =
    demColor.mode === "view"
      ? `지금 화면에 보이는 고도에 맞춘 색 (차이 ${Math.round(hi - lo)} m). 지도를 움직이면 다시 맞춰요.`
      : "MOLA 400 km 전체 기준 색. MOLA 400 m 격자 · HiRISE 30 m 격자 (현위치 주변 3 km 는 2 m) + 음영기복";
  demControlEl.querySelectorAll("[data-mode]").forEach((btn) => {
    const on = btn.dataset.mode === demColor.mode;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-checked", String(on));
  });
}

// ---------- 방사선 레이어 (MOLA 고도 + 시계의 시각으로 계산, 모델은 marstime.js) ----------
const RADIATION_COLORS = ["#fff5b8", "#fdd162", "#fb8c3c", "#e8453c", "#b0175a", "#5c0a63"];
const radiationMap = { canvas: null, base: null, shade: null, lut: null, range: null, loading: false, drawnFactor: null };

// 색 기준은 시간과 상관없이 고정 (가능한 가장 낮은 값 ~ 가장 높은 값) → 시간을 바꾸면 지도 전체 색이 움직임
function radiationRange() {
  if (!radiationMap.range) {
    const f = radiationFactorRange();
    const lo = radiationBase(DEM_DATA.mola.minM) * f.min;
    const hi = radiationBase(DEM_DATA.mola.maxM) * f.max;
    radiationMap.range = [Math.floor(lo * 20) / 20, Math.ceil(hi * 20) / 20];
  }
  return radiationMap.range;
}

function colorLut(colors) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 1;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 256, 0);
  colors.forEach((col, i) => grad.addColorStop(i / (colors.length - 1), col));
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 1);
  return g.getImageData(0, 0, 256, 1).data;
}

// 고도 격자 → 칸마다 (시간과 무관한) 기본 선량 + 지형을 알아보기 위한 음영
function prepareRadiationMap(grid) {
  const { w, h, values: z } = grid;
  const base = new Float32Array(w * h);
  const shade = new Float32Array(w * h);
  const cell = 400 / 3; // 격자 간격 약 400 m, 음영은 3배 과장
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      base[i] = radiationBase(z[i]);
      const gx = (z[y * w + Math.min(w - 1, x + 1)] - z[y * w + Math.max(0, x - 1)]) / (2 * cell);
      const gy = (z[Math.max(0, y - 1) * w + x] - z[Math.min(h - 1, y + 1) * w + x]) / (2 * cell);
      // 북서쪽에서 비추는 빛
      shade[i] = Math.max(0, Math.min(1, (0.64 + 0.54 * (-gx + gy)) / Math.sqrt(1 + gx * gx + gy * gy)));
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  Object.assign(radiationMap, { canvas, base, shade, lut: colorLut(RADIATION_COLORS), drawnFactor: null });
}

// 지금 시계 시각의 방사선 지도 (아직 준비 안 됐으면 null)
function renderRadiationCanvas() {
  if (!radiationMap.canvas) {
    if (!radiationMap.loading) {
      radiationMap.loading = true;
      loadDemGrid("mola")
        .then((grid) => {
          prepareRadiationMap(grid);
          scheduleScienceLayers();
        })
        .catch((e) => console.warn("방사선 레이어: MOLA 고도를 읽지 못했어요 (file:// 로 열었다면 로컬 서버로 열어야 해요).", e));
    }
    return null;
  }
  const b = DEM_DATA.mola.bounds;
  const factor = radiationFactors(marsClock.now(), (b.lonMin + b.lonMax) / 2).total;
  if (factor !== radiationMap.drawnFactor) {
    const { canvas, base, shade, lut } = radiationMap;
    const [lo, hi] = radiationRange();
    const g = canvas.getContext("2d");
    const img = g.createImageData(canvas.width, canvas.height);
    const px = img.data;
    const scale = 255 / (hi - lo);
    for (let i = 0; i < base.length; i++) {
      const t = Math.max(0, Math.min(255, Math.round((base[i] * factor - lo) * scale))) * 4;
      const s = 0.55 + 0.5 * shade[i];
      px[i * 4] = lut[t] * s;
      px[i * 4 + 1] = lut[t + 1] * s;
      px[i * 4 + 2] = lut[t + 2] * s;
      px[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    radiationMap.drawnFactor = factor;
  }
  return radiationMap.canvas;
}

// 시각이 바뀌면 방사선 레이어를 다시 그림
marsClock.onChange(() => {
  if (enabledLayers.has("radiation")) scheduleScienceLayers();
});

function projectedPath(rings, close) {
  const path = new Path2D();
  for (const ring of rings) {
    ring.forEach(([lon, lat], i) => {
      const { x, y } = geoToImagePx(lon, lat);
      if (i) path.lineTo(x, y);
      else path.moveTo(x, y);
    });
    if (close) path.closePath();
  }
  return path;
}

function buildLayerItems(def) {
  const items = [];
  const dots = []; // 점은 면·선 위에 오도록 마지막에
  for (const src of def.sources) {
    const fc = SCIENCE_LAYERS[src.id];
    if (!fc) continue; // 범위 안에 데이터가 없는 레이어
    for (const f of fc.features) {
      const { type, coordinates: c } = f.geometry;
      const s = src.style(f);
      if (type === "Point" || type === "MultiPoint") {
        for (const [lon, lat] of type === "Point" ? [c] : c) dots.push({ ...geoToImagePx(lon, lat), color: s.color });
      } else if (type === "LineString" || type === "MultiLineString") {
        items.push({ kind: "line", path: projectedPath(type === "LineString" ? [c] : c, false), ...s });
      } else if (type === "Polygon" || type === "MultiPolygon") {
        items.push({ kind: "area", path: projectedPath(type === "Polygon" ? c : c.flat(), true), ...s });
      }
    }
  }
  if (dots.length) items.push({ kind: "dots", dots });
  return items;
}

function drawLayerItems(ctx, items, dpr) {
  const s = view.scale;
  const toImage = () => ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * view.x, dpr * view.y);
  for (const it of items) {
    if (it.kind === "area") {
      toImage();
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = it.color;
      ctx.fill(it.path, "evenodd");
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = it.color;
      ctx.lineWidth = 1 / s; // 화면에서 1px
      ctx.stroke(it.path);
    } else if (it.kind === "line") {
      toImage();
      ctx.globalAlpha = it.opacity ?? 0.9;
      ctx.strokeStyle = it.color;
      ctx.lineWidth = (it.width ?? 1.5) / s;
      ctx.stroke(it.path);
    } else {
      // 점: 확대/축소와 상관없이 화면에서 같은 크기
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      for (const d of it.dots) {
        const x = view.x + d.x * s;
        const y = view.y + d.y * s;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = d.color;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
        ctx.stroke();
      }
    }
  }
}

function drawImageLayer(ctx, layer, dpr) {
  let source;
  if (layer.render) {
    source = layer.render();
  } else {
    if (!layer.el) {
      layer.el = new Image();
      layer.el.onload = scheduleScienceLayers;
      layer.el.src = layer.image;
    }
    source = layer.el.complete && layer.el.naturalWidth ? layer.el : null;
  }
  if (!source) return;
  const b = layer.bounds;
  const tl = geoToImagePx(b.lonMin, b.latMax);
  const br = geoToImagePx(b.lonMax, b.latMin);
  const s = view.scale;
  ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * view.x, dpr * view.y);
  ctx.globalAlpha = layer.alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
}

function renderScienceLayers() {
  const dpr = window.devicePixelRatio || 1;
  const W = mapEl.clientWidth;
  const H = mapEl.clientHeight;
  if (scienceCanvas.width !== Math.round(W * dpr) || scienceCanvas.height !== Math.round(H * dpr)) {
    scienceCanvas.width = Math.round(W * dpr);
    scienceCanvas.height = Math.round(H * dpr);
  }
  const ctx = scienceCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, scienceCanvas.width, scienceCanvas.height);
  if (!mapImage.naturalWidth || !enabledLayers.size) return;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [id, layer] of Object.entries(IMAGE_LAYERS)) {
    if (enabledLayers.has(id)) drawImageLayer(ctx, layer, dpr);
  }
  for (const def of VECTOR_LAYERS) {
    if (!enabledLayers.has(def.id)) continue;
    if (!layerDrawCache.has(def.id)) layerDrawCache.set(def.id, buildLayerItems(def));
    drawLayerItems(ctx, layerDrawCache.get(def.id), dpr);
  }
  // 탐사 중 발견한 지형 변화 지점 (js/survey.js)
  if (enabledLayers.has("survey_explored")) drawSurveyEvents(ctx, dpr);
  ctx.globalAlpha = 1;
}

let scienceScheduled = false;
let lastViewKey = "";
function scheduleScienceLayers() {
  // 지도가 움직였으면 (현재 화면 모드일 때) 고도 색 기준을 다시 맞춤
  const viewKey = `${view.x | 0},${view.y | 0},${view.scale.toFixed(5)}`;
  if (viewKey !== lastViewKey) {
    lastViewKey = viewKey;
    if (demColor.mode === "view") updateDemRange();
  }
  if (scienceScheduled) return;
  scienceScheduled = true;
  requestAnimationFrame(() => {
    scienceScheduled = false;
    renderScienceLayers();
  });
}

window.addEventListener("resize", scheduleScienceLayers);

// ---------- 켜고 끄기 ----------
function setLayerVisible(id, on) {
  if (id === "hirise_dem") setLayerVisible("hirise_near", on); // 2 m 격자 덮개도 같이
  if (id === "basemap") {
    document.getElementById("map-tiles").style.visibility = on ? "" : "hidden";
  } else if (id === "hirise") {
    mapImage.style.visibility = on ? "" : "hidden";
  } else {
    if (id === "survey_explored") setSurveyExploredVisible(on); // 컬러/흑백은 지도 사진 쪽에서 처리
    if (on) enabledLayers.add(id);
    else enabledLayers.delete(id);
    if (DEM_LAYER_SOURCES[id]) updateDemRange(true);
    scheduleScienceLayers();
  }
}

// ---------- 범례 ----------
function renderLegend(li, items, note) {
  const box = document.createElement("div");
  box.className = "layer-legend";
  for (const it of items || []) {
    const item = document.createElement("span");
    item.className = "layer-legend__item";
    const sw = document.createElement("span");
    sw.className = `layer-legend__swatch${it.shape ? ` is-${it.shape}` : ""}`;
    sw.style.setProperty("--c", it.color);
    item.append(sw, it.label);
    box.append(item);
  }
  if (note) {
    const p = document.createElement("span");
    p.className = "layer-legend__note";
    p.textContent = note;
    box.append(p);
  }
  li.append(box);
}

function renderRampLegend(li, colors, labels, noteText) {
  const box = document.createElement("div");
  box.className = "layer-legend";
  const ramp = document.createElement("span");
  ramp.className = "layer-legend__ramp";
  ramp.style.background = `linear-gradient(to right, ${colors.join(", ")})`;
  const labelRow = document.createElement("span");
  labelRow.className = "layer-legend__ramp-labels";
  for (const text of labels) {
    const el = document.createElement("span");
    el.textContent = text;
    labelRow.append(el);
  }
  const note = document.createElement("span");
  note.className = "layer-legend__note";
  note.textContent = noteText;
  box.append(ramp, labelRow, note);
  li.append(box);
}

// ---------- 환경 레이어 범례 (시각 · 기지 · 나의 정보에 따라 내용이 바뀜) ----------
const ENV_LEGENDS = {
  return_limit: () => {
    const info = env.ret.info;
    const items = RETURN_COLORS.map((c) => ({ color: `rgb(${c.rgb.join(",")})`, label: c.label }));
    if (!info) return { items, note: "계산 중… (기준점에서 다녀오는 데 드는 산소 · 시간)" };
    if (info.outside) return { items, note: "기준점이 Columbia Hills 지도 밖이에요." };
    const b = info.budget;
    const limiter = b.sunsetS < b.evaS ? `일몰까지 ${(b.sunsetS / 3600).toFixed(1)}시간` : `활동 시간 ${(b.evaS / 3600).toFixed(1)}시간`;
    return {
      items,
      note:
        `기준점: ${info.origin.isBase ? "기지 " : ""}${info.origin.name} · 왕복 가능 범위 약 ${info.reachKm2.toFixed(1)} km² (최대 ${(info.maxM / 1000).toFixed(1)} km). ` +
        `예산: 산소 ${Math.round(profileUsableO2L())} L · ${limiter} (안전 여유 ${PROFILE.marginPct}% 제외` +
        `${b.sun.isDay ? "" : ", 지금은 밤 — 일몰 제한 미적용"}). 나의 정보 · 시계를 바꾸면 다시 계산해요.`,
    };
  },
  hazard_level: () => {
    const s = typeof hazardLayerStats !== "undefined" ? hazardLayerStats : null;
    const total = s ? s.safe + s.caution + s.danger : 0;
    const pct = (n) => `${Math.round((n / total) * 100)}%`;
    return {
      items: [
        { color: "rgba(255,216,77,0.8)", label: "주의 — 경사 · 무른 모래 · 거친 지면 · 그늘" },
        { color: "rgba(255,77,77,0.85)", label: "위험 — 급경사 · 모래 함몰 · 바위 많음" },
      ],
      note:
        "HUD 에서 보이는 위험 표시와 같은 기준이에요 (경사 한계는 나의 정보 값). 30 m 칸 단위 · 안전한 곳은 투명. " +
        (total ? `Columbia Hills 30 km 중 주의 ${pct(s.caution)} · 위험 ${pct(s.danger)}` : "계산 중…") +
        (s && s.night ? " · 지금은 밤이라 그늘은 빼고 계산" : ""),
    };
  },
  comm_view: () => ({
    items: [
      { color: "rgba(94,234,212,0.6)", label: "기지와 직선 통신 가능" },
      { color: "#ff3caa", label: "통신 음영 (지형에 가림)" },
    ],
    note: env.comm.count
      ? `기지 ${env.comm.count}곳 · 안테나 ${COMM_ANTENNA_M} m 기준 직선 가시 (지형 + 화성 곡률, 낮은 둔덕 ${COMM_CLEARANCE_M} m 는 회절로 통과)`
      : "기지가 없어요. 포인트 탭 → 포인트 추가 → 종류 '기지' 로 추가하세요.",
  }),
};

function renderEnvLegend(li, id) {
  const box = document.createElement("div");
  box.className = "layer-legend";
  li.append(box);
  const update = () => {
    if (!layerInput(id)?.checked) return;
    const { items, note } = ENV_LEGENDS[id]();
    box.replaceChildren();
    for (const it of items) {
      const item = document.createElement("span");
      item.className = "layer-legend__item";
      const sw = document.createElement("span");
      sw.className = "layer-legend__swatch";
      sw.style.setProperty("--c", it.color);
      item.append(sw, it.label);
      box.append(item);
    }
    const p = document.createElement("span");
    p.className = "layer-legend__note";
    p.textContent = note;
    box.append(p);
  };
  update();
  for (const name of ["envreturnchange", "pointschange", "profilechange", "surveychange"]) document.addEventListener(name, update);
  marsClock.onChange(() => setTimeout(update, 50));
  layerInput(id).addEventListener("change", () => setTimeout(update, 80));
}

// ---------- 탐사 기록 범례 (요약 + 기록 초기화) ----------
function renderSurveyLegend(li) {
  const box = document.createElement("div");
  box.className = "layer-legend survey-legend";
  li.append(box);
  const update = () => {
    const sum = surveySummary();
    box.replaceChildren();
    const row = (label, value) => {
      const item = document.createElement("span");
      item.className = "survey-legend__stat";
      const k = document.createElement("span");
      k.textContent = label;
      const v = document.createElement("strong");
      v.textContent = value;
      item.append(k, v);
      box.append(item);
    };
    if (!sum) {
      row("탐사 지형", "불러오는 중…");
      return;
    }
    row("걸은 거리", sum.trackM >= 1000 ? `${(sum.trackM / 1000).toFixed(2)} km` : `${Math.round(sum.trackM)} m`);
    row("밝힌 면적", `${Math.round(sum.areaM2).toLocaleString()} m²`);
    row("평균 고도 차", `${sum.meanAbsDz.toFixed(2)} m`);
    row("최대 고도 차", `${sum.maxAbsDz.toFixed(1)} m`);
    for (const [type, info] of Object.entries(SURVEY_EVENT_TYPES)) {
      const item = document.createElement("span");
      item.className = "layer-legend__item";
      const sw = document.createElement("span");
      sw.className = "layer-legend__swatch is-diamond";
      sw.style.setProperty("--c", info.color);
      item.append(sw, `${info.label} ${sum.byType[type] || 0}`);
      box.append(item);
    }
    const note = document.createElement("span");
    note.className = "layer-legend__note";
    note.textContent =
      `컬러 = 직접 가 본 곳 (HUD 에서 걸어 다닌 길에서 ${SURVEY_RADIUS_M} m 안 · 지형 데이터는 밟은 30 m 칸 단위로 탐사 데이터로 갱신), 흑백 = 미탐험. ` +
      `기존 DEM 이후 약 ${Math.round(sum.years)}년 변화 반영`;
    box.append(note);
    if (sum.walks) {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "route-link survey-legend__reset";
      reset.textContent = "탐사 기록 지우기";
      reset.addEventListener("click", (e) => {
        e.preventDefault();
        resetSurveyWalks();
      });
      box.append(reset);
    }
  };
  update();
  document.addEventListener("surveychange", update);
}

const RAMP_LEGENDS = {
  ti_overlay: () => [
    SCIENCE_LAYER_META.tiLegend.colormap.map(([, c]) => c),
    ["24 · 먼지", "모래", "800 tiu · 암반"],
    "MGS TES (원본 약 7 km 해상도, 값은 ±15% 근사)",
  ],
  radiation: () => {
    const [lo, hi] = radiationRange();
    return [
      RADIATION_COLORS,
      [`${lo.toFixed(2)} 낮음`, `${((lo + hi) / 2).toFixed(2)}`, `${hi.toFixed(2)} mSv/일 높음`],
      "은하 우주선 추정 선량. 고도(대기 두께) + 오른쪽 위 시계의 시각(계절 · 하루 중 기압, 태양 주기)으로 계산. MSL RAD 관측에 맞춘 근사 — 태양 폭풍 · 지형 차폐는 미반영",
    ];
  },
};

// 히트맵(지도 전체를 색으로 덮는) 레이어의 종류. 같은 종류끼리는 같이 켤 수 있고 (MOLA + HiRISE 고도는 색 기준이 같음),
// 다른 종류를 켜면 먼저 켜져 있던 종류는 자동으로 꺼짐 — 무지개색 지도가 겹치면 읽을 수 없어서
const HEATMAP_FAMILY = { mola_dem: "dem", hirise_dem: "dem", ti_overlay: "thermal", radiation: "radiation",
  survey_explored: "survey", return_limit: "return" };

const layerInput = (id) => layerListEl.querySelector(`input[data-layer="${id}"]`);

// 체크박스 하나 켜고 끄기 (화면 표시 + 다른 히트맵 끄기 + 그룹 제목 갱신)
function toggleLayer(id, on) {
  const input = layerInput(id);
  if (input) input.checked = on;
  setLayerVisible(id, on);
  const family = HEATMAP_FAMILY[id];
  if (on && family) {
    for (const [other, f] of Object.entries(HEATMAP_FAMILY)) {
      const el = layerInput(other);
      if (f !== family && el && el.checked) {
        el.checked = false;
        setLayerVisible(other, false);
      }
    }
  }
  updateLayerGroups();
}

// ---------- 레이어 그룹 (접기/펼치기 · 그룹 전체 켜기/끄기) ----------
const LAYER_FOLD_KEY = "marsmother.layerGroupsCollapsed";
const collapsedLayerGroups = new Set(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(LAYER_FOLD_KEY)) || [];
    } catch {
      return [];
    }
  })()
);

function updateLayerGroups() {
  layerListEl.querySelectorAll(".layer-group").forEach((group) => {
    const inputs = [...group.querySelectorAll("input[data-layer]")];
    const on = inputs.filter((i) => i.checked).length;
    const fold = group.querySelector(".layer-group__fold");
    fold.textContent = `${fold.dataset.name} (${inputs.length})`;
    const toggle = group.querySelector(".layer-group__toggle");
    // 히트맵은 종류당 하나씩만 켜지므로 '전부 켜짐' 은 켤 수 있는 만큼 켜진 상태
    toggle.checked = on > 0 && on >= groupOnTargets(inputs).length;
    toggle.indeterminate = on > 0 && !toggle.checked;
  });
}

// 그룹 전체 켜기에서 켤 레이어: 히트맵은 종류가 겹치지 않게 첫 종류만
function groupOnTargets(inputs) {
  let family = null;
  return inputs.filter((i) => {
    const f = HEATMAP_FAMILY[i.dataset.layer];
    if (!f) return true;
    if (family === null) family = f;
    return f === family;
  });
}

function initLayerGroups() {
  layerListEl.querySelectorAll(".layer-group").forEach((group) => {
    const id = group.dataset.group;
    const fold = group.querySelector(".layer-group__fold");
    fold.dataset.name = fold.textContent;
    const setCollapsed = (collapsed) => {
      group.classList.toggle("is-collapsed", collapsed);
      fold.setAttribute("aria-expanded", String(!collapsed));
    };
    setCollapsed(collapsedLayerGroups.has(id));
    fold.addEventListener("click", () => {
      const collapsed = !group.classList.contains("is-collapsed");
      if (collapsed) collapsedLayerGroups.add(id);
      else collapsedLayerGroups.delete(id);
      try {
        localStorage.setItem(LAYER_FOLD_KEY, JSON.stringify([...collapsedLayerGroups]));
      } catch {
        // 저장 실패 시 이번 접속 동안만 유지
      }
      setCollapsed(collapsed);
    });

    const toggle = group.querySelector(".layer-group__toggle");
    toggle.addEventListener("change", () => {
      const inputs = [...group.querySelectorAll("input[data-layer]")];
      const targets = toggle.checked ? groupOnTargets(inputs) : [];
      for (const input of inputs) toggleLayer(input.dataset.layer, targets.includes(input));
      saveLayerState();
    });
  });
}

// ---------- 시작 ----------
function initLayers() {
  const saved = loadLayerState();
  layerInput("hirise_dem").closest("li").after(demControlEl);
  initLayerGroups();

  const inputs = [...layerListEl.querySelectorAll("input[data-layer]")];
  for (const input of inputs) {
    const id = input.dataset.layer;
    const li = input.closest("li");
    const def = VECTOR_LAYERS.find((l) => l.id === id);
    if (def) renderLegend(li, def.legend, def.note);
    if (RAMP_LEGENDS[id]) renderRampLegend(li, ...RAMP_LEGENDS[id]());
    if (id === "survey_explored") renderSurveyLegend(li);
    if (ENV_LEGENDS[id]) renderEnvLegend(li, id);
    if (id in saved) input.checked = saved[id];
    input.addEventListener("change", () => {
      toggleLayer(id, input.checked);
      saveLayerState();
    });
  }
  // 저장된 상태에 히트맵이 여러 종류 켜져 있으면 첫 종류만 남김
  let family = null;
  for (const input of inputs) {
    const f = HEATMAP_FAMILY[input.dataset.layer];
    if (f && input.checked) {
      if (family === null) family = f;
      else if (f !== family) input.checked = false;
    }
    setLayerVisible(input.dataset.layer, input.checked);
  }
  updateLayerGroups();
}

if (mapImage.complete && mapImage.naturalWidth) initLayers();
else mapImage.addEventListener("load", initLayers, { once: true });
