// Mars Mother — 언어 전환 (한국어 ↔ English)
//  화면의 한국어 글자를 영어로 바꿔 보여 주는 층. 다른 스크립트는 그대로 한국어로 쓰고,
//  여기서 화면에 나온 글자(텍스트 · title · aria-label · placeholder · alt)를 지켜보다가 영어로 바꿈
//   - EXACT     문장 그대로 일치하는 번역
//   - PATTERNS  숫자 · 이름이 끼어 있는 문장 (정규식)
//   - " · " 로 이어 붙인 글은 조각마다 따로 번역
//   - BLOCKS    굵은 글씨 등이 섞여 한 문장이 여러 조각으로 나뉜 곳은 통째로
//  번역이 없는 글(사용자가 입력한 포인트 이름 등)은 그대로 둠
//  기본은 영어. 메뉴 위 EN / 한 버튼으로 전환 · 고른 언어는 브라우저에 기억 · 주소에 ?lang=ko / ?lang=en 가능

(() => {
  const LANG_KEY = "mm.lang";
  const HANGUL = /[가-힣ㄱ-ㅎ]/;

  // ---------- 1) 그대로 일치 ----------
  const EXACT = {
    // 공통
    "닫기": "Close",
    "취소": "Cancel",
    "추가": "Add",
    "삭제": "Delete",
    "계산 중": "Calculating",
    "불러오는 중": "Loading",
    "낮음": "Low",
    "보통": "Medium",
    "중간": "Medium",
    "높음": "High",
    "안전": "Safe",
    "주의": "Caution",
    "위험": "Danger",
    "현위치": "Current position",
    "출발지": "Start",
    "도착지": "Destination",
    "출발": "Start",
    "도착": "End",
    "출": "S",
    "도": "D",
    "기지 없음": "No base",
    "기지": "Base",
    "동굴": "Cave",
    "고도": "Elevation",
    "경사": "Slope",
    "기온": "Temperature",
    "방사선": "Radiation",
    "냉각수": "Coolant",
    "배터리": "Battery",
    "전력": "Power",
    "모래": "Sand",
    "먼지": "Dust",
    "암반": "Bedrock",
    "밤": "night",
    "그늘": "shade",
    "가능": "Available",
    "추정": "estimated",
    "경로": "Path",

    // 지도 화면
    "Gusev · Columbia Hills 지도": "Gusev · Columbia Hills map",
    "3D 지도": "3D map",
    "화성 3D 지형 불러오는 중": "Loading Mars 3D terrain",
    "드래그 회전 · 휠 확대/축소 · Ctrl+드래그 기울이기": "Drag to rotate · Scroll to zoom · Ctrl+drag to tilt",
    "HUD 모드": "HUD mode",
    "실제 지형(DEM · 궤도 사진) 불러오는 중": "Loading real terrain (DEM · orbital imagery)",
    "방위": "Heading",
    "지형 데이터 불러오는 중": "Loading terrain data",
    "이동": "Move",
    "달리기": "Run",
    "드래그 /": "Drag /",
    "둘러보기": "Look around",
    "GPS 없이 주변 지형 사진으로 내 위치 찾기": "Find my position from the surrounding terrain, without GPS",
    "내 위치 찾기": "Find my position",
    "상태": "Status",
    "지도에서 추가할 위치 클릭": "Click the map to place the point",
    "축척": "Scale",
    "메뉴 열기": "Open menu",
    "메뉴": "Menu",
    "메뉴 닫기": "Close menu",
    "사용법 다시 보기": "Show the tutorial again",
    "길찾기": "Route",
    "레이어": "Layers",
    "포인트": "Points",
    "나의 정보": "Profile",
    "경유지 추가": "Add stop",
    "출발지와 도착지 바꾸기": "Swap start and destination",
    "바꾸기": "Swap",
    "초기화": "Reset",
    "길 찾기": "Find route",
    "HUD 창": "HUD window",
    "HUD 창 닫기": "Close HUD window",
    "HUD 모드로 전환": "Switch to HUD mode",
    "HUD 창 켜기/끄기": "Show/hide HUD window",
    "3D 지도로 전환": "Switch to 3D map",
    "2D 지도로 전환": "Switch to 2D map",
    "2D 지도": "2D map",
    "2D 지도로 돌아가기": "Back to 2D map",
    "HUD 로 돌아가기": "Back to HUD",
    "2D 지도 닫고 HUD 로 돌아가기": "Close 2D map and return to HUD",
    "닫고 HUD 로 돌아가기": "Close and return to HUD",
    "3D 화성 지형 불러오기 실패 · 인터넷 연결과 Cesium 토큰 확인 필요": "Failed to load Mars 3D terrain · Check the internet connection and Cesium token",
    "이 지역은 아직 지도·포인트 데이터 없음": "No map or point data for this region yet",
    "이 지역은 아직 지도 데이터 없음": "No map data for this region yet",

    // 레이어
    "기본 지도": "Base map",
    "위성 사진": "Satellite imagery",
    "고도 (DEM)": "Elevation (DEM)",
    "MOLA DEM (광역)": "MOLA DEM (wide area)",
    "HiRISE DEM (고해상도)": "HiRISE DEM (high-res)",
    "히트맵": "Heatmap",
    "탐사 기록": "Survey log",
    "탐사된 구역": "Surveyed area",
    "컬러/흑백": "Color/B&W",
    "열관성 · 지표 (MGS TES)": "Thermal inertia · Surface (MGS TES)",
    "TES 열관성": "TES thermal inertia",
    "표면 물질 구분": "Surface material units",
    "노출 암반 후보": "Exposed bedrock candidates",
    "열관성 등치선": "Thermal inertia contours",
    "물의 흔적 (JMARS)": "Traces of water (JMARS)",
    "지질 시대": "Geologic age",
    "옛 계곡망": "Ancient valley networks",
    "호수 · 삼각주": "Lakes · Deltas",
    "Aqueous mineral 분포": "Aqueous mineral distribution",
    "위험 요소": "Hazards",
    "위험도 (HUD 와 같은 기준)": "Hazard level (same as HUD)",
    "모래 빠질 위험 있는 곳": "Sand trap risk areas",
    "방사선 위험 (추정)": "Radiation risk (estimated)",
    "귀환 한계 (산소 · 시간)": "Return limit (oxygen · time)",
    "통신 가시 범위 (기지)": "Comm line of sight (base)",
    "과학 레이어 범위: Gusev 주변 400 km · 지도를 축소하면 전체 표시": "Science layer coverage: 400 km around Gusev · Zoom out to see all of it",
    "노아키안 (41~37억 년 전)": "Noachian (4.1–3.7 Ga)",
    "헤스페리안 (37~30억 년 전)": "Hesperian (3.7–3.0 Ga)",
    "아마조니안 (30억 년 전~)": "Amazonian (3.0 Ga–present)",
    "열린 분지 호수": "Open-basin lake",
    "닫힌 분지 호수": "Closed-basin lake",
    "삼각주": "Delta",
    "계곡 (2005 목록)": "Valleys (2005 catalog)",
    "층상규산염 (점토)": "Phyllosilicate (clay)",
    "황산염": "Sulfate",
    "탄산염": "Carbonate",
    "함수 광물 (CRISM · OMEGA)": "Hydrous minerals (CRISM · OMEGA)",
    "함수 광물": "Hydrous mineral",
    "수성 광물": "Aqueous mineral",
    "USGS 화성 지질도(SIM 3292). 노아키안 = 물이 가장 많던 시대": "USGS Mars geologic map (SIM 3292). Noachian = the wettest era",
    "열관성만으로 추정 — 굳은 표면 아래 무른 층은 잡히지 않음": "Estimated from thermal inertia only — soft layers under a hard crust are not detected",
    "노출 암반 · 고결층 후보": "Exposed bedrock · indurated layer candidates",
    "주변(약 45 km)보다 열관성이 뚜렷이 높은 곳": "Thermal inertia clearly higher than the surroundings (~45 km)",
    "100 tiu 단위": "Every 100 tiu",
    "50 tiu 단위": "Every 50 tiu",
    "옛 강이 파낸 계곡 (굵을수록 큰 줄기)": "Valleys carved by ancient rivers (thicker = larger channel)",
    "물이 있어야 생기는 광물이 궤도에서 검출된 곳": "Where minerals that need water to form were detected from orbit",
    "고도 색 기준": "Elevation color range",
    "전체 범위": "Full range",
    "현재 화면": "Current view",
    "MOLA 400 km 전체 기준 색. MOLA 400 m 격자 · HiRISE 30 m 격자 (현위치 주변 3 km 는 2 m) + 음영기복":
      "Colors scaled to the full 400 km MOLA area. MOLA 400 m grid · HiRISE 30 m grid (2 m within 3 km of you) + hillshade",
    "계산 중… (기준점에서 다녀오는 데 드는 산소 · 시간)": "Calculating… (oxygen · time for a round trip from the reference point)",
    "기준점이 Columbia Hills 지도 밖": "Reference point is outside the Columbia Hills map",
    "여유 (예산의 50% 이내)": "Comfortable (within 50% of budget)",
    "주의 (50~80%)": "Caution (50–80%)",
    "한계 근처 (80~100%)": "Near the limit (80–100%)",
    "귀환 불가 — 이 선을 넘으면 돌아오기 어려움": "No return — hard to get back past this line",
    "주의 — 경사 · 무른 모래 · 거친 지면 · 그늘": "Caution — slope · soft sand · rough ground · shade",
    "위험 — 급경사 · 모래 함몰 · 바위 많음": "Danger — steep slope · sand trap · rocky",
    "HUD 위험 표시와 같은 기준 (경사 한계는 나의 정보 값)": "Same criteria as the HUD hazard display (slope limit from Profile)",
    "30 m 칸 단위": "30 m cells",
    "안전한 곳은 투명": "safe areas are transparent",
    "지금은 밤이라 그늘은 빼고 계산": "it is night, so shade is excluded",
    "기지와 직선 통신 가능": "Line-of-sight comm with base",
    "통신 음영 (지형에 가림)": "Comm shadow (blocked by terrain)",
    "포인트 탭 → 포인트 추가 → 종류 '기지' 로 추가": "Points tab → Add point → choose type 'Base'",
    "탐사 지형": "Surveyed terrain",
    "걸은 거리": "Distance walked",
    "밝힌 면적": "Area revealed",
    "평균 고도 차": "Mean elevation diff.",
    "최대 고도 차": "Max elevation diff.",
    "탐사 기록 지우기": "Clear survey log",
    "MGS TES (원본 약 7 km 해상도, 값은 ±15% 근사)": "MGS TES (native ~7 km resolution, values approximate to ±15%)",
    "은하 우주선 추정 선량. 고도(대기 두께) + 오른쪽 위 시계의 시각(계절 · 하루 중 기압, 태양 주기)으로 계산. MSL RAD 관측에 맞춘 근사 — 태양 폭풍 · 지형 차폐는 미반영":
      "Estimated galactic cosmic ray dose. Computed from elevation (atmosphere thickness) + the clock time at top right (seasonal · daily pressure, solar cycle). Approximation fitted to MSL RAD data — solar storms · terrain shielding not included",
    "새 충돌구": "New impact crater",
    "낙석 · 바위 지대": "Rockfall · boulder field",
    "새 모래 퇴적": "New sand deposit",
    "사면 붕괴": "Slope collapse",
    // 표면 물질 (data/layers.js)
    "먼지 피복 지대": "Dust-mantled terrain",
    "모래·세립 퇴적층": "Sand · fine sediment",
    "조립 퇴적물·고결 토양(듀리크러스트)": "Coarse sediment · indurated soil (duricrust)",
    "암석 풍부·암반 노출": "Rock-rich · exposed bedrock",
    "노출 암반·고결층 후보": "Exposed bedrock · indurated layer candidate",
    "미세 먼지(수~수십 µm)가 덮은 지역. 낮에 빨리 달궈지고 밤에 빨리 식음. 광물 분광 신호가 가려져 물 흔적 탐지 신뢰도 낮음. 장비·우주복 먼지 오염 주의.":
      "Area mantled by fine dust (a few to tens of µm). Heats quickly by day and cools quickly at night. Mineral spectral signals are masked, so water-trace detection is unreliable. Watch for dust contamination of equipment and suits.",
    "모래~세립 퇴적물과 먼지 혼합. 사구·바람자국 가능. 바퀴·발이 빠질 수 있는 느슨한 지반 포함.":
      "Mix of sand to fine sediment and dust. Dunes and wind streaks possible. Includes loose ground where wheels or feet can sink.",
    "굵은 모래·자갈 또는 염류로 굳은 토양(듀리크러스트) + 암석 혼재. 굳은 껍질 밑에 무른 층이 숨어 있을 수 있음(Spirit이 빠진 Troy 사례).":
      "Coarse sand · gravel or salt-cemented soil (duricrust) mixed with rocks. A soft layer may hide under the hard crust (as at Troy, where Spirit got stuck).",
    "암석·노출 암반 비율 높음. 밤에도 따뜻함. 지층·변질 광물(물 흔적) 직접 관찰에 유리한 후보지. 보행은 단단하나 장애물 많음.":
      "High fraction of rocks and exposed bedrock. Stays warm at night. Good candidate for directly observing strata and altered minerals (traces of water). Firm footing but many obstacles.",
    "주변보다 열관성이 뚜렷이 높은 곳: 암반 노출, 고결 퇴적층, 암석 밀집 가능. 물 흔적(퇴적암·변질 광물) 관찰 후보 — 분광(광물) 레이어와 겹쳐 우선순위 판단.":
      "Thermal inertia clearly higher than the surroundings: possible exposed bedrock, indurated sediment or dense rocks. Candidate for observing traces of water (sedimentary rock · altered minerals) — overlay the mineral layer to prioritize.",
    "느슨한 먼지·세립 모래. 지지력 낮아 빠짐·미끄러짐 위험 큼. EVA 경로에서 회피 권장.":
      "Loose dust · fine sand. Low bearing strength, high risk of sinking and slipping. Avoid on EVA routes.",
    "모래·고결 토양 혼재. 겉은 단단해 보여도 밑에 무른 층 가능. 현장 확인 필요.":
      "Mix of sand and indurated soil. May look firm on top with a soft layer below. Check on site.",
    "암석·단단한 지반 우세. 빠짐 위험 낮으나 암석 장애물·경사 주의.":
      "Mostly rock and firm ground. Low risk of sinking, but watch for rock obstacles and slopes.",

    // 포인트
    "포인트 추가": "Add point",
    "나의 정보 (준비 중)": "Profile (coming soon)",
    "로버 경로": "Rover traverse",
    "로버 교신 두절": "Rover contact lost",
    "내 포인트": "My points",
    "등록된 포인트 없음": "No points yet",
    "새 포인트": "New point",
    "이름": "Name",
    "종류": "Type",
    "메모": "Note",
    "예: 동굴 입구 후보": "e.g. Possible cave entrance",
    "선택 사항": "Optional",
    "기지 (통신 · 귀환 기준)": "Base (comm · return reference)",
    "Spirit 이동 경로": "Spirit traverse",
    "실제 주행 기록": "Actual drive log",
    "Spirit 교신 두절 지점 (Troy)": "Spirit lost-contact site (Troy)",
    "Columbia Memorial Station (착륙지)": "Columbia Memorial Station (landing site)",
    "Bonneville 크레이터 가장자리": "Bonneville crater rim",
    "Missoula 크레이터": "Missoula crater",
    "Husband Hill 정상": "Husband Hill summit",
    "Home Plate 북서쪽 가장자리": "Home Plate northwest edge",
    "Low Ridge (2006 겨울 정박지)": "Low Ridge (2006 winter haven)",
    "Troy (마지막 정지 지점)": "Troy (final stop)",
    "착륙선 옆, 정확한 sol 미확인": "next to the lander, exact sol unconfirmed",
    "site 32에서 촬영, 핀에서 약 65 m 떨어짐": "taken at site 32, about 65 m from the pin",
    "site 113에서 촬영, 약 16 m 떨어짐": "taken at site 113, about 16 m away",
    "원본 JPEG 28 MB": "original JPEG 28 MB",
    "Navcam(sol 807)과 Pancam(sol 835)을 합성한 모자이크": "mosaic combining Navcam (sol 807) and Pancam (sol 835)",
    "2006년 겨울나기 (sol 880~1010, 가장 오래 머문 곳)": "2006 winter stay (sol 880–1010, the longest stop)",
    "2009년 모래에 빠진 곳": "Stuck in sand in 2009",
    "Bonneville Crater 가장자리": "Bonneville Crater rim",
    "Columbia Hills 도착 (West Spur)": "Arrival at Columbia Hills (West Spur)",
    "Columbia Hills 의 봉우리 · 정상 도착 (sol 581)": "Peak of the Columbia Hills · summit reached (sol 581)",
    "Everest 파노라마 촬영지": "Everest panorama site",
    "Husband Hill 정상에서 360° 파노라마 촬영 (sol 620~622)": "360° panorama taken from the Husband Hill summit (sol 620–622)",
    "Spirit 착륙 지점 (2004-01-04)": "Spirit landing site (2004-01-04)",
    "착륙 후 처음 찾아간 큰 크레이터 (sol 65)": "First large crater visited after landing (sol 65)",
    "평원을 3 km 가로질러 언덕 기슭에 도착 (sol 156)": "Reached the foot of the hills after crossing 3 km of plains (sol 156)",
    "화산 폭발로 쌓인 층상 지형 · 도착 (sol 744)": "Layered terrain built by volcanic eruptions · arrival (sol 744)",

    // 사진 보기
    "360° 파노라마. 좌우로 드래그해서 방향 바꾸기": "360° panorama. Drag left/right to change direction",
    "360° · DEM 지형 시점 (사진 아님)": "360° · DEM terrain view (not a photo)",
    "↔ 드래그하거나 슬라이더로 돌려보기": "↔ Drag or use the slider to look around",
    "드래그하거나 슬라이더로 돌려보기": "Drag or use the slider to look around",
    "자동 회전": "Auto-rotate",
    "자동 회전 멈춤": "Stop auto-rotate",
    "보는 방향 (0~360°)": "View direction (0–360°)",
    "전체 화면": "Fullscreen",
    "궤도 사진": "Orbital imagery",
    "출처": "Source",
    "360° 지형 시점": "360° terrain view",
    "DEM 으로 그 자리에서 그린 지형 (사진 아님)": "Terrain rendered on the spot from the DEM (not a photo)",

    // 시계
    "시각 바꾸기": "Change time",
    "화성 지방시": "Mars time",
    "실시간": "LIVE",
    "지정 시각": "SET",
    "지구 시각으로 지정": "Set by Earth time",
    "현재 시각으로": "Back to now",
    "현위치 방사선 (추정)": "Radiation here (est.)",
    "화성 솔 날짜": "Mars sol date",
    "현위치 기압 (추정)": "Pressure here (est.)",
    "계절 기압": "Seasonal pressure",
    "하루 중 기압": "Daily pressure",
    "태양 주기 (우주선)": "Solar cycle (cosmic rays)",

    // 길찾기
    "안전한 길": "Safest route",
    "최단 거리": "Shortest route",
    "체력 아끼는 길": "Energy-saving route",
    "방사선 최소 · 빠른 귀환 · 통신 유지": "Least radiation · quick return · stays in comm",
    "가장 짧고 빠른 길 · 위험은 한계까지 감수": "Shortest and fastest · accepts risk up to the limits",
    "산소 · 체력 소모가 가장 적은 길": "Uses the least oxygen and energy",
    "지도에서 선택": "Pick on map",
    "지도를 클릭하거나 핀을 선택": "Click the map or choose a pin",
    "현위치 · 포인트 · 좌표 입력": "Current position · point · coordinates",
    "좌표 예: 14.57S, 175.47E": "Coordinates e.g. 14.57S, 175.47E",
    "좌표 형식 확인 또는 목록에서 선택 · 예: 14.57S, 175.47E": "Check the coordinate format or pick from the list · e.g. 14.57S, 175.47E",
    "현재 지도 범위 밖 좌표": "Coordinates outside the current map",
    "선택 후 HUD 복귀": "returns to HUD after picking",
    "배터리 부족 (추위로 히터 전력 증가)": "Battery too low (heater draw rises in the cold)",
    "경로의 절반 이상이 통신 음영": "More than half of the route is in comm shadow",
    "실제 지형(HiRISE DEM + 탐사 데이터)으로 D* Lite 경로 계산 중": "Computing D* Lite routes on real terrain (HiRISE DEM + survey data)",
    "HiRISE DEM 30 m + 탐사 데이터": "HiRISE DEM 30 m + survey data",
    "기지 없음 (안전한 곳 = 출발지, 통신 미평가)": "no base (safe point = start, comm not evaluated)",
    "출발지 · 경유지 · 도착지 모두 Columbia Hills 지도(HiRISE DEM 범위) 안에 있어야 함": "Start, stops and destination must all be inside the Columbia Hills map (HiRISE DEM coverage)",
    "지형 데이터 읽기 실패 · 로컬 서버(python3 -m http.server)로 열었는지 확인 필요": "Failed to read terrain data · Make sure the page is served from a local server (python3 -m http.server)",
    "앞의 지형이 지도와 달라 현재 위치에서 갈 수 있는 길 없음 · 다른 경로 선택 필요": "Terrain ahead differs from the map and there is no way through from here · Choose another route",
    "나의 정보 변경됨 · 길 찾기 다시 실행 필요": "Profile changed · Run Find route again",
    "탐사 기록 삭제됨 · 길 찾기 다시 실행 필요": "Survey log cleared · Run Find route again",
    "아래에서 다른 길 선택 가능": "Choose a different route below",
    "소모 산소": "Oxygen used",
    "소모 에너지": "Energy used",
    "방사선 노출": "Radiation dose",
    "최대 경사": "Max slope",
    "누적 오르막": "Total climb",
    "평균 속도": "Average speed",
    "누적 내리막": "Total descent",
    "최고 고도": "Highest point",
    "모래 지대": "Sandy ground",
    "거친 지면": "Rough ground",
    "그늘 구간": "In shade",
    "통신 유지": "In comm",
    "최대 귀환 시간": "Max return time",
    "간단히": "Less",
    "자세히": "Details",
    "일몰 후": "after sunset",

    // 나의 정보
    "대원 1": "Crew 1",
    "몸무게": "Body weight",
    "걷기 속도 (평지)": "Walking speed (flat)",
    "경사 한계": "Slope limit",
    "산소 탱크": "Oxygen tank",
    "EVA 최대 시간": "Max EVA time",
    "안전 여유": "Safety margin",
    "하루 체력 예산": "Daily energy budget",
    "EVA 방사선 한도": "EVA radiation limit",
    "시간": "h",
    "걷는 데 드는 에너지(Pandolf 식)에 반영": "Used for walking energy (Pandolf equation)",
    "우주복을 입고 평지를 걷는 속도. 경사 · 모래에서는 여기서 더 느려짐 (Apollo 평균 ≈ 3.6 km/h · 시연용으로 100 까지)":
      "Speed walking on flat ground in a suit. Slower than this on slopes · sand (Apollo average ≈ 3.6 km/h · up to 100 for demos)",
    "우주복 주 산소량 (Apollo PLSS ≈ 460 L)": "Primary suit oxygen (Apollo PLSS ≈ 460 L)",
    "한 번의 선외활동 한도": "Limit for a single EVA",
    "산소 · 시간 · 경사를 이만큼 남겨 둠. '안전한 길' 은 경사 한계에도 적용": "Keeps this much oxygen · time · slope in reserve. 'Safest route' also applies it to the slope limit",
    "피로도 100% 기준 (8시간 × 300 W ≈ 2,065 kcal)": "Defines 100% fatigue (8 h × 300 W ≈ 2,065 kcal)",
    "한 번의 EVA 에서 받아도 되는 양 (경고 기준)": "Acceptable dose for a single EVA (warning threshold)",
    "기본값으로": "Reset to defaults",

    // HUD
    "급경사": "Steep slope",
    "모래 함몰 위험": "Sand trap risk",
    "무른 모래": "Soft sand",
    "바위 많음 (발목 부상)": "Rocky (ankle injury risk)",
    "그늘 (저온 · 어두움)": "Shade (cold · dark)",
    "피로도": "Fatigue",
    "귀환": "Return",
    "부족": "Low",
    "범위 밖": "Out of range",
    "귀환 불가": "No return",
    "출발 지점": "Start point",
    "목적지 도착": "Arrived at destination",
    "발밑 경사": "Slope here",
    "모래 빠짐": "Sand trap",
    "DEM 범위 밖": "Outside DEM coverage",

    // 지점 조사
    "지점 정보": "Location info",
    "선택한 지점": "Selected location",
    "지형": "Terrain",
    "거칠기 · 암석": "Roughness · rocks",
    "현위치에서": "From here",
    "통행 불가": "impassable",
    "내 한계 초과": "over my limit",
    "탐사로 확인": "confirmed by survey",
    "환경": "Environment",
    "기압": "Pressure",
    "태양": "Sun",
    "지평선 아래": "Below the horizon",
    "일출 · 일몰": "Sunrise · Sunset",
    "기지 통신": "Base comm",
    "음영 (지형에 가림)": "Shadowed (blocked by terrain)",
    "지질 단위": "Geologic unit",
    "표면 물질": "Surface material",
    "노출 암반": "Exposed bedrock",
    "고결층 후보 지역": "indurated layer candidate area",
    "가까운 광물": "Nearest mineral",
    "옛 계곡": "Ancient valley",
    "지질 · 물의 흔적": "Geology · Traces of water",
    "사진 · 360° 파노라마": "Photos · 360° panorama",
    "포인트에 추가": "Add to points",
    "그리는 중": "Rendering",
    "DEM 읽기 실패": "Failed to read DEM",
    "출발지로": "Set as start",
    "도착지로": "Set as destination",

    // 내 위치 찾기
    "주변 지형으로 내 위치 찾기": "Find my position from the surrounding terrain",
    "화성에는 GPS 없음 · 주변 지형을 위성 사진과 비교해 현재 위치 계산": "No GPS on Mars · Position is computed by matching the surrounding terrain to satellite imagery",
    "화성에는 GPS 없음 · 주변 지형을 위성 사진과 비교해 현재 위치 계산 (NASA JPL Censible 방식)":
      "No GPS on Mars · Position is computed by matching the surrounding terrain to satellite imagery (NASA JPL Censible method)",
    "시연: NASA Spirit 로버가 실제로 찍은 주변 사진을 위성 사진과 비교해 위치 계산 (NASA JPL Censible 방식)":
      "Demo: position computed by matching real surround photos taken by NASA's Spirit rover to satellite imagery (NASA JPL Censible method)",
    "주변 궤도 지도": "Surrounding orbital map",
    "300m 주변 궤도 지도": "Orbital map, 300 m around",
    "200m 주변 위성 사진": "Satellite image, 200 m around",
    "앱이 알던 위치": "position the app had",
    "실제 위치": "True position",
    "찾은 위치": "found position",
    "주변 360° 촬영": "Capture 360° surroundings",
    "로버가 찍은 주변 사진": "Surround photo taken by the rover",
    "내 주변 360° 촬영 (가상)": "Capture 360° around me (simulated)",
    "위에서 본 모습으로 바꾸기": "Convert to a top-down view",
    "밝기에 강한 무늬 뽑기": "Extract lighting-robust patterns",
    "위성 사진에서 같은 무늬 찾기 (반경 40m)": "Search the satellite image for the same pattern (40 m radius)",
    "정밀 보정 · 믿을 만한지 확인": "Fine alignment · confidence check",
    "내 주변 지형": "Terrain around me",
    "위에서 본 모습": "top-down view",
    "무늬로 바꾼 모습": "Converted to patterns",
    "Census 변환": "Census transform",
    "조명이 달라도 같은 무늬": "same pattern under different lighting",
    "위성 사진에서 찾기": "Search in satellite image",
    "얼마나 닮았나": "How similar",
    "밝을수록 내 주변과 비슷한 곳": "brighter = more like my surroundings",
    "시연용: 실제 Spirit 로버 사진이 있는 곳에서 측정": "Demo: measure where real Spirit rover photos exist",
    "실제 로버 사진으로 해보기": "Try with real rover photos",
    "다시 측정": "Measure again",
    "찾은 위치 지도에서 보기": "Show found position on map",
    "찾은 위치로 HUD 돌아가기": "Return to HUD at found position",
    "실제 로버 사진": "Real rover photo",
    "원본 위성 사진": "Source satellite image",
    "위에서 본 모습, 반경 40m": "top-down view, 40 m radius",
    "숨겨진 실제 위치 주변, 반경 40m": "around the hidden true position, 40 m radius",
    "점선 = 매칭에 쓴 4~25m": "dashed = 4–25 m used for matching",
    "관측에 사용한 실제 로버 사진": "Real rover photo used as the observation",
    "로버": "Rover",
    "NASA Spirit (MER-A) · Navcam 왼쪽 카메라": "NASA Spirit (MER-A) · Navcam left camera",
    "촬영": "Taken",
    "sol 36 (2004-02-09) · Gusev 크레이터 착륙지 부근": "sol 36 (2004-02-09) · near the Gusev crater landing site",
    "제품": "Product",
    "2NN036EFF04VRT00P1617L000M2 (NASA PDS, 수직 투영 모자이크)": "2NN036EFF04VRT00P1617L000M2 (NASA PDS, vertical projection mosaic)",
    "해상도": "Resolution",
    "원본 2 cm/px → 0.5 m/px 로 맞춰 사용": "native 2 cm/px → resampled to 0.5 m/px",
    "측정이 끝나면 공개 (정답)": "revealed after the measurement (ground truth)",
    "관측: 위성 사진으로 만든 가상 관측": "Observation: simulated from satellite imagery",
    "궤도 지도": "Orbital map",
    "현위치 주변 ±100m 고해상도 위성 사진 (HiRISE 등, 0.25 m/px)": "High-res satellite imagery ±100 m around you (HiRISE etc., 0.25 m/px)",
    "가상 관측": "Simulated view",
    "숨겨진 실제 위치의 위성 사진에 조명 차이·노이즈·스테레오 빈틈·바위 그림자·방위 오차를 넣음":
      "Satellite image at the hidden true position with lighting change, noise, stereo gaps, rock shadows and heading error added",
    "추정 위치": "Estimated position",
    "지금 앱이 알고 있는 현위치 (실제와 15~35m 어긋났다고 가정)": "Position the app currently has (assumed 15–35 m off the truth)",
    "로버가 찍은 사진과 위성 사진을 비교해서 위치를 찾는 중": "Matching the rover photo to satellite imagery to find the position",
    "내 주변 지형과 위성 사진을 비교해서 위치를 찾는 중": "Matching my surroundings to satellite imagery to find the position",
    "이 지역은 현위치 정보 없음": "No current position for this region",
    "고해상도 위성 사진 타일 없음": "No high-res satellite tiles",
    "현위치 주변 고해상도 위성 사진 없음 (Gusev 현위치 주변 3km 안에서만 가능)": "No high-res satellite imagery around you (only within 3 km of the Gusev start position)",
    "데이터 읽기 실패 · Live Server 등 http 로 열기 필요": "Failed to read data · Open over http (e.g. Live Server)",
    "찾은 내 위치": "My position found",
    "앱이 알던 위치에서": "From the app's position",
    "믿을 만한 정도": "Confidence",
    "다른 정도 (낮을수록 닮음)": "Difference (lower = closer match)",
    "계산 시간": "Compute time",

    // 사용법 안내
    "건너뛰기": "Skip",
    "이전": "Back",
    "다음": "Next",
    "시작하기": "Get started",
    "완료": "Done",
    "화성 탐사 대원을 위한 지도. 주요 기능 30초 안내.": "A map for crews exploring Mars. A 30-second tour of the main features.",
    "지도": "Map",
    "드래그로 이동 · 휠로 확대/축소. 아무 곳이나 클릭하면 그 지점의 고도 · 경사 · 방사선 정보 표시.":
      "Drag to pan · scroll to zoom. Click anywhere to see elevation · slope · radiation at that spot.",
    "길찾기 · 레이어 · 포인트 · 나의 정보. 출발지와 도착지를 정하면 안전한 길 · 최단 거리 · 에너지 절약 경로 계산.":
      "Route · Layers · Points · Profile. Set a start and destination to get the safest · shortest · energy-saving routes.",
    "화성 시각": "Mars time",
    "현재 화성 지방시와 계절. 누르면 시각 변경 가능 → 방사선 · 그늘 · 기온 추정에 반영.":
      "Current Mars local time and season. Click to change the time → radiation · shade · temperature estimates follow.",
    "누르면 1인칭 화면으로 전환. 실제 지형 위에 경로 · 위험 구역 · 산소 상태 표시. W A S D 로 이동.":
      "Click for a first-person view. Shows the route · hazards · oxygen status over real terrain. Move with W A S D.",
    "보기 전환": "View controls",
    "위에서부터 HUD 창 켜기/끄기 · 2D/3D 지도 전환 · 주변 지형으로 내 위치 찾기 (화성에는 GPS 없음).":
      "From the top: show/hide HUD window · switch 2D/3D map · find my position from terrain (there is no GPS on Mars).",
    "실제 지형을 1인칭으로 보는 화면. W A S D 이동 · Shift 달리기 · 드래그 또는 방향키로 둘러보기.":
      "A first-person view of real terrain. W A S D to move · Shift to run · drag or arrow keys to look around.",
    "바닥의 색 점": "Colored dots on the ground",
    "지형 위에 찍힌 점의 색이 위험 정도. 파랑 = 안전 · 노랑 = 주의 · 빨강 = 위험. 경사 · 모래 · 거친 지면 · 그늘을 합쳐 계산.":
      "Dot color on the terrain shows hazard level. Blue = safe · yellow = caution · red = danger. Combines slope · sand · rough ground · shade.",
    "방위 · 전방 상태": "Heading · Terrain ahead",
    "바라보는 방향과 포인트가 있는 방위. 아래 알약은 전방 25 m 지형의 안전 · 주의 · 위험.":
      "The direction you face and the bearings of points. The pill below shows safe · caution · danger for the 25 m ahead.",
    "발밑 지형": "Terrain underfoot",
    "지금 서 있는 곳의 고도 · 경사 · 모래 빠짐 위험 · 기지와의 통신 상태.": "Elevation · slope · sand trap risk · comm status with the base, where you stand.",
    "기지 설치": "Set up a base",
    "기지는 통신과 귀환의 기준점. 아래 버튼을 누르면 내 위치 근처에 기지 설치 → 귀환 여유 · 통신 상태 계산에 사용.":
      "The base is the reference for comm and for getting back. Press the button below to place a base near you → used for return margin · comm status.",
    "내 주변에 기지 설치": "Place a base near me",
    "기지 설치됨": "Base placed",
    "연결": "Linked",
    "음영": "Shadowed",
    "생체 · 장비 상태": "Vitals · Suit status",
    "산소 잔량 · 방사선 누적 · 피로도 · 기지까지 귀환 여유. 냉각수나 전력이 부족하면 경고 링 추가.":
      "Oxygen left · accumulated radiation · fatigue · margin to return to base. A warning ring appears when coolant or power runs low.",
    "GPS 없이 주변 지형을 위성 사진과 비교해 현재 위치 보정.": "Corrects your position without GPS by matching the surrounding terrain to satellite imagery.",
    "미니맵. 누르면 2D 지도로 복귀. 왼쪽 위 메뉴를 열어도 2D 지도로 전환.": "Minimap. Click to return to the 2D map. Opening the top-left menu also switches to the 2D map.",
    "길찾기 · 레이어 · 포인트 · 나의 정보 네 가지 탭.": "Four tabs: Route · Layers · Points · Profile.",
    "출발지 · 도착지를 입력하거나 핀 아이콘으로 지도에서 선택. 길 찾기를 누르면 경로 3가지 비교 → 안내 시작.":
      "Type a start · destination or pick them on the map with the pin icon. Find route compares 3 routes → Start guidance.",
    "걸으면 길이 고쳐짐": "The route fixes itself as you walk",
    "지도는 오래전 궤도에서 찍은 것이라 지금 지형과 다를 수 있음. 걸으면 주변 10 m 를 직접 확인하고, 지도와 다르면 남은 길을 바로 다시 계산.":
      "The map was taken from orbit long ago, so it may differ from today's terrain. As you walk, the 10 m around you is checked directly, and if it differs from the map the rest of the route is recalculated right away.",
    "걸으며 확인한 장애물을 피해 길을 다시 계산하는 그림": "Diagram: the route is recalculated around an obstacle found while walking",
    "옛 지도로 짠 길": "Route from the old map",
    "걸으며 확인한 범위": "Area checked on foot",
    "새로 발견한 장애물": "Newly found obstacle",
    "다시 계산한 길": "Recalculated route",
    "지도 위에 겹쳐 보는 데이터 (고도 · 열관성 · 물의 흔적 · 위험 요소). 스위치로 켜고 끄기 · 묶음 제목을 누르면 접기.":
      "Data overlaid on the map (elevation · thermal inertia · traces of water · hazards). Toggle with the switches · click a group title to collapse it.",
    "탐사 지점 목록. 누르면 지도에서 위치 표시 · 사진 보기. 아래 버튼으로 새 포인트 추가.":
      "List of exploration sites. Click one to locate it on the map · view photos. Use the button below to add a new point.",
    "몸무게 · 걷기 속도 · 산소 탱크 등. 경로 계산과 HUD 상태에 그대로 반영.": "Body weight · walking speed · oxygen tank and more. Applied directly to route planning and HUD status.",
  };

  // ---------- 2) 놓인 곳에 따라 뜻이 다른 말 ----------
  const CONTEXT = [
    [".route-card", { "도착": "Arrival" }],
    [".tour", { "둘러보기": "Take the tour" }],
    [".add-hint", { "취소": "to cancel" }],
    [".hud-ring", { "방사선": "Rad." }],
    [".loc-source figcaption, .loc-panel figcaption", { "실제 위치": "true position" }],
  ];

  // ---------- 3) 숫자 · 이름이 끼어 있는 문장 ----------
  //  T(글) = 그 조각을 다시 번역 (번역이 없으면 그대로)
  const DUR = "((?:\\d+시간 )?\\d+분)";
  const PATTERNS = [
    // 시간 · 단위
    [/^(\d+)시간 (\d+)분$/, "$1 h $2 min"],
    [/^(\d+)분$/, "$1 min"],
    [/^([\d.]+) ?시간$/, "$1 h"],
    [/^(\d+)솔$/, "$1 sol"],
    [/^약 (.+)$/, (m, T) => `~${T(m[1])}`],
    [/^([\d.]+) mSv\/일$/, "$1 mSv/day"],
    [/^([\d.]+) mSv\/일 \(([\d.]+) μSv\/시간\)$/, "$1 mSv/day ($2 μSv/h)"],
    [/^([\d.]+) 낮음$/, "$1 low"],
    [/^([\d.]+) mSv\/일 높음$/, "$1 mSv/day high"],
    [/^(남|북)반구 (봄|여름|가을|겨울)$/, (m) => `${{ 남: "Southern", 북: "Northern" }[m[1]]} ${{ 봄: "spring", 여름: "summer", 가을: "autumn", 겨울: "winter" }[m[2]]}`],
    [/^지구 (.+)$/, "Earth $1"],
    [/^화성 지방시 (\S+)$/, "Mars local time $1"],
    [/^환경 · 화성 지방시 (\S+)$/, "Environment · Mars local time $1"],

    // HUD
    [/^전방 (\d+)m 이내 안전$/, "Clear for $1 m ahead"],
    [/^전방 (\d+)m$/, "$1 m ahead"],
    [/^(급경사|경사) (\S+)$/, (m, T) => `${T(m[1])} ${m[2]}`],
    [/^도착지$/, "Destination"],
    [/^잔여 (.+)$/, "$1 left"],
    [/^여유 (\S+)%$/, "Margin $1%"],
    [/^길찾기 경로$/, "Route"],
    [/^남은 거리 (.+)$/, "$1 to go"],
    [/^경로 이탈 (\d+)m$/, "Off route by $1 m"],
    [/^(오른쪽|왼쪽)으로 (\d+)° 회전$/, (m) => `Turn ${m[1] === "오른쪽" ? "right" : "left"} ${m[2]}°`],
    [/^고도 (.+)$/, "Elev. $1"],
    [/^방위 (.+)$/, "Azimuth $1"],

    // 길찾기
    [/^경유지 (\d+)$/, "Stop $1"],
    [/^(▶ )?(.+)로 안내 시작$/, (m, T) => `${m[1] || ""}Start guidance: ${T(m[2])}`],
    [/^(.+) 위치를 지도에서 클릭 \(기존 핀 선택 가능\)$/, (m, T) => `Click the map to set ${T(m[1])} (existing pins can be chosen)`],
    [/^(.+) 지도에서 선택$/, (m, T) => `Pick ${T(m[1])} on map`],
    [/^(.+) 전체 지도에 표시$/, (m, T) => `Show all ${T(m[1])} on map`],
    [/^(.+) 지도에 표시$/, (m, T) => `Show ${T(m[1])} on map`],
    [/^(.+) 전체 켜기\/끄기$/, (m, T) => `Toggle all: ${T(m[1])}`],
    [/^(.+) 삭제$/, (m, T) => `Delete ${T(m[1])}`],
    [/^(.+) 지정됨$/, (m, T) => `${T(m[1])} set`],
    [/^(.+) 입력 또는 지도에서 선택 필요$/, (m, T) => `Enter ${T(m[1])} or pick it on the map`],
    [/^경사 한계 (\S+)° 안에서 걸어갈 수 있는 길 없음 \(나의 정보에서 조정 가능\)$/, "No walkable route within the $1° slope limit (adjust in Profile)"],
    [/^경사 한계 (\S+)$/, "slope limit $1"],
    [/^출발 화성 지방시 (\S+) 기준$/, "departing at $1 Mars local time"],
    [/^(.+): 조건에 맞는 길 없음$/, (m, T) => `${m[1].split(", ").map(T).join(", ")}: no route meets the constraints`],
    [/^산소 부족: (\d+) L 필요 \/ 탱크 (\d+) L$/, "Not enough oxygen: $1 L needed / $2 L tank"],
    [/^산소 안전 여유\((\d+)%\) 침범: (\d+) L \/ 사용 가능 (\d+) L$/, "Cuts into the oxygen safety margin ($1%): $2 L / $3 L usable"],
    [/^EVA 최대 시간 (\S+)시간 초과$/, "Exceeds the max EVA time of $1 h"],
    [/^EVA 시간 여유 침범 \(사용 가능 (\S+)시간\)$/, "Cuts into the EVA time margin ($1 h usable)"],
    [new RegExp(`^밤에 출발 — 일출까지 ${DUR}$`), (m, T) => `Departing at night — ${T(m[1])} until sunrise`],
    [new RegExp(`^일몰 ${DUR} 뒤에 도착 — 야간 이동$`), (m, T) => `Arrives ${T(m[1])} after sunset — night travel`],
    [new RegExp(`^일몰 ${DUR} 전 도착 — 여유 적음$`), (m, T) => `Arrives ${T(m[1])} before sunset — little margin`],
    [new RegExp(`^일몰 ${DUR} 전$`), (m, T) => `${T(m[1])} before sunset`],
    [/^(\S+) \(밤\)$/, "$1 (night)"],
    [/^방사선 한도 (\d+) μSv 초과$/, "Exceeds the radiation limit of $1 μSv"],
    [/^하루 체력 예산 ([\d,]+) kcal 초과$/, "Exceeds the daily energy budget of $1 kcal"],
    [/^(.+) \(위험 (\d+)\)$/, "$1 (risk $2)"],
    [/^(\d+)개 지점$/, "$1 points"],

    // 나의 정보
    [/^이보다 가파른 곳은 경로에서 제외 \((\d+)° 이상은 누구나 통행 불가\)$/, "Steeper ground is excluded from routes ($1° and above is impassable for anyone)"],
    [/^쓸 수 있는 산소 (.+)$/, "Usable oxygen $1"],
    [/^활동 시간 (\S+) 시간 \(여유 (\S+)% 제외\)$/, "active time $1 h (excluding the $2% margin)"],
    [/^안전한 길 경사 (\S+)° 까지$/, "Safest route allows up to $1° slope"],

    // 레이어
    [/^위험 (낮음|중간|보통|높음)$/, (m, T) => `Risk: ${T(m[1])}`],
    [/^위험 ([\d.]+%?)$/, "danger $1"],
    [/^Columbia Hills 30 km 중 주의 (.+)$/, "of the 30 km Columbia Hills area: caution $1"],
    [/^지금 화면에 보이는 고도에 맞춘 색 \(차이 (\S+) m\) · 지도를 움직이면 다시 맞춤$/, "Colors scaled to the elevations in view (range $1 m) · rescales when the map moves"],
    [/^기지 (\d+)곳$/, "$1 base(s)"],
    [/^기지 (\d+)$/, "Base $1"],
    [/^안테나 (\S+) m 기준 직선 가시 \(지형 \+ 화성 곡률, 낮은 둔덕 (\S+) m 는 회절로 통과\)$/, "line of sight for a $1 m antenna (terrain + Mars curvature; low rises of $2 m pass by diffraction)"],
    [
      /^컬러 = 직접 가 본 곳 \(HUD 에서 걸어 다닌 길에서 (\S+) m 안 · 지형 데이터는 밟은 30 m 칸 단위로 탐사 데이터로 갱신\), 흑백 = 미탐험\. 기존 DEM 이후 약 (\d+)년 변화 반영$/,
      "Color = places you have been (within $1 m of your HUD walk · terrain data is replaced by survey data per 30 m cell you step on), B&W = unexplored. Reflects ~$2 years of change since the original DEM",
    ],
    [
      /^기준점: (기지 )?(.+?) · 왕복 가능 범위 약 (\S+) km² \(최대 (\S+) km\)\. 예산: 산소 (\d+) L · (일몰까지|활동 시간) (\S+)시간 \(안전 여유 (\S+)% 제외(, 지금은 밤 — 일몰 제한 미적용)?\) · 나의 정보 · 시계 변경 시 다시 계산$/,
      (m, T) =>
        `Reference: ${m[1] ? "base " : ""}${T(m[2])} · round-trip range ~${m[3]} km² (max ${m[4]} km). Budget: oxygen ${m[5]} L · ${m[6] === "일몰까지" ? `${m[7]} h until sunset` : `${m[7]} h active time`} (excluding the ${m[8]}% safety margin${m[9] ? ", night now — sunset limit not applied" : ""}) · recalculated when Profile · clock change`,
    ],

    // 지점 조사 · 사진
    [/^(낮음|보통|높음) \((\d+)%?\)$/, (m, T) => `${T(m[1])} (${m[2]}${m[0].includes("%") ? "%" : ""})`],
    [/^열관성 약 (\d+) tiu$/, "thermal inertia ~$1 tiu"],
    [/^(\S+) 사진$/, "$1 photo"],
    [/^가시광 모자이크 (.+)$/, "visible mosaic $1"],
    [/^sol (.+) \((\S+) 공개\)$/, "sol $1 (released $2)"],
    [/^사진 (\d+) 파노라마로 보기$/, "View photo $1 as panorama"],
    [/^사진 (\d+) 크게 보기$/, "Enlarge photo $1"],
    [/^반경 (.+)$/, "radius $1"],
    [/^HRSC 모자이크 \((.+)\)$/, "HRSC mosaic ($1)"],
    [/^HiRISE DEM \((\S+) m 격자\)$/, "HiRISE DEM ($1 m grid)"],

    // 내 위치 찾기
    [/^(.+) \(sol 36 실제 로버 위치\)$/, "$1 (actual rover position on sol 36)"],
    [/^(.+) \(숨겨 둔 실제 위치\)$/, "$1 (hidden true position)"],
    [/^(동|서)쪽 ([\d.]+)m, (북|남)쪽 ([\d.]+)m 이동$/, (m) => `moved ${m[2]} m ${m[1] === "동" ? "east" : "west"}, ${m[4]} m ${m[3] === "북" ? "north" : "south"}`],
    [/^비교 ([\d,]+)px$/, "$1 px compared"],
    [/^후보 ([\d,]+)곳 비교$/, "$1 candidates compared"],

    [/^마지막 교신 (.+)$/, "last contact $1"],
    [/^현위치 (.+)$/, "Current position $1"],
    // "이름 12%" · "이름 3" 처럼 값이 붙은 글
    [/^(.+?) (-?[\d.,e-]+%?)$/, (m, T) => `${T(m[1])} ${m[2]}`],
    // "이름 (3)" 같은 개수 표시 — 맨 마지막에
    [/^(.+) \((\d+)\)$/, (m, T) => `${T(m[1])} (${m[2]})`],
  ];

  // ---------- 4) 여러 조각으로 나뉜 문장: 요소 통째로 ----------
  const BLOCK_SELECTOR = ".loc-source__note, .loc-result__sim, .loc-result__warn";
  const BLOCKS = [
    [
      /^Spirit 로버가 실제로 360° 촬영한 사진/,
      () =>
        "A dataset made by converting <b>real 360° photos taken by the Spirit rover</b> into top-down terrain. Matched against <b>orbital imagery (data/ visible mosaic)</b> with the Census method to compute the position. Ground truth is the value confirmed from the Spirit lander visible in the orbital image.",
    ],
    [
      /^우주인 카메라가 없어/,
      () =>
        "There is no astronaut camera, so <b>satellite imagery stands in for the observation</b>. Works around wherever your position is. To see it with real rover photos, choose <b>🛰 Try with real rover photos</b> below.",
    ],
    [/^실제 로버 위치\(궤도 사진의 Spirit 착륙선으로 확인\)와의 오차 (\S+) m$/, (m) => `Error vs. the actual rover position (confirmed from the Spirit lander in orbital imagery): <b>${m[1]} m</b>`],
    [/^숨겨 둔 실제 위치와의 오차 (\S+) m$/, (m) => `Error vs. the hidden true position: <b>${m[1]} m</b>`],
    [/^(.+) · 🛰 실제 로버 사진으로 해보기는 언제나 시연 가능$/, (m, T) => `${T(m[1])} · <b>🛰 Try with real rover photos</b> always works for a demo`],
  ];

  // ---------- 번역기 ----------
  const cache = new Map();
  const missing = new Set(); // 번역이 없어 그대로 둔 글 (개발 확인용: window.__i18nMissing)
  window.__i18nMissing = missing;

  const self = (s) => (HANGUL.test(s) ? core(s, null) ?? s : s);

  // 괄호 밖의 " · " 에서만 자름
  function splitTop(s, sep) {
    const out = [];
    let depth = 0;
    let last = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && s.startsWith(sep, i)) {
        out.push(s.slice(last, i));
        last = i + sep.length;
        i = last - 1;
      }
    }
    out.push(s.slice(last));
    return out;
  }

  // s: 앞뒤 공백을 뗀 한국어가 든 글. 번역 못 하면 null
  function core(s, ctx) {
    if (ctx && ctx[s] != null) return ctx[s];
    if (EXACT[s] != null) return EXACT[s];
    for (const [re, rep] of PATTERNS) {
      const m = s.match(re);
      if (!m) continue;
      const out = typeof rep === "function" ? rep(m, self) : s.replace(re, rep);
      if (!HANGUL.test(out)) return out; // 한국어가 남으면 이 규칙은 아닌 것 → 다음 규칙 · 조각 나누기로
    }
    // 앞뒤 기호(＋ ▶ ⚠️ 괄호 … 등)를 떼고 다시
    const m = s.match(/^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N}%°²]*)$/u);
    if (m && m[2] && (m[1] || m[3])) {
      const inner = core(m[2], ctx);
      if (inner != null) return m[1] + inner + m[3];
    }
    for (const sep of [" · ", ", "]) {
      const parts = splitTop(s, sep);
      if (parts.length > 1) {
        const done = parts.map((p) => (HANGUL.test(p) ? core(p.trim(), ctx) : p));
        if (done.every((p) => p != null)) return done.join(sep);
      }
    }
    return null;
  }

  function translate(text, el) {
    if (!HANGUL.test(text)) return null;
    let ctx = null;
    let ctxKey = "";
    if (el) {
      for (const [sel, map] of CONTEXT) {
        if (el.closest(sel)) {
          ctx = { ...(ctx || {}), ...map };
          ctxKey += sel;
        }
      }
    }
    const key = ctxKey + "\u0000" + text;
    if (cache.has(key)) return cache.get(key);
    if (cache.size > 4000) cache.clear(); // 매 프레임 바뀌는 숫자 글이 계속 쌓이지 않게
    if (missing.size > 500) missing.clear();
    const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const out = core(m[2], ctx);
    const result = out == null ? null : m[1] + out + m[3];
    if (out == null) missing.add(m[2]);
    cache.set(key, result);
    return result;
  }

  // ---------- 화면에 적용 ----------
  const ATTRS = ["title", "aria-label", "placeholder", "alt"];
  const textRec = new WeakMap(); // 글자 노드 → { ko, en }
  const attrRec = new WeakMap(); // 요소 → { 속성: { ko, en } }
  const blockRec = new WeakMap(); // 요소 → { ko(innerHTML), en(innerHTML) }
  let lang = "ko";

  function skip(el) {
    return !el || el.closest("script, style, [data-i18n-skip]");
  }

  function doText(node) {
    const el = node.parentElement;
    if (skip(el)) return;
    const value = node.nodeValue;
    const rec = textRec.get(node);
    if (rec && rec.en === value) return; // 방금 내가 바꾼 것
    const en = translate(value, el);
    if (en == null) {
      textRec.delete(node);
      return;
    }
    textRec.set(node, { ko: value, en });
    node.nodeValue = en;
  }

  function doAttrs(el) {
    if (skip(el)) return;
    for (const name of ATTRS) {
      const value = el.getAttribute(name);
      if (value == null) continue;
      const recs = attrRec.get(el) || {};
      if (recs[name] && recs[name].en === value) continue;
      const en = translate(value, el);
      if (en == null) continue;
      recs[name] = { ko: value, en };
      attrRec.set(el, recs);
      el.setAttribute(name, en);
    }
  }

  function doBlock(el) {
    const text = el.textContent.replace(/\s+/g, " ").trim();
    if (!HANGUL.test(text)) return false;
    for (const [re, make] of BLOCKS) {
      const m = text.match(re);
      if (!m) continue;
      const ko = el.innerHTML;
      const en = make(m, self);
      blockRec.set(el, { ko, en });
      el.innerHTML = en;
      return true;
    }
    return false;
  }

  function doTree(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      const block = root.parentElement && root.parentElement.closest(BLOCK_SELECTOR);
      if (block && doBlock(block)) return;
      return doText(root);
    }
    if (root.nodeType !== Node.ELEMENT_NODE || skip(root)) return;
    const blocks = [...(root.matches(BLOCK_SELECTOR) ? [root] : []), ...root.querySelectorAll(BLOCK_SELECTOR)];
    const up = root.closest(BLOCK_SELECTOR);
    if (up && !blocks.includes(up)) blocks.push(up);
    blocks.forEach(doBlock);
    doAttrs(root);
    root.querySelectorAll("[title], [aria-label], [placeholder], [alt]").forEach(doAttrs);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(doText);
  }

  const observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "characterData") doTree(m.target);
      else if (m.type === "attributes") doAttrs(m.target);
      else m.addedNodes.forEach(doTree);
    }
  });

  function restoreKorean() {
    document.querySelectorAll(BLOCK_SELECTOR).forEach((el) => {
      const rec = blockRec.get(el);
      if (rec && el.innerHTML === rec.en) el.innerHTML = rec.ko;
    });
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const rec = textRec.get(node);
      if (rec && node.nodeValue === rec.en) node.nodeValue = rec.ko;
      textRec.delete(node);
    }
    document.querySelectorAll("[title], [aria-label], [placeholder], [alt]").forEach((el) => {
      const recs = attrRec.get(el);
      if (!recs) return;
      for (const [name, rec] of Object.entries(recs)) if (el.getAttribute(name) === rec.en) el.setAttribute(name, rec.ko);
      attrRec.delete(el);
    });
  }

  function setLanguage(next) {
    lang = next === "en" ? "en" : "ko";
    document.documentElement.lang = lang;
    document.body.classList.toggle("is-lang-en", lang === "en");
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      // 저장을 못 쓰는 환경이면 이번에만 적용
    }
    observer.disconnect();
    if (lang === "en") {
      doTree(document.body);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    } else {
      restoreKorean();
    }
    const btn = document.getElementById("lang-btn");
    if (btn) {
      btn.textContent = lang === "en" ? "한" : "EN";
      btn.title = btn.ariaLabel = lang === "en" ? "한국어로 보기" : "View in English";
    }
    document.dispatchEvent(new CustomEvent("languagechange", { detail: { lang } }));
  }
  // 화면 글자가 아닌 곳(3D 지도 안에 그리는 이름표 등)에서 쓰는 번역: 영어 모드일 때만 영어로
  window.i18nText = (text) => (lang === "en" && text ? translate(String(text), null) ?? text : text);
  window.setLanguage = setLanguage;
  window.getLanguage = () => lang;

  const btn = document.getElementById("lang-btn");
  if (btn) btn.addEventListener("click", () => setLanguage(lang === "en" ? "ko" : "en"));

  let initial = new URLSearchParams(location.search).get("lang");
  if (!initial) {
    try {
      initial = localStorage.getItem(LANG_KEY);
    } catch {
      initial = null;
    }
  }
  setLanguage(initial === "ko" ? "ko" : "en"); // 기본은 영어. 한국어는 버튼으로 고르거나 ?lang=ko
})();
