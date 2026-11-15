// Mars Mother — 처음 들어왔을 때 보여 주는 짧은 사용법 안내
//  화면의 주요 버튼을 하나씩 밝게 비추고 옆에 설명 카드를 띄움 (다음 / 이전 / 건너뛰기)
//  들어올 때마다 (새로고침 포함) 뜸. HUD 모드 · 왼쪽 메뉴도 처음 들어가거나 열 때 각각 한 번씩 안내 메뉴 위의 ? 버튼으로도 다시 볼 수 있음
//  주소 뒤에 ?tour=off 를 붙이면 안 뜸 (시연 · 테스트용)

(() => {
  // target: 비출 요소 (없으면 화면 가운데 카드)
  const STEPS = [
    {
      title: "Mars Mother",
      text: "화성 탐사 대원을 위한 지도. 주요 기능 30초 안내.",
      logo: true,
      intro: true,
    },
    {
      title: "지도",
      text: "드래그로 이동 · 휠로 확대/축소. 아무 곳이나 클릭하면 그 지점의 고도 · 경사 · 방사선 정보 표시.",
    },
    {
      target: "#menu-btn",
      title: "메뉴",
      text: "길찾기 · 레이어 · 포인트 · 나의 정보. 출발지와 도착지를 정하면 안전한 길 · 최단 거리 · 에너지 절약 경로 계산.",
    },
    {
      target: "#time-widget",
      title: "화성 시각",
      text: "현재 화성 지방시와 계절. 누르면 시각 변경 가능 → 방사선 · 그늘 · 기온 추정에 반영.",
    },
    {
      target: "#hud-window",
      title: "HUD 모드",
      text: "누르면 1인칭 화면으로 전환. 실제 지형 위에 경로 · 위험 구역 · 산소 상태 표시. W A S D 로 이동.",
    },
    {
      target: ".map-controls",
      title: "보기 전환",
      text: "위에서부터 HUD 창 켜기/끄기 · 2D/3D 지도 전환 · 주변 지형으로 내 위치 찾기 (화성에는 GPS 없음).",
    },
    {
      target: ".here-dot",
      pad: 64,
      title: "기지 설치",
      text: "기지는 통신과 귀환의 기준점. 아래 버튼을 누르면 내 위치 근처에 기지 설치 → 귀환 여유 · 통신 상태 계산에 사용.",
      action: {
        label: "내 주변에 기지 설치",
        done: "기지 설치됨",
        isDone: () => typeof getBases === "function" && getBases().length > 0,
        run: () => typeof addBaseNearMe === "function" && addBaseNearMe(),
      },
    },
  ];

  // HUD 모드에 처음 들어갔을 때 (들어올 때마다 한 번)
  const HUD_STEPS = [
    {
      title: "HUD 모드",
      text: "실제 지형을 1인칭으로 보는 화면. W A S D 이동 · Shift 달리기 · 드래그 또는 방향키로 둘러보기.",
      intro: true,
    },
    {
      title: "바닥의 색 점",
      text: "지형 위에 찍힌 점의 색이 위험 정도. 파랑 = 안전 · 노랑 = 주의 · 빨강 = 위험. 경사 · 모래 · 거친 지면 · 그늘을 합쳐 계산.",
    },
    {
      target: [".hud-compass__tape", ".hud-compass__center", "#hud-ahead"],
      title: "방위 · 전방 상태",
      text: "바라보는 방향과 포인트가 있는 방위. 아래 알약은 전방 25 m 지형의 안전 · 주의 · 위험.",
    },
    {
      target: "#hud-terrain",
      title: "발밑 지형",
      text: "지금 서 있는 곳의 고도 · 경사 · 모래 빠짐 위험 · 기지와의 통신 상태.",
    },
    {
      target: "#hud-vitals",
      title: "생체 · 장비 상태",
      text: "산소 잔량 · 방사선 누적 · 피로도 · 기지까지 귀환 여유. 냉각수나 전력이 부족하면 경고 링 추가.",
    },
    {
      target: "#hud-locate-btn",
      title: "내 위치 찾기",
      text: "GPS 없이 주변 지형을 위성 사진과 비교해 현재 위치 보정.",
    },
    {
      target: "#hud-window",
      title: "2D 지도",
      text: "미니맵. 누르면 2D 지도로 복귀. 왼쪽 위 메뉴를 열어도 2D 지도로 전환.",
    },
  ];

  // "걸으면 길이 고쳐짐" 그림: 옛 지도로 짠 길(회색 점선)이 새로 확인한 장애물(빨강)에 막혀, 돌아가는 길(파랑)로 바뀜
  const REPLAN_ART = `
    <svg viewBox="0 0 280 120" role="img" aria-label="걸으며 확인한 장애물을 피해 길을 다시 계산하는 그림">
      <rect width="280" height="120" rx="12" fill="#2b211b" />
      <path d="M-10 92 C 50 70, 110 104, 170 84 S 250 70, 300 88" fill="none" stroke="#3a2d25" stroke-width="2" />
      <path d="M-10 34 C 60 18, 120 44, 190 26 S 260 22, 300 30" fill="none" stroke="#3a2d25" stroke-width="2" />
      <!-- 내가 직접 확인한 범위 -->
      <circle cx="96" cy="66" r="44" fill="rgba(61,220,151,0.13)" stroke="rgba(61,220,151,0.7)" stroke-width="1.2" stroke-dasharray="3 3" />
      <!-- 옛 지도로 짠 길 -->
      <path d="M26 66 L 246 66" fill="none" stroke="#a8a29e" stroke-width="2.5" stroke-dasharray="6 5" stroke-linecap="round" />
      <!-- 새로 확인한 장애물 -->
      <circle cx="128" cy="66" r="13" fill="rgba(255,90,82,0.28)" stroke="#ff5a52" stroke-width="2" />
      <path d="M123 61 l10 10 M133 61 l-10 10" stroke="#ff5a52" stroke-width="2.2" stroke-linecap="round" />
      <!-- 다시 계산한 길 -->
      <path d="M96 66 C 104 30, 150 26, 172 44 S 214 66, 246 66" fill="none" stroke="#4c8dff" stroke-width="3.5" stroke-linecap="round" />
      <path d="M26 66 L 96 66" fill="none" stroke="#4c8dff" stroke-width="3.5" stroke-linecap="round" />
      <!-- 출발 · 나 · 도착 -->
      <circle cx="26" cy="66" r="5" fill="#ff5a5a" stroke="#0b0b0d" stroke-width="1.5" />
      <circle cx="96" cy="66" r="6.5" fill="#2f6bff" stroke="#fff" stroke-width="2.5" />
      <circle cx="246" cy="66" r="5" fill="#b38cff" stroke="#0b0b0d" stroke-width="1.5" />
    </svg>
    <ul class="tour__legend">
      <li><i style="background:#a8a29e"></i>옛 지도로 짠 길</li>
      <li><i style="background:#3ddc97"></i>걸으며 확인한 범위</li>
      <li><i style="background:#ff5a52"></i>새로 발견한 장애물</li>
      <li><i style="background:#4c8dff"></i>다시 계산한 길</li>
    </ul>`;

  // 왼쪽 메뉴를 처음 열었을 때: 탭을 하나씩 넘겨 가며 설명 (끝나면 보던 탭으로 되돌림)
  const openTab = (id) => () => document.getElementById(id)?.click();
  const DRAWER_STEPS = [
    {
      target: ".drawer__tabs",
      title: "메뉴",
      text: "길찾기 · 레이어 · 포인트 · 나의 정보 네 가지 탭.",
    },
    {
      before: openTab("tab-route"),
      target: "#panel-route",
      title: "길찾기",
      text: "출발지 · 도착지를 입력하거나 핀 아이콘으로 지도에서 선택. 길 찾기를 누르면 경로 3가지 비교 → 안내 시작.",
    },
    {
      before: openTab("tab-route"),
      target: "#panel-route",
      title: "걸으면 길이 고쳐짐",
      text: "지도는 오래전 궤도에서 찍은 것이라 지금 지형과 다를 수 있음. 걸으면 주변 10 m 를 직접 확인하고, 지도와 다르면 남은 길을 바로 다시 계산.",
      art: REPLAN_ART,
    },
    {
      before: openTab("tab-layer"),
      target: "#panel-layer",
      title: "레이어",
      text: "지도 위에 겹쳐 보는 데이터 (고도 · 열관성 · 물의 흔적 · 위험 요소). 스위치로 켜고 끄기 · 묶음 제목을 누르면 접기.",
    },
    {
      before: openTab("tab-point"),
      target: "#panel-point",
      title: "포인트",
      text: "탐사 지점 목록. 누르면 지도에서 위치 표시 · 사진 보기. 아래 버튼으로 새 포인트 추가.",
    },
    {
      before: openTab("tab-me"),
      target: "#panel-me",
      title: "나의 정보",
      text: "몸무게 · 걷기 속도 · 산소 탱크 등. 경로 계산과 HUD 상태에 그대로 반영.",
    },
  ];

  let steps = STEPS; // 지금 보여 주는 묶음
  let restoreTabId = null; // 메뉴 안내가 끝나면 되돌릴 탭
  let root = null; // 안내가 떠 있는 동안만 존재
  let index = 0;

  // 화면에 실제로 보이는 요소만 비춤 (닫아 둔 HUD 창 등은 가운데 카드로 대신)
  //  target 이 배열이면 보이는 것들을 한꺼번에 감싸는 영역
  function visibleRect(target) {
    let box = null;
    for (const selector of [].concat(target || [])) {
      const el = document.querySelector(selector);
      if (!el || el.hidden) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      box = box
        ? { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    return box && { ...box, width: box.right - box.left, height: box.bottom - box.top };
  }

  function build() {
    root = document.createElement("div");
    root.className = "tour";
    root.innerHTML = `
      <div class="tour__spot" aria-hidden="true"></div>
      <section class="tour__card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <img class="tour__logo" src="assets/brand/logo-mark.png" alt="" />
        <div class="tour__art" hidden></div>
        <span class="tour__count"></span>
        <h2 id="tour-title" class="tour__title"></h2>
        <p class="tour__text"></p>
        <button type="button" class="tour__action" hidden></button>
        <div class="tour__actions">
          <button type="button" class="tour__skip">건너뛰기</button>
          <button type="button" class="tour__prev">이전</button>
          <button type="button" class="tour__next"></button>
        </div>
      </section>`;
    root.querySelector(".tour__action").addEventListener("click", () => {
      const action = steps[index].action;
      if (!action) return;
      action.run();
      showAction(action);
    });
    root.querySelector(".tour__skip").addEventListener("click", finish);
    root.querySelector(".tour__prev").addEventListener("click", () => go(index - 1));
    root.querySelector(".tour__next").addEventListener("click", () => go(index + 1));
    document.body.append(root);
    window.addEventListener("resize", place);
    window.addEventListener("keydown", onKey, true);
  }

  // 단계 안에서 직접 해 보는 버튼 (예: 기지 설치). 이미 했으면 "…됨" 으로 바뀌고 다시 못 누름
  function showAction(action) {
    const btn = root.querySelector(".tour__action");
    btn.hidden = !action;
    if (!action) return;
    const done = action.isDone();
    btn.disabled = done;
    btn.classList.toggle("is-done", done);
    btn.textContent = done ? `✓ ${action.done}` : action.label;
  }

  function onKey(e) {
    if (!root) return;
    // 안내 창의 버튼(건너뛰기 · 이전 · 기지 설치 등)에 초점이 있으면 Enter/Space 는 그 버튼을 누름
    if ((e.key === "Enter" || e.key === " ") && e.target.closest?.("button") && root.contains(e.target)) {
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape") finish();
    else if (e.key === "ArrowRight" || e.key === "Enter") go(index + 1);
    else if (e.key === "ArrowLeft") go(index - 1);
    else if (e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation(); // 안내 중에는 뒤의 지도 · HUD 가 키에 반응하지 않게 (W A S D 로 걸어가 버리지 않게)
  }

  function go(next) {
    if (next < 0) return;
    if (next >= steps.length) return finish();
    index = next;
    const step = steps[index];
    const last = index === steps.length - 1;
    root.querySelector(".tour__logo").hidden = !step.logo;
    const art = root.querySelector(".tour__art");
    art.hidden = !step.art;
    art.innerHTML = step.art || "";
    if (step.before) step.before();
    const skipIntro = steps[0].intro ? 1 : 0;
    root.querySelector(".tour__count").textContent = step.intro ? "" : `${index + 1 - skipIntro} / ${steps.length - skipIntro}`;
    root.querySelector(".tour__title").textContent = step.title;
    root.querySelector(".tour__text").textContent = step.text;
    showAction(step.action);
    root.querySelector(".tour__prev").hidden = index === 0;
    root.querySelector(".tour__skip").hidden = last;
    const nextBtn = root.querySelector(".tour__next");
    nextBtn.textContent = step.intro ? "둘러보기" : last ? (steps === STEPS ? "시작하기" : "완료") : "다음";
    place();
    setTimeout(place, 380); // 메뉴가 밀려 나오는 중이었거나 탭 내용이 늦게 바뀐 경우 한 번 더 맞춤
    nextBtn.focus({ preventScroll: true });
  }

  // 비출 자리와 설명 카드 위치 (화면 크기가 바뀌면 다시 계산)
  function place() {
    if (!root) return;
    const spot = root.querySelector(".tour__spot");
    const card = root.querySelector(".tour__card");
    const rect = visibleRect(steps[index].target);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const GAP = 14;
    const EDGE = 12;
    root.classList.toggle("is-centered", !rect);
    if (!rect) {
      spot.style.cssText = `left:${vw / 2}px;top:${vh / 2}px;width:0;height:0;`;
      card.style.left = "";
      card.style.top = "";
      return;
    }
    const PAD = steps[index].pad ?? 6;
    spot.style.cssText = `left:${rect.left - PAD}px;top:${rect.top - PAD}px;width:${rect.width + PAD * 2}px;height:${rect.height + PAD * 2}px;`;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    // 가로: 대상이 왼쪽에 있으면 왼쪽 끝을, 오른쪽에 있으면 오른쪽 끝을 맞춤
    let left = rect.left + rect.width / 2 < vw / 2 ? rect.left - PAD : rect.right + PAD - cw;
    left = Math.max(EDGE, Math.min(left, vw - cw - EDGE));
    // 세로: 대상이 위쪽에 있으면 아래에, 아래쪽에 있으면 위에
    let top = rect.top + rect.height / 2 < vh / 2 ? rect.bottom + PAD + GAP : rect.top - PAD - GAP - ch;
    // 세로로 긴 대상 (메뉴 패널): 위아래에 자리가 없으니 옆에. 옆도 좁으면 (모바일) 대상 아래쪽에 겹쳐서
    if (rect.height > vh * 0.5) {
      const roomRight = vw - rect.right - PAD - GAP - EDGE;
      if (roomRight >= cw) {
        left = rect.right + PAD + GAP;
        top = rect.top;
      } else {
        left = rect.left;
        top = vh - ch - EDGE - 8;
      }
    }
    left = Math.max(EDGE, Math.min(left, vw - cw - EDGE));
    top = Math.max(EDGE, Math.min(top, vh - ch - EDGE));
    // 그래도 카드가 비추는 곳을 가리면 (그림이 든 큰 카드 등) 오른쪽 옆으로 비킴
    const covers = left < rect.right && left + cw > rect.left && top < rect.bottom && top + ch > rect.top;
    if (covers && vw - rect.right - PAD - GAP - EDGE >= cw) {
      left = rect.right + PAD + GAP;
      top = Math.max(EDGE, Math.min(rect.top, vh - ch - EDGE));
    }
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function finish() {
    if (!root) return;
    window.removeEventListener("resize", place);
    window.removeEventListener("keydown", onKey, true);
    root.remove();
    root = null;
    if (restoreTabId) document.getElementById(restoreTabId)?.click();
    restoreTabId = null;
  }

  function startTutorial(which) {
    if (root) return;
    const inHud = document.body.classList.contains("is-hud");
    steps = which === "drawer" ? DRAWER_STEPS : which === "hud" || (which == null && inHud) ? HUD_STEPS : STEPS;
    if (steps === DRAWER_STEPS) restoreTabId = document.querySelector('.drawer__tab[aria-selected="true"]')?.id || null;
    // 기본 안내는 2D 지도 기준 → 메뉴가 열려 있으면 닫고 시작
    if (steps === STEPS && typeof setDrawerOpen === "function") setDrawerOpen(false);
    build();
    go(0);
  }
  window.startTutorial = startTutorial;

  const helpBtn = document.getElementById("tutorial-btn");
  if (helpBtn) helpBtn.addEventListener("click", () => startTutorial("map"));

  // HUD 모드에 처음 들어가면 HUD 안내 (메뉴를 열었다 닫아 HUD 로 돌아올 때는 다시 안 뜸)
  //  왼쪽 메뉴를 처음 열면 메뉴 안내
  let hudTourShown = false;
  let drawerTourShown = false;
  const off = new URLSearchParams(location.search).get("tour") === "off";
  if (!off) {
    new MutationObserver(() => {
      if (!drawerTourShown && !root && document.body.classList.contains("is-drawer-open")) {
        drawerTourShown = true;
        setTimeout(() => {
          if (document.body.classList.contains("is-drawer-open")) startTutorial("drawer");
        }, 450); // 메뉴가 다 밀려 나온 뒤에
        return;
      }
      if (hudTourShown || !document.body.classList.contains("is-hud")) return;
      hudTourShown = true;
      setTimeout(() => {
        if (document.body.classList.contains("is-hud")) startTutorial("hud");
      }, 900); // 화면 전환 · 지형 불러오기가 자리 잡은 뒤에
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  if (!off) window.addEventListener("load", () => setTimeout(() => startTutorial("map"), 600));
})();
