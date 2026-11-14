// 탐사 지역 정보와 지역별 주요 포인트 데이터
// 좌표는 [경도(°E), 위도(°N, 남반구는 음수)] 기준

// 지역별 지도 이미지와 범위 (bounds는 지도 이미지 네 변의 경위도)
const REGIONS = {
  gusev: {
    name: "Gusev · Columbia Hills",
    image: "assets/maps/columbia-hills.png",
    widthM: 29990,
    bounds: { lonMin: 175.1753, lonMax: 175.6981, latMin: -14.8277, latMax: -14.3215 },
    // 3D 지형: 실제 DEM을 축소한 높이맵 (밝을수록 높음, minM~maxM 범위)
    terrain: { heightmap: "assets/terrain/gusev-height.png", minM: -2023.2, maxM: -1829.0 },
    // HUD 1인칭 3D 지형: data/ 원본 DEM + 가시광 모자이크에서 현위치 주변 3km 를 잘라냄
    hudTerrain: {
      height: "assets/terrain/hud-near-height.png", // 601×601, 5m 간격, 16bit (R 상위 · G 하위)
      surface: "assets/terrain/hud-near-surface.jpg", // 2048×2048, 약 1.5 m/px
      bounds: { lonMin: 175.4618523, lonMax: 175.5141477, latMin: -14.6033059, latMax: -14.5526941 },
      minM: -1946.9,
      maxM: -1923.51,
    },
    // 데모용 현위치 (실제로는 탐사 대원의 위치 장비 값으로 교체)
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
  landmark: { label: "주요 지점", color: "#ffd166" },
  photo: { label: "사진 위치", color: "#4cc9f0" },
  cave: { label: "동굴", color: "#c084fc" },
  custom: { label: "내 포인트", color: "#ff7b54" },
};

// 사진 위치 핀을 누르면 보이는 사진들 (데모용 흑백 이미지)
// - panorama: 360° 파노라마 1장 (위쪽 뷰어, 슬라이더/드래그로 방향 돌려보기)
// - gallery: 그 외 사진들 (아래쪽 격자)
function demoMedia(scene, galleryStart) {
  return {
    panorama: `assets/photos/pano-${scene}.jpg`,
    gallery: Array.from({ length: 8 }, (_, i) => `assets/photos/gallery-${((galleryStart + i) % 12) + 1}.jpg`),
  };
}

// ⚠️ 아래 Spirit 관련 좌표는 화면 확인용 "대략적인 예시" 입니다.
//    실제 서비스에서는 NASA PDS의 MER Spirit 주행 경로 데이터 등으로 교체하세요.
const REGION_POINTS = {
  gusev: [
    {
      id: "spirit-route",
      type: "route",
      name: "Spirit 이동 경로",
      note: "착륙 지점 → Columbia Hills → Home Plate (예시)",
      path: [
        [175.4726, -14.5684],
        [175.476, -14.567],
        [175.485, -14.573],
        [175.495, -14.579],
        [175.504, -14.588],
        [175.513, -14.595],
        [175.516, -14.608],
        [175.514, -14.609],
      ],
    },
    {
      id: "spirit-landing",
      type: "landmark",
      name: "Columbia Memorial Station",
      note: "Spirit 착륙 지점 (2004-01-04)",
      lon: 175.4726,
      lat: -14.5684,
    },
    {
      id: "bonneville",
      type: "landmark",
      name: "Bonneville Crater",
      note: "착륙 직후 탐사한 크레이터",
      lon: 175.476,
      lat: -14.567,
    },
    {
      id: "husband-hill",
      type: "landmark",
      name: "Husband Hill 정상",
      note: "Columbia Hills 최고봉",
      lon: 175.513,
      lat: -14.595,
    },
    {
      id: "home-plate",
      type: "landmark",
      name: "Home Plate",
      note: "화산성 층상 지형",
      lon: 175.516,
      lat: -14.608,
    },
    {
      id: "troy",
      type: "landmark",
      name: "Troy",
      note: "Spirit 최종 정지 위치 (2009)",
      lon: 175.514,
      lat: -14.609,
    },
    // 사진 위치: photo 는 데모용 흑백 이미지 (실제 로버 사진 아님)
    {
      id: "photo-landing",
      type: "photo",
      name: "착륙 지점 파노라마",
      note: "데모 사진",
      lon: 175.471,
      lat: -14.57,
      photo: "assets/photos/demo-1.jpg",
      media: demoMedia(1, 0),
    },
    {
      id: "photo-bonneville",
      type: "photo",
      name: "Bonneville 가장자리",
      note: "데모 사진",
      lon: 175.479,
      lat: -14.564,
      photo: "assets/photos/demo-2.jpg",
      media: demoMedia(2, 3),
    },
    {
      id: "photo-lahontan",
      type: "photo",
      name: "Lahontan 부근",
      note: "데모 사진",
      lon: 175.495,
      lat: -14.581,
      photo: "assets/photos/demo-3.jpg",
      media: demoMedia(1, 6),
    },
    {
      id: "everest-pano",
      type: "photo",
      name: "Everest 파노라마",
      note: "Husband Hill 정상에서 촬영한 360° 파노라마 (데모 사진)",
      lon: 175.511,
      lat: -14.593,
      photo: "assets/photos/demo-4.jpg",
      media: demoMedia(2, 9),
    },
    {
      id: "photo-home-plate",
      type: "photo",
      name: "Home Plate 근접 촬영",
      note: "데모 사진",
      lon: 175.518,
      lat: -14.607,
      photo: "assets/photos/demo-5.jpg",
      media: demoMedia(1, 2),
    },
  ],
};
