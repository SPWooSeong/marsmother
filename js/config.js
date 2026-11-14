// Mars Mother - 외부 서비스 설정
// Cesium ion 토큰 (3D 화성 지형 Mars 3D Tiles 를 불러올 때 사용)
// ⚠️ 브라우저에서 쓰는 토큰이라 페이지를 여는 사람은 누구나 볼 수 있음.
//    Cesium ion 대시보드 → Access Tokens 에서 "Allowed URLs" 로 사용할 주소를 제한해 두는 것을 권장.
const CESIUM_ION_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjQ5NXdDbDNCem9TRXNsc00iLCJqdGkiOiIyNjQ2ZGNlYS00NWM1LTQ1NzgtOTM3ZC1kYjhkNjg0MWIyMGMiLCJpZCI6NTMwMTkyLCJzdWIiOiJNQVJTTU9USEVSIiwiaXNzIjoiaHR0cHM6Ly9hcGkuY2VzaXVtLmNvbSIsImF1ZCI6Ik5BU0EgTWFycyBtYXAiLCJpYXQiOjE3OTI0MTU1ODh9.0-f0Eo9DYlKQyppM5szU2aMdRmd7WmJx7jyEraIrx_4";

// Cesium ion 의 화성 전체 3D 지형 (NASA, ESA, USGS Astrogeology)
const MARS_TILESET_ASSET_ID = 3644333;
