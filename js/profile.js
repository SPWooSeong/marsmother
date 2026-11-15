// Mars Mother — 나의 정보: 대원마다 다른 한계 · 장비 값 (브라우저에 저장)
// 길찾기(경사 한계 · 산소 · EVA 시간 · 안전 여유), HUD(산소 탱크 · 피로도 · 경사 경고), 귀환 한계 레이어가 같이 씀
// 값이 바뀌면 "profilechange" 이벤트를 보냄. 필요: eva.js (EVA)

const PROFILE_KEY = "marsmother.profile";
const ABSOLUTE_SLOPE_DEG = 30; // 절대 장애물: 누구도 걸어서 못 넘는 비탈 (설정과 무관)

// 기본 이름은 언어에 맞춤 (js/i18n.js): 영어 "Crew 1" · 한국어 "대원 1"
const PROFILE_NAME_DEFAULTS = { ko: "대원 1", en: "Crew 1" };
function defaultProfileName() {
  return PROFILE_NAME_DEFAULTS[typeof getLanguage === "function" ? getLanguage() : "ko"] || PROFILE_NAME_DEFAULTS.ko;
}

const PROFILE_FIELDS = [
  { id: "name", label: "이름", type: "text", def: defaultProfileName() },
  { id: "bodyKg", label: "몸무게", unit: "kg", min: 40, max: 130, step: 1, def: 75, hint: "걷는 데 드는 에너지(Pandolf 식)에 반영" },
  { id: "walkKmh", label: "걷기 속도 (평지)", unit: "km/h", min: 1.5, max: 100, step: 0.1, def: 3.6, hint: "우주복을 입고 평지를 걷는 속도. 경사 · 모래에서는 여기서 더 느려짐 (Apollo 평균 ≈ 3.6 km/h · 시연용으로 100 까지)" },
  { id: "slopeLimitDeg", label: "경사 한계", unit: "°", min: 5, max: ABSOLUTE_SLOPE_DEG, step: 1, def: 15, hint: `이보다 가파른 곳은 경로에서 제외 (${ABSOLUTE_SLOPE_DEG}° 이상은 누구나 통행 불가)` },
  { id: "o2TankL", label: "산소 탱크", unit: "L", min: 100, max: 1200, step: 10, def: 460, hint: "우주복 주 산소량 (Apollo PLSS ≈ 460 L)" },
  { id: "evaMaxHours", label: "EVA 최대 시간", unit: "시간", min: 1, max: 12, step: 0.5, def: 8, hint: "한 번의 선외활동 한도" },
  { id: "marginPct", label: "안전 여유", unit: "%", min: 0, max: 50, step: 5, def: 20, hint: "산소 · 시간 · 경사를 이만큼 남겨 둠. '안전한 길' 은 경사 한계에도 적용" },
  { id: "fitnessKcal", label: "하루 체력 예산", unit: "kcal", min: 800, max: 5000, step: 100, def: 2065, hint: "피로도 100% 기준 (8시간 × 300 W ≈ 2,065 kcal)" },
  { id: "radLimitUSv", label: "EVA 방사선 한도", unit: "μSv", min: 50, max: 2000, step: 50, def: 300, hint: "한 번의 EVA 에서 받아도 되는 양 (경고 기준)" },
];

const PROFILE = (() => {
  const p = Object.fromEntries(PROFILE_FIELDS.map((f) => [f.id, f.def]));
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_KEY)) || {};
    for (const f of PROFILE_FIELDS) {
      if (!(f.id in saved)) continue;
      if (f.type === "text") p[f.id] = String(saved[f.id]).slice(0, 30);
      else if (Number.isFinite(+saved[f.id])) p[f.id] = Math.max(f.min, Math.min(f.max, +saved[f.id]));
    }
  } catch {
    // 저장된 값이 없거나 깨졌으면 기본값
  }
  return p;
})();

// 안전 여유를 뺀 실제로 쓸 수 있는 양
const profileMargin = () => PROFILE.marginPct / 100;
const profileUsableO2L = () => PROFILE.o2TankL * (1 - profileMargin());
const profileUsableHours = () => PROFILE.evaMaxHours * (1 - profileMargin());

function applyProfile() {
  EVA.bodyKg = PROFILE.bodyKg;
  EVA.flatSpeedMps = PROFILE.walkKmh / 3.6;
  EVA.o2TankL = PROFILE.o2TankL;
  EVA.slopeLimitDeg = PROFILE.slopeLimitDeg;
  EVA.dailyEnergyKj = PROFILE.fitnessKcal * 4.184;
}
applyProfile();

function saveProfile() {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(PROFILE));
  } catch {
    // 저장 실패 시 이번 접속 동안만 유지
  }
  applyProfile();
  document.dispatchEvent(new CustomEvent("profilechange"));
}

// ---------- 나의 정보 탭 ----------
function renderProfilePanel() {
  const panel = document.getElementById("panel-me");
  if (!panel) return;
  panel.replaceChildren();
  const form = document.createElement("form");
  form.className = "profile-form";
  form.addEventListener("submit", (e) => e.preventDefault());

  const summary = document.createElement("p");
  summary.className = "profile-summary";
  const updateSummary = () => {
    summary.textContent =
      `쓸 수 있는 산소 ${Math.round(profileUsableO2L())} L · 활동 시간 ${profileUsableHours().toFixed(1)} 시간 ` +
      `(여유 ${PROFILE.marginPct}% 제외) · 안전한 길 경사 ${(PROFILE.slopeLimitDeg * (1 - profileMargin())).toFixed(1)}° 까지`;
  };

  for (const f of PROFILE_FIELDS) {
    const row = document.createElement("label");
    row.className = "profile-field";
    const name = document.createElement("span");
    name.className = "profile-field__label";
    name.textContent = f.label;
    const input = document.createElement("input");
    input.className = "profile-field__input";
    if (f.type === "text") {
      input.type = "text";
      input.maxLength = 30;
    } else {
      input.type = "number";
      input.min = f.min;
      input.max = f.max;
      input.step = f.step;
      input.inputMode = "decimal";
    }
    input.value = PROFILE[f.id];
    input.addEventListener("change", () => {
      if (f.type === "text") PROFILE[f.id] = input.value.trim() || f.def;
      else {
        const v = parseFloat(input.value);
        PROFILE[f.id] = Number.isFinite(v) ? Math.max(f.min, Math.min(f.max, v)) : f.def;
      }
      input.value = PROFILE[f.id];
      saveProfile();
      updateSummary();
    });
    const unit = document.createElement("span");
    unit.className = "profile-field__unit";
    unit.textContent = f.unit || "";
    row.append(name, input, unit);
    if (f.hint) {
      const hint = document.createElement("span");
      hint.className = "profile-field__hint";
      hint.textContent = f.hint;
      row.append(hint);
    }
    form.append(row);
  }

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "route-btn";
  reset.textContent = "기본값으로";
  reset.addEventListener("click", () => {
    for (const f of PROFILE_FIELDS) PROFILE[f.id] = f.def;
    saveProfile();
    renderProfilePanel();
  });

  updateSummary();
  panel.append(form, summary, reset);
}
renderProfilePanel();

// 언어를 바꾸면 기본 이름도 그 언어로 (직접 지은 이름은 그대로 둠)
document.addEventListener("languagechange", () => {
  const field = PROFILE_FIELDS.find((f) => f.id === "name");
  field.def = defaultProfileName();
  if (!Object.values(PROFILE_NAME_DEFAULTS).includes(PROFILE.name)) return;
  PROFILE.name = field.def;
  // 이름만 바뀐 것이라 "나의 정보 변경됨" 알림(경로 다시 계산 안내)은 보내지 않음
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(PROFILE));
  } catch {
    // 저장 실패 시 이번 접속 동안만 유지
  }
  renderProfilePanel();
});
