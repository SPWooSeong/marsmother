// 자동 생성 파일 — 직접 고치지 말고 preprocess/build_terrain.py 를 다시 실행
// 실제 DEM (고도) 데이터 정보. 읽는 코드는 js/dem.js
const DEM_DATA = {
  "colormap": [
    "#3b2a8c",
    "#2456c7",
    "#2bb5a0",
    "#4fbf3b",
    "#e8e03a",
    "#f08a24",
    "#d6301c",
    "#8c4a2f",
    "#f2f2f2"
  ],
  "mola": {
    "name": "MOLA + HRSC (200 m/px)",
    "height": "assets/terrain/mola-400km-height.png",
    "bounds": {
      "lonMin": 171.9477956,
      "lonMax": 178.9221034,
      "latMin": -17.9516219,
      "latMax": -11.2000061
    },
    "minM": -2961.0,
    "maxM": 2736.0,
    "relief": "assets/layers/mola-relief.jpg",
    "reliefRange": [
      -3000.0,
      2800.0
    ]
  },
  "hirise": {
    "name": "HiRISE · CTX · HRSC 모자이크 (1 m/px)",
    "height": "assets/terrain/gusev-30km-height.png",
    "bounds": {
      "lonMin": 175.1752978,
      "lonMax": 175.6980758,
      "latMin": -14.8276701,
      "latMax": -14.3215408
    },
    "minM": -2170.0,
    "maxM": -1776.0,
    "relief": "assets/layers/hirise-relief.jpg",
    "reliefRange": [
      -1960.0,
      -1840.0
    ]
  },
  "near": {
    "name": "HiRISE DEM (2 m 격자)",
    "height": "assets/terrain/hud-near-height.png",
    "bounds": {
      "lonMin": 175.4618523,
      "lonMax": 175.5141477,
      "latMin": -14.6033059,
      "latMax": -14.5526941
    },
    "minM": -1947.0,
    "maxM": -1923.0
  }
};
