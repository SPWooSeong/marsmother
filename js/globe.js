// Mars Mother - 3D 지도 (CesiumJS + Cesium ion 화성 3D Tiles)
// 오른쪽 아래 2D/3D 버튼으로 전환.
// 위에서 내려다본(2D와 같은) 모습에서 시작해, 카메라가 화성 지평선이 보이도록 날아가며 기울어짐.
// 화성 전체 지형은 Cesium ion 의 Mars 3D Tiles (NASA, ESA, USGS) 를 사용하고,
// 그 위에 우리 데이터(탐사 지역 테두리, 포인트, 경로, 현위치, 길찾기 결과)를 올림.
//
// 사용하는 전역 값: CESIUM_ION_TOKEN, MARS_TILESET_ASSET_ID (config.js)
//                  REGIONS, REGION_CENTERS, POINT_TYPES (data/points.js)
//                  currentRegion, getPoints (main.js) / getCurrentPosition, nav (route.js)

// ---------- 설정 ----------
const CESIUM_VERSION = "1.135";
const CESIUM_BASE = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium/`;
const TOP_DOWN_HEIGHT_M = 45000; // 2D 지도와 비슷하게 보이는 높이
const ENTER_FLIGHT_S = 3; // 3D로 날아가는 시간
const EXIT_FLIGHT_S = 1.6;

const viewBtn = document.getElementById("view-btn");
const globeView = document.getElementById("globe-view");
const globeLoading = document.getElementById("globe-loading");
const globeMsg = document.getElementById("globe-msg");

const globe = { ready: false, on: false, busy: false };
let viewer = null;

// ---------- CesiumJS 불러오기 (처음 3D를 켤 때 한 번) ----------
function loadCesium() {
  if (window.Cesium) return Promise.resolve();
  window.CESIUM_BASE_URL = CESIUM_BASE;
  return new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${CESIUM_BASE}Widgets/widgets.css`;
    document.head.append(css);

    const script = document.createElement("script");
    script.src = `${CESIUM_BASE}Cesium.js`;
    script.onload = resolve;
    script.onerror = () => reject(new Error("CesiumJS 를 불러오지 못했어요"));
    document.head.append(script);
  });
}

async function initCesium() {
  await loadCesium();
  Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;
  Cesium.Ellipsoid.default = Cesium.Ellipsoid.MARS;

  viewer = new Cesium.Viewer("globe-cesium", {
    globe: false, // 지구 대신 화성 3D Tiles 만 표시
    baseLayer: false,
    skyAtmosphere: new Cesium.SkyAtmosphere(Cesium.Ellipsoid.MARS),
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  });

  const scene = viewer.scene;
  scene.backgroundColor = Cesium.Color.BLACK;
  // 화성 대기: 지구보다 옅고 덜 파랗게
  scene.skyAtmosphere.saturationShift = -0.35;
  scene.skyAtmosphere.brightnessShift = -0.1;

  const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(MARS_TILESET_ASSET_ID, {
    enableCollision: true, // 카메라가 지형 아래로 들어가지 않게
  });
  scene.primitives.add(tileset);

  globe.ready = true;
}

// ---------- 좌표 ----------
const deg = (lon, lat, h = 0) => Cesium.Cartesian3.fromDegrees(lon, lat, h, Cesium.Ellipsoid.MARS);

function regionCenter(region = currentRegion) {
  const r = REGIONS[region];
  if (r) {
    const b = r.bounds;
    return { lon: (b.lonMin + b.lonMax) / 2, lat: (b.latMin + b.latMax) / 2 };
  }
  return REGION_CENTERS[region] || null;
}

// 위에서 내려다보는 시점 (2D 지도와 같은 느낌)
function topDownView(center) {
  return {
    destination: deg(center.lon, center.lat, TOP_DOWN_HEIGHT_M),
    orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
  };
}

// 비스듬히 지평선까지 보이는 시점: 남쪽 하늘 높은 곳에서 북쪽을 바라봄
function horizonView(center) {
  return {
    destination: deg(center.lon, center.lat - 3.25, 120000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-32), roll: 0 },
  };
}

function flyTo(view, seconds) {
  return new Promise((resolve) => {
    viewer.camera.flyTo({
      ...view,
      duration: seconds,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      complete: resolve,
      cancel: resolve,
    });
  });
}

// ---------- 우리 데이터 올리기 ----------
function cssColor(hex, alpha = 1) {
  return Cesium.Color.fromCssColorString(hex).withAlpha(alpha);
}

function addPin(lon, lat, text, color, { big = false, alwaysLabel = false } = {}) {
  viewer.entities.add({
    position: deg(lon, lat),
    point: {
      pixelSize: big ? 14 : 9,
      color: cssColor(color),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_3D_TILE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text,
      font: `${big ? "bold 14px" : "600 12px"} sans-serif`,
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      showBackground: true,
      backgroundColor: cssColor("#140c08", 0.7),
      backgroundPadding: new Cesium.Cartesian2(7, 4),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -14),
      heightReference: Cesium.HeightReference.CLAMP_TO_3D_TILE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      // 멀리서는 이름이 겹치므로 가까이 갔을 때만 이름 표시
      distanceDisplayCondition: alwaysLabel ? undefined : new Cesium.DistanceDisplayCondition(0, 90000),
    },
  });
}

function addLine(lonLats, color, width) {
  if (lonLats.length < 2) return;
  viewer.entities.add({
    polyline: {
      positions: lonLats.map(([lon, lat]) => deg(lon, lat)),
      width,
      material: cssColor(color),
      clampToGround: true, // 지형 위에 붙여 그림
    },
  });
}

function buildOverlays() {
  viewer.entities.removeAll();
  const region = REGIONS[currentRegion];
  const center = regionCenter();

  if (region) {
    // 탐사 지역 테두리 + 이름
    const b = region.bounds;
    addLine(
      [
        [b.lonMin, b.latMax],
        [b.lonMax, b.latMax],
        [b.lonMax, b.latMin],
        [b.lonMin, b.latMin],
        [b.lonMin, b.latMax],
      ],
      "#7df9c4",
      3
    );
  }
  if (center) {
    viewer.entities.add({
      position: deg(center.lon, center.lat, 15000),
      label: {
        text: region ? region.name : document.getElementById("region-name").textContent,
        font: "bold 16px sans-serif",
        fillColor: cssColor("#7df9c4"),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        // 멀리서 볼 때만 지역 이름 표시
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(90000, 2.0e7),
      },
    });
  }
  if (!region) return; // 다른 지역은 아직 포인트 데이터 없음

  // 포인트와 경로
  for (const p of getPoints()) {
    const color = (POINT_TYPES[p.type] || POINT_TYPES.custom).color;
    if (p.path) addLine(p.path, color, 3);
    else if (p.lon != null) addPin(p.lon, p.lat, p.name, color);
  }

  // 길찾기 결과 (선택된 경로) 와 출발/도착
  const selected = nav.results.find((r) => r.id === nav.selectedId);
  if (selected) addLine(selected.path.map((p) => [p.lon, p.lat]), selected.color, 5);
  for (const s of nav.stops) {
    if (!s.lonLat || s.kind === "via") continue;
    addPin(s.lonLat.lon, s.lonLat.lat, s.kind === "start" ? "출발" : "도착", s.kind === "start" ? "#ff5a5a" : "#b38cff", { big: true });
  }

  const here = getCurrentPosition();
  if (here) addPin(here.lon, here.lat, "현위치", "#4cc9f0", { big: true });
}

// ---------- 2D ↔ 3D 전환 ----------
async function enter3D() {
  if (globe.busy) return;
  const center = regionCenter();
  if (!center) return;
  globe.busy = true;

  // 처음엔 Cesium 을 불러오는 동안 안내 표시
  globe.on = true;
  document.body.classList.add("is-3d");
  globeView.hidden = false;
  setViewBtn(true);
  requestAnimationFrame(() => globeView.classList.add("is-visible"));

  try {
    if (!globe.ready) {
      globeLoading.hidden = false;
      await initCesium();
    }
  } catch (e) {
    console.error(e);
    globeLoading.hidden = true;
    showGlobeMsg("3D 화성 지형을 불러오지 못했어요. 인터넷 연결과 Cesium 토큰을 확인하세요.");
    globe.busy = false;
    hide3D();
    return;
  }
  globeLoading.hidden = true;

  viewer.useDefaultRenderLoop = true;
  buildOverlays();
  viewer.camera.setView(topDownView(center));
  await flyTo(horizonView(center), ENTER_FLIGHT_S);
  globe.busy = false;
}

async function exit3D() {
  if (globe.busy) return;
  globe.busy = true;
  const center = regionCenter();
  if (center) await flyTo(topDownView(center), EXIT_FLIGHT_S);
  hide3D();
  globe.busy = false;
}

function hide3D() {
  globeView.classList.remove("is-visible");
  document.body.classList.remove("is-3d");
  setViewBtn(false);
  globe.on = false;
  setTimeout(() => {
    if (globe.on) return;
    globeView.hidden = true;
    if (viewer) viewer.useDefaultRenderLoop = false; // 안 보일 때는 그리기 멈춤
  }, 350);
}

function setViewBtn(is3D) {
  viewBtn.textContent = is3D ? "3D" : "2D";
  viewBtn.classList.toggle("is-active", is3D);
  viewBtn.setAttribute("aria-label", is3D ? "2D 지도로 전환" : "3D 지도로 전환");
}

function showGlobeMsg(text) {
  globeMsg.textContent = text;
  globeMsg.hidden = false;
  clearTimeout(showGlobeMsg.t);
  showGlobeMsg.t = setTimeout(() => (globeMsg.hidden = true), 4000);
}

viewBtn.addEventListener("click", () => (globe.on ? exit3D() : enter3D()));

// 3D에서 지역을 바꾸면 그 지역으로 날아감
document.addEventListener("regionchange", async () => {
  if (!globe.on || !viewer || globe.busy) return;
  const center = regionCenter();
  if (!center) return;
  globe.busy = true;
  buildOverlays();
  await flyTo(horizonView(center), ENTER_FLIGHT_S);
  globe.busy = false;
});

// ◎ 버튼(현재 위치 찾기)은 js/localize.js 에서 처리 — 3D 에서는 결과 위치로 날아감
