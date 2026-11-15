// Mars Mother — 시간 (오른쪽 위 시계) + 시간에 따른 방사선 추정
//
// 1) 시계: 실제 현재 시각으로 흐르다가, 사용자가 바꾸면 그 시각에 멈춤. "현재 시각으로" 를 누르면 다시 흐름.
// 2) 화성 시간: 지구 시각 → 화성 솔 날짜(MSD) · 계절(Ls) · 지방 태양시(LTST).  Mars24 알고리즘 (Allison & McEwen 2000)
// 3) 방사선: 지표 은하 우주선(GCR) 선량 당량 추정 (mSv/일)
//
//      선량 = D_ref × (기압 / P_ref)^(-k) × 태양주기 계수
//      기압 = P0 × exp(-고도 / H) × 계절 계수(Ls) × 일주 계수(LTST)
//
//    - 고도: 낮은 곳일수록 대기가 두꺼워 덜 받음 (MOLA / HiRISE DEM)
//    - 계절: 극관의 CO₂ 가 얼고 녹으며 기압이 약 ±13% 변함 (Viking Lander 1 연간 곡선을 2차 조화로 근사)
//    - 하루: 열조석으로 기압이 아침에 높고 늦은 오후에 낮음 (약 ±5%, 근사)
//    - 태양 주기(약 11년): 태양 활동이 약할수록 우주선이 많이 들어옴 (극소기에 약 +35%, 근사)
//    - 기준: MSL RAD 관측 — Gale 크레이터, 약 850 Pa, 2012~2013년에 약 0.64 mSv/일 (Hassler et al. 2014)
//    ⚠ k(기압 민감도) · 일주/태양주기 진폭은 관측 경향을 근사한 가정값. 태양 입자 사건(SPE) · 지형 차폐는 미반영.
//
// 쓰는 곳: 방사선 레이어 (layers.js), HUD 방사선 표시 (hud.js)
// 사용하는 전역 값: REGIONS, currentRegion (main.js) / getCurrentPosition (route.js) / demElevation, loadDemGrid (dem.js)

// ---------- 방사선 모델 상수 ----------
const RAD_MODEL = {
  refMsvPerDay: 0.64, // MSL RAD 지표 평균 선량 당량
  refPa: 850, // 그때 Gale 의 평균 기압
  refYear: 2013.0, // 관측 시기 (태양주기 계수 = 1 인 기준)
  k: 0.35, // 기압 1% 증가 → 선량 약 0.35% 감소 (가정)
  p0Pa: 610, // MOLA 기준면(고도 0 m)의 연평균 기압
  scaleHeightM: 11100, // 대기 규모 높이
  // 계절 계수 = c0 + c1·cos Ls + s1·sin Ls + c2·cos 2Ls + s2·sin 2Ls  (최대 Ls≈270°, 최소 Ls≈150°)
  season: { c0: 1.0008, c1: 0.0425, s1: -0.1081, c2: -0.0234, s2: 0.022 },
  diurnal: { amp1: 0.05, peak1H: 7, amp2: 0.02, peak2H: 9.5 }, // 일주 + 반일주 성분
  solar: { amp: 0.18, minYear: 2019.9, periodY: 11 }, // 극소기(2019.9)에 우주선 최대
};

// ---------- 화성 시간 (Mars24) ----------
const MARS_SOL_MS = 88775244; // 1솔 = 24시간 39분 35.244초
const TT_MINUS_UTC_S = 69.184; // 윤초 37초 + 32.184초 (2017년 이후)
const rad = (d) => (d * Math.PI) / 180;
const mod = (a, n) => ((a % n) + n) % n;

// date(지구 시각) → 화성 시간.  lonE: 지방시를 구할 동경 (°)
function marsTime(date, lonE) {
  const jdTT = date.getTime() / 86400000 + 2440587.5 + TT_MINUS_UTC_S / 86400;
  const dt = jdTT - 2451545.0; // J2000 부터의 날 수
  const M = 19.3871 + 0.52402073 * dt; // 평균 근점 이각
  const alphaFMS = 270.3871 + 0.524038496 * dt; // 가상 평균 태양의 각도
  // 다른 행성의 섭동
  const A = [0.0071, 0.0057, 0.0039, 0.0037, 0.0021, 0.002, 0.0018];
  const tau = [2.2353, 2.7543, 1.1177, 15.7866, 2.1354, 2.4694, 32.8493];
  const phi = [49.409, 168.173, 191.837, 21.736, 15.704, 95.528, 49.095];
  let pbs = 0;
  for (let i = 0; i < 7; i++) pbs += A[i] * Math.cos(rad((0.985626 * dt) / tau[i] + phi[i]));
  const nuMinusM =
    (10.691 + 3.0e-7 * dt) * Math.sin(rad(M)) +
    0.623 * Math.sin(rad(2 * M)) +
    0.05 * Math.sin(rad(3 * M)) +
    0.005 * Math.sin(rad(4 * M)) +
    0.0005 * Math.sin(rad(5 * M)) +
    pbs;
  const ls = mod(alphaFMS + nuMinusM, 360); // 태양 황경 = 계절
  const eotDeg = 2.861 * Math.sin(rad(2 * ls)) - 0.071 * Math.sin(rad(4 * ls)) + 0.002 * Math.sin(rad(6 * ls)) - nuMinusM;
  const msd = (dt - 4.5) / 1.0274912517 + 44796.0 - 0.0009626; // 화성 솔 날짜
  const mtc = mod(24 * msd, 24); // 본초 자오선(Airy) 평균시
  const lmst = mod(mtc + lonE / 15, 24); // 지방 평균 태양시
  const ltst = mod(lmst + eotDeg / 15, 24); // 지방 진태양시 (해가 정남/정북에 오면 12시)
  return { msd, ls, mtc, lmst, ltst };
}

// 화성 계절 이름 (Ls 0° = 북반구 춘분). 남반구는 반대
function marsSeason(ls, lat) {
  const north = ["봄", "여름", "가을", "겨울"];
  const south = ["가을", "겨울", "봄", "여름"];
  const i = Math.floor(mod(ls, 360) / 90);
  return lat < 0 ? `남반구 ${south[i]}` : `북반구 ${north[i]}`;
}

function formatClock(hours) {
  const total = Math.floor(mod(hours, 24) * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// ---------- 방사선 ----------
function decimalYear(date) {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  return y + (date.getTime() - start) / (Date.UTC(y + 1, 0, 1) - start);
}

function solarCycleLevel(year) {
  const s = RAD_MODEL.solar;
  return 1 + s.amp * Math.cos((2 * Math.PI * (year - s.minYear)) / s.periodY);
}

// 시간에 따른 계수들 (고도와 무관) — season · diurnal 은 기압 배율, solar · total 은 선량 배율
function radiationFactors(date, lonE) {
  const t = marsTime(date, lonE);
  const L = rad(t.ls);
  const c = RAD_MODEL.season;
  const season = c.c0 + c.c1 * Math.cos(L) + c.s1 * Math.sin(L) + c.c2 * Math.cos(2 * L) + c.s2 * Math.sin(2 * L);
  const d = RAD_MODEL.diurnal;
  const diurnal =
    1 + d.amp1 * Math.cos((2 * Math.PI * (t.ltst - d.peak1H)) / 24) + d.amp2 * Math.cos((4 * Math.PI * (t.ltst - d.peak2H)) / 24);
  const solar = solarCycleLevel(decimalYear(date)) / solarCycleLevel(RAD_MODEL.refYear);
  return { time: t, season, diurnal, solar, total: Math.pow(season * diurnal, -RAD_MODEL.k) * solar };
}

// 시간 계수 1 일 때 고도만으로 정해지는 선량 (mSv/일)
function radiationBase(elevM) {
  const p = RAD_MODEL.p0Pa * Math.exp(-elevM / RAD_MODEL.scaleHeightM);
  return RAD_MODEL.refMsvPerDay * Math.pow(p / RAD_MODEL.refPa, -RAD_MODEL.k);
}

function pressureAt(elevM, factors) {
  return RAD_MODEL.p0Pa * Math.exp(-elevM / RAD_MODEL.scaleHeightM) * factors.season * factors.diurnal;
}

// 시간 계수가 가질 수 있는 범위 (범례의 색 기준을 고정하는 데 사용)
function radiationFactorRange() {
  const c = RAD_MODEL.season;
  let sMin = Infinity, sMax = -Infinity;
  for (let ls = 0; ls < 360; ls++) {
    const L = rad(ls);
    const v = c.c0 + c.c1 * Math.cos(L) + c.s1 * Math.sin(L) + c.c2 * Math.cos(2 * L) + c.s2 * Math.sin(2 * L);
    sMin = Math.min(sMin, v);
    sMax = Math.max(sMax, v);
  }
  const d = RAD_MODEL.diurnal;
  const dAmp = d.amp1 + d.amp2;
  const ref = solarCycleLevel(RAD_MODEL.refYear);
  return {
    min: (Math.pow(sMax * (1 + dAmp), -RAD_MODEL.k) * (1 - RAD_MODEL.solar.amp)) / ref,
    max: (Math.pow(sMin * (1 - dAmp), -RAD_MODEL.k) * (1 + RAD_MODEL.solar.amp)) / ref,
  };
}

// ---------- 시계 상태 ----------
const marsClock = {
  fixed: null, // 사용자가 정한 시각 (null 이면 실제 현재 시각으로 흐름)
  listeners: [],
  now() {
    return this.fixed ? new Date(this.fixed) : new Date();
  },
  isLive() {
    return this.fixed === null;
  },
  set(date) {
    this.fixed = date.getTime();
    this.emit();
  },
  shift(ms) {
    this.set(new Date(this.now().getTime() + ms));
  },
  goLive() {
    this.fixed = null;
    this.emit();
  },
  onChange(fn) {
    this.listeners.push(fn);
  },
  emit() {
    for (const fn of this.listeners) fn();
  },
};

// 시계의 기준 위치: 현위치 (없으면 지역 중심)
function clockLocation() {
  const here = typeof getCurrentPosition === "function" && getCurrentPosition();
  if (here) return here;
  const b = REGIONS.gusev.bounds;
  return { lon: (b.lonMin + b.lonMax) / 2, lat: (b.latMin + b.latMax) / 2 };
}

// 지금 시계 시각 · 현위치의 방사선 (DEM 을 아직 못 읽었으면 dose 는 null)
function currentRadiation() {
  const loc = clockLocation();
  const factors = radiationFactors(marsClock.now(), loc.lon);
  const elev = demElevation(loc.lon, loc.lat);
  return {
    factors,
    elevM: elev ? elev.m : null,
    dose: elev ? radiationBase(elev.m) * factors.total : null,
    pressurePa: elev ? pressureAt(elev.m, factors) : null,
  };
}

// ---------- 오른쪽 위 시계 ----------
const timeBtn = document.getElementById("time-btn");
const timePanel = document.getElementById("time-panel");
const timeInput = document.getElementById("time-input");
const timeEls = {
  mars: document.getElementById("time-mars"),
  season: document.getElementById("time-season"),
  earth: document.getElementById("time-earth"),
  live: document.getElementById("time-live"),
  dose: document.getElementById("time-dose"),
  detail: document.getElementById("time-detail"),
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

// <input type="datetime-local"> 값 (사용자 컴퓨터의 시간대)
function toInputValue(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function percent(f) {
  const p = (f - 1) * 100;
  return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`;
}

function renderClock() {
  const now = marsClock.now();
  const loc = clockLocation();
  const r = currentRadiation();
  const t = r.factors.time;

  timeEls.mars.textContent = formatClock(t.ltst);
  timeEls.season.textContent = `Ls ${t.ls.toFixed(0)}° · ${marsSeason(t.ls, loc.lat)}`;
  timeEls.earth.textContent = `지구 ${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  timeEls.live.textContent = marsClock.isLive() ? "실시간" : "지정 시각";
  timeEls.live.classList.toggle("is-fixed", !marsClock.isLive());

  if (!timePanel.hidden) {
    if (document.activeElement !== timeInput) timeInput.value = toInputValue(now);
    timeEls.dose.textContent = r.dose == null ? "계산 중…" : `${r.dose.toFixed(2)} mSv/일`;
    const f = r.factors;
    timeEls.detail.innerHTML =
      `<li><span>화성 솔 날짜</span><b>MSD ${Math.floor(t.msd).toLocaleString("en-US")}</b></li>` +
      (r.pressurePa == null ? "" : `<li><span>현위치 기압 (추정)</span><b>${Math.round(r.pressurePa)} Pa</b></li>`) +
      `<li><span>계절 기압</span><b>${percent(f.season)}</b></li>` +
      `<li><span>하루 중 기압</span><b>${percent(f.diurnal)}</b></li>` +
      `<li><span>태양 주기 (우주선)</span><b>${percent(f.solar)}</b></li>`;
  }
}

function setTimePanelOpen(open) {
  timePanel.hidden = !open;
  timeBtn.setAttribute("aria-expanded", String(open));
  if (open) renderClock();
}

timeBtn.addEventListener("click", () => setTimePanelOpen(timePanel.hidden));
document.addEventListener("pointerdown", (e) => {
  if (!timePanel.hidden && !e.target.closest("#time-widget")) setTimePanelOpen(false);
});

timeInput.addEventListener("change", () => {
  const d = new Date(timeInput.value);
  if (!Number.isNaN(d.getTime())) marsClock.set(d);
});

// 빠른 이동 버튼: data-shift = "h:-1" (시간) / "sol:1" (솔)
timePanel.querySelectorAll("[data-shift]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const [unit, n] = btn.dataset.shift.split(":");
    marsClock.shift(Number(n) * (unit === "sol" ? MARS_SOL_MS : 3600000));
  });
});
document.getElementById("time-now").addEventListener("click", () => marsClock.goLive());

marsClock.onChange(renderClock);
setInterval(() => {
  if (!marsClock.isLive()) return;
  renderClock();
  // 실시간일 때는 1분마다 방사선 레이어 등도 갱신
  const minute = Math.floor(Date.now() / 60000);
  if (minute !== renderClock.lastMinute) {
    renderClock.lastMinute = minute;
    marsClock.emit();
  }
}, 1000);

renderClock();
// 현위치 방사선 숫자에 필요한 DEM 을 미리 읽어 둠 (file:// 에서는 실패 → 숫자만 "계산 중")
Promise.allSettled(["hirise", "mola"].map(loadDemGrid)).then(renderClock);

// ---------- 태양 위치 · 일몰 · 기온 일주기 ----------
const MARS_OBLIQUITY_DEG = 25.19;
const MARS_HOUR_MS = MARS_SOL_MS / 24; // 화성 1시간 (지구 약 61.6분)

// 태양 고도 · 방위 (°, 방위는 북 0 · 동 90) 와 태양 쪽 단위 벡터 (동, 북, 위)
function sunPosition(date, lonE, latN) {
  const t = marsTime(date, lonE);
  const dec = Math.asin(Math.sin(rad(MARS_OBLIQUITY_DEG)) * Math.sin(rad(t.ls)));
  const H = rad((t.ltst - 12) * 15);
  const phi = rad(latN);
  const up = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
  const east = -Math.cos(dec) * Math.sin(H);
  const north = Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(H);
  return {
    elevationDeg: (Math.asin(Math.max(-1, Math.min(1, up))) * 180) / Math.PI,
    azimuthDeg: mod((Math.atan2(east, north) * 180) / Math.PI, 360),
    east, north, up,
    time: t,
  };
}

// 해 뜨는 시각 · 지는 시각 (지방 진태양시) 과 지금부터 일몰까지 남은 시간 (ms, 밤이면 0)
function sunTimes(date, lonE, latN) {
  const t = marsTime(date, lonE);
  const dec = Math.asin(Math.sin(rad(MARS_OBLIQUITY_DEG)) * Math.sin(rad(t.ls)));
  const c = Math.max(-1, Math.min(1, -Math.tan(rad(latN)) * Math.tan(dec)));
  const half = ((Math.acos(c) * 180) / Math.PI) / 15; // 낮 길이의 절반 (화성 시간)
  const sunrise = 12 - half, sunset = 12 + half;
  const isDay = t.ltst > sunrise && t.ltst < sunset;
  return {
    sunrise, sunset, isDay, ltst: t.ltst,
    msToSunset: isDay ? (sunset - t.ltst) * MARS_HOUR_MS : 0,
    msToSunrise: isDay ? 0 : mod(sunrise - t.ltst, 24) * MARS_HOUR_MS,
  };
}

// 지표 부근 기온 (°C) — Gusev (Spirit Mini-TES · REMS 류 관측의 전형적 일주기에 맞춘 근사)
//  한낮 13:30 쯤 최고, 해 뜨기 직전 최저. 남반구 여름(Ls 250° 부근)에 더 따뜻함
//  그늘은 낮 동안 더 춥고, 모래(열관성 낮음)는 일교차가 큼
function surfaceTempC(date, lonE, latN, { shadow = false, eta = 1.1 } = {}) {
  const t = marsTime(date, lonE);
  const season = Math.cos(rad(t.ls - (latN < 0 ? 250 : 70)));
  const mean = -58 + 12 * season;
  const amp = (36 + 4 * season) * (1 + 0.2 * Math.max(0, eta - 1.1));
  // 해 뜬 뒤(6시) 빨리 데워져 13:30 에 최고, 그 뒤 밤새 천천히 식는 비대칭 일주기
  const wave =
    t.ltst >= 6 && t.ltst < 13.5
      ? -Math.cos((Math.PI * (t.ltst - 6)) / 7.5)
      : 1 - 2 * (1 - Math.pow(1 - mod(t.ltst - 13.5, 24) / 16.5, 2.2));
  const dayness = Math.max(0, Math.cos(rad((t.ltst - 12) * 15)));
  return mean + amp * Math.max(-1, Math.min(1, wave)) - (shadow ? 14 * dayness : 0);
}
