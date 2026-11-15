// 탐사 지역 정보와 지역별 주요 포인트 데이터
// 좌표는 [경도(°E), 위도(°N, 남반구는 음수)] 기준

// 지역별 지도 이미지와 범위 (bounds는 지도 이미지 네 변의 경위도)
const REGIONS = {
  gusev: {
    name: "Gusev · Columbia Hills",
    image: "assets/maps/columbia-hills.png",
    widthM: 29990,
    bounds: { lonMin: 175.1753, lonMax: 175.6981, latMin: -14.8277, latMax: -14.3215 },
    // HUD 1인칭 3D 지형의 표면 사진: 현위치 주변 3km (가시광 모자이크, 2048×2048, 약 1.5 m/px)
    // 높이(DEM)는 js/data/terrain.js 의 DEM_DATA (near · hirise · mola) 를 사용
    hudTerrain: { surface: "assets/terrain/hud-near-surface.jpg" },
    // 탐사 대원의 현위치 (시작 값). ◎ 버튼(현재 위치 찾기)을 누르면 지형 매칭으로 추정한 위치로 바뀜
    currentPosition: { lon: 175.488, lat: -14.578 },
    // 위치 추정(지형 매칭)용 실제 데이터
    //  - 관측: NASA Spirit 로버 Navcam 수직투영 모자이크 (PDS, sol 36, site 4) → 0.5m 격자
    //  - 궤도 지도: data/ 가시광 모자이크에서 정답 주변 300m 를 0.5m 격자로
    //  - 정답: 매칭 결과를 궤도 사진에 찍힌 Spirit 착륙선 위치로 따로 확인한 값
    localize: {
      observation: "assets/localize/spirit-sol036-obs.png", // 160×160 (80m), 알파 = 데이터 있음
      roverView: "assets/localize/spirit-sol036-view.jpg", // 화면용 (10cm/px)
      orbit: "assets/localize/spirit-orbit.png", // 600×600 (300m)
      orbitBounds: { lonMin: 175.4753363, lonMax: 175.4805657, latMin: -14.5740346, latMax: -14.5689734 },
      resM: 0.5,
      truth: { lon: 175.477951, lat: -14.571504 },
      rover: {
        name: "Spirit (MER-A)",
        product: "2NN036EFF04VRT00P1617L000M2",
        sol: 36,
        date: "2004-02-09",
        radiusM: 40,
        sourceUrl: "https://planetarydata.jpl.nasa.gov/img/data/mer/spirit/mer2om_0xxx/data/navcam/site0004/",
      },
    },
  },
};

// 지역을 고르면 지도가 날아갈 중심 좌표와 화면에 보여줄 범위(spanKm) (대략값)
// Gusev 는 REGIONS 의 bounds (지도 사진 전체) 를 사용
const REGION_CENTERS = {
  jezero: { lon: 77.58, lat: 18.38, spanKm: 120 },
  gale: { lon: 137.8, lat: -5.4, spanKm: 250 },
  "valles-marineris": { lon: -59.2, lat: -13.9, spanKm: 3500 },
  "olympus-mons": { lon: -133.8, lat: 18.65, spanKm: 900 },
  "utopia-planitia": { lon: 117.5, lat: 46.7, spanKm: 1500 },
};

// 포인트 종류 (목록 그룹, 핀 색상)
const POINT_TYPES = {
  route: { label: "로버 경로", color: "#7df9c4" },
  rover: { label: "Spirit Cam", color: "#ff9f1c" },
  cave: { label: "동굴", color: "#c084fc" },
  lost: { label: "로버 교신 두절", color: "#ff5a5a" }, // 로버를 잃어버린 지점
  base: { label: "기지", color: "#5eead4" }, // 통신 가시성 · 안전 귀환 기준 (HUD 에 기지 건물로 보임)
  custom: { label: "내 포인트", color: "#ff7b54" },
};

// Gusev 포인트: 모두 실제 데이터
//  - Spirit 이동 경로: NASA 주행 기록 (js/data/spirit.js ← preprocess/build_traverse.py)
//  - Spirit Cam: Spirit 이 그 자리에서 실제로 찍은 Pancam · Navcam 파노라마
//  (예전 '주요 지점' · '사진 위치' 포인트는 Spirit Cam 과 겹쳐서 뺐음. 데이터는 SPIRIT_TRAVERSE.landmarks 에 그대로 있음)

// 로버 사진 핀에서 처음 보여줄 파노라마: 가장 가로로 긴 사진 (같으면 앞쪽 = Pancam)
function widestPhotoIndex(photos) {
  let best = 0;
  photos.forEach((ph, i) => {
    const b = photos[best];
    const aspect = (p) => (p.src ? p.width / p.height : -1);
    if (aspect(ph) > aspect(b)) best = i;
  });
  return best;
}

const REGION_POINTS = {
  gusev: [
    {
      id: "spirit-route",
      type: "route",
      name: "Spirit 이동 경로",
      note: `실제 주행 기록 · sol 1 ~ ${SPIRIT_TRAVERSE.lastSol} · 약 ${(SPIRIT_TRAVERSE.distanceM / 1000).toFixed(1)} km`,
      path: SPIRIT_TRAVERSE.path.map(([lon, lat]) => [lon, lat]),
    },
    // Spirit Cam 핀: Spirit 이 그 자리에서 실제로 찍은 Pancam · Navcam 사진 (NASA Photojournal)
    //   js/data/rover_pins.js ← preprocess/build_rover_photos.py ← data/spirit/spirit_pin.json
    ...ROVER_PINS.map((r) => ({
      id: `rover-pin${r.id}`,
      type: "rover",
      name: r.name,
      note: `sol ${r.startSol === r.endSol ? r.startSol : `${r.startSol}~${r.endSol}`} · ${r.photos.map((ph) => `${ph.camera} ${ph.id}`).join(" · ")} · 고도 ${Math.round(r.elevM)} m`,
      lon: r.lon,
      lat: r.lat,
      sol: r.startSol,
      media: { photos: r.photos, pano: widestPhotoIndex(r.photos) },
    })),
    // Troy: Spirit 이 모래에 빠져 움직이지 못하다 교신이 끊긴 마지막 위치 → "로버 교신 두절" 포인트
    ...SPIRIT_TRAVERSE.landmarks
      .filter((l) => l.id === "troy")
      .map((l) => ({
        id: l.id,
        type: "lost",
        name: "Spirit 교신 두절 지점 (Troy)",
        note: `${l.note} · 고도 ${Math.round(l.elevM)} m`,
        lon: l.lon,
        lat: l.lat,
        sol: l.sol,
        media: SITE_MEDIA[l.id] && { panorama: SITE_MEDIA[l.id].panorama, gallery: SITE_MEDIA[l.id].gallery },
      })),
  ],
};
