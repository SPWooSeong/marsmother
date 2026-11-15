// Mars Mother — 선외활동(EVA) 모델: 걷는 속도 · 대사량 · 산소 · 냉각수 · 전력
// 길찾기(route.js)와 HUD 생체/장비 상태(hud.js)가 같이 씀. 지형(경사)은 실제 DEM, 지표 물질은 TES 열관성에서 가져옴.
//
//  속도   Tobler 보행 함수 (경사에 따른 걷는 속도) — 평지 속도를 우주복 기준으로 낮춤
//  대사량 Pandolf 식 (짐을 지고 걷는 사람의 소비 전력, W). 화성 중력(0.378 g)만큼 이동 항을 줄임
//           M = 1.5·W + g비 · [ 2(W+L)(L/W)² + η(W+L)(1.5V² + 0.35·V·G) ]   (W 몸무게, L 우주복, V m/s, G 경사 %)
//           η 지면 계수: 단단한 땅 1.1 · 모래가 섞인 땅 1.4 · 무른 모래 1.8 (모래 빠짐 위험 레이어로 정함)
//           내리막은 오르막 식 대신 평지 비용을 경사만큼 줄여 근사
//  산소   소비 전력 → 산소 (산소 1 L 당 약 20.1 kJ)
//  냉각수 우주복은 물을 승화시켜 체열을 버림 (승화열 약 2,830 kJ/kg)
//  전력   팬 · 펌프 · 통신 · 디스플레이 고정 소비
// ⚠ 우주복 사양(무게 · 탱크 · 배터리)은 Apollo A7LB / NASA xEMU 공개 수치를 참고한 가정값.

const EVA = {
  bodyKg: 75,
  suitKg: 55, // 화성용 우주복 + 생명유지장치 (가정)
  gRatio: 3.71 / 9.81,
  flatSpeedMps: 1.0, // 평지 걷기 (Apollo 선외활동 평균 이동 속도 수준)
  runFactor: 1.7, // 뛰기 (Shift)
  o2KjPerL: 20.1,
  o2GPerL: 1.429,
  o2TankL: 460, // 약 0.66 kg (Apollo PLSS 주 산소량 수준)
  waterKg: 4.0, // 승화기 냉각수
  sublimationKjPerKg: 2830,
  heatToWater: 0.85, // 대사열 중 승화기로 버리는 비율 (나머지는 우주복 밖으로 직접 빠짐)
  batteryWh: 900,
  suitPowerW: 95,
  slopeLimitDeg: 25, // 이보다 가파르면 걸어서 못 감
  dailyEnergyKj: 8 * 3600 * 0.3, // 피로도 기준: 8시간 동안 평균 300 W
};

// 경사 tan(θ) (오르막 +) → 걷는 속도 (m/s)
function evaSpeed(grade, eta = 1.1) {
  const tobler = Math.exp(-3.5 * Math.abs(grade + 0.05)) / Math.exp(-3.5 * 0.05); // 평지 = 1, 약한 내리막에서 최대
  return EVA.flatSpeedMps * tobler * Math.sqrt(1.1 / eta); // 무른 땅일수록 느림
}

// 소비 전력 (W). speed 0 이면 서 있는 상태
function evaMetabolicW(speed, grade, eta = 1.1) {
  const W = EVA.bodyKg;
  const L = EVA.suitKg;
  const base = 1.5 * W + EVA.gRatio * 2 * (W + L) * (L / W) ** 2;
  if (speed <= 0) return base;
  const G = grade * 100;
  const level = EVA.gRatio * eta * (W + L) * 1.5 * speed * speed;
  if (G >= 0) return base + level + EVA.gRatio * eta * (W + L) * 0.35 * speed * G;
  return base + level * Math.max(0.55, 1 + G / 25); // 내리막: 완만하면 덜 듦 (근사)
}

function evaO2LPerS(watts) {
  return watts / 1000 / EVA.o2KjPerL;
}

function evaWaterKgPerS(watts) {
  return ((watts / 1000) * EVA.heatToWater) / EVA.sublimationKjPerKg;
}

// 1 m 를 걷는 데 드는 에너지의 최솟값 (길찾기 휴리스틱용)
const EVA_MIN_J_PER_M = (() => {
  let best = Infinity;
  for (let g = -0.4; g <= 0.4; g += 0.005) {
    const v = evaSpeed(g);
    best = Math.min(best, evaMetabolicW(v, g) / v / Math.sqrt(1 + g * g));
  }
  return best;
})();

// ---------- 지표 물질: 모래 빠짐 위험 (TES 열관성, 약 7 km 해상도) ----------
// 열관성 레이어의 다각형 안에 있는지 확인 (data/layers.js 의 SCIENCE_LAYERS.ti_sand_trap)
function sandRiskAt(lon, lat) {
  const fc = typeof SCIENCE_LAYERS !== "undefined" && SCIENCE_LAYERS.ti_sand_trap;
  if (!fc) return null;
  for (const f of fc.features) {
    let inside = false;
    for (const ring of f.geometry.coordinates) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (inside) return { risk: f.properties.risk, name: f.properties.risk_ko };
  }
  return null;
}

const SAND_ETA = { high: 1.8, moderate: 1.4, low: 1.1 };
function terrainEta(lon, lat) {
  const s = sandRiskAt(lon, lat);
  return s ? SAND_ETA[s.risk] : 1.1;
}
