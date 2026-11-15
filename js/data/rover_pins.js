// 자동 생성 파일 — 직접 고치지 말고 preprocess/build_rover_photos.py 를 다시 실행
// Spirit 경로 위 사진 핀 (data/spirit/spirit_pin.json). 사진: NASA Photojournal Pancam / Navcam
// lon/lat: corrected_x/y 를 spirit.js 와 같은 기준점(sol 36)으로 옮긴 값
const ROVER_PINS = [
 {
  "id": 1,
  "name": "Columbia Memorial Station (착륙지)",
  "site": 3,
  "drive": 27,
  "startSol": 15,
  "endSol": 16,
  "lon": 175.477951,
  "lat": -14.571504,
  "photos": [
   {
    "camera": "Pancam",
    "id": "PIA05117",
    "sol": "16",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA05117",
    "note": null,
    "src": "assets/rover/pin1_pancam.jpg",
    "thumb": "assets/rover/pin1_pancam-thumb.jpg",
    "color": true,
    "width": 4973,
    "height": 3507
   },
   {
    "camera": "Navcam",
    "id": "PIA05091",
    "sol": "~12 (2004-01-16 공개)",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA05091",
    "note": "착륙선 옆, 정확한 sol 미확인",
    "src": "assets/rover/pin1_navcam.jpg",
    "thumb": "assets/rover/pin1_navcam-thumb.jpg",
    "color": false,
    "width": 4713,
    "height": 4713
   }
  ],
  "elevM": -1938.9
 },
 {
  "id": 2,
  "name": "Bonneville 크레이터 가장자리",
  "site": 18,
  "drive": 0,
  "startSol": 67,
  "endSol": 70,
  "lon": 175.48186,
  "lat": -14.568241,
  "photos": [
   {
    "camera": "Pancam",
    "id": "PIA05968",
    "sol": "68",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA05968",
    "note": null,
    "src": "assets/rover/pin2_pancam.jpg",
    "thumb": "assets/rover/pin2_pancam-thumb.jpg",
    "color": true,
    "width": 6000,
    "height": 849
   },
   {
    "camera": "Navcam",
    "id": "PIA05576",
    "sol": "67",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA05576",
    "note": null,
    "src": "assets/rover/pin2_navcam.jpg",
    "thumb": "assets/rover/pin2_navcam-thumb.jpg",
    "color": true,
    "width": 6000,
    "height": 2093
   }
  ],
  "elevM": -1935.6
 },
 {
  "id": 3,
  "name": "Missoula 크레이터",
  "site": 31,
  "drive": 0,
  "startSol": 105,
  "endSol": 107,
  "lon": 175.486447,
  "lat": -14.57247,
  "photos": [
   {
    "camera": "Pancam",
    "id": "Missoula Panorama",
    "sol": "106",
    "source": "ASU Pancam team",
    "page": "https://pancam.sese.asu.edu/missoula_new.html",
    "note": null
   },
   {
    "camera": "Navcam",
    "id": "PIA05808",
    "sol": "107",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA05808",
    "note": "site 32에서 촬영, 핀에서 약 65 m 떨어짐",
    "src": "assets/rover/pin3_navcam.jpg",
    "thumb": "assets/rover/pin3_navcam-thumb.jpg",
    "color": false,
    "width": 6000,
    "height": 831
   }
  ],
  "elevM": -1935.5
 },
 {
  "id": 4,
  "name": "Larry's Lookout",
  "site": 108,
  "drive": 0,
  "startSol": 409,
  "endSol": 414,
  "lon": 175.524708,
  "lat": -14.590257,
  "photos": [
   {
    "camera": "Pancam",
    "id": "PIA07882",
    "sol": "410-413",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA07882",
    "note": null,
    "src": "assets/rover/pin4_pancam.jpg",
    "thumb": "assets/rover/pin4_pancam-thumb.jpg",
    "color": true,
    "width": 6000,
    "height": 1073
   },
   {
    "camera": "Navcam",
    "id": "PIA07408",
    "sol": "409",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA07408",
    "note": null,
    "src": "assets/rover/pin4_navcam.jpg",
    "thumb": "assets/rover/pin4_navcam-thumb.jpg",
    "color": true,
    "width": 6000,
    "height": 2103
   }
  ],
  "elevM": -1881.2
 },
 {
  "id": 5,
  "name": "Husband Hill 정상",
  "site": 114,
  "drive": 3,
  "startSol": 583,
  "endSol": 589,
  "lon": 175.527028,
  "lat": -14.593037,
  "photos": [
   {
    "camera": "Pancam",
    "id": "PIA03610",
    "sol": "583-586",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA03610",
    "note": null,
    "src": "assets/rover/pin5_pancam.jpg",
    "thumb": "assets/rover/pin5_pancam-thumb.jpg",
    "color": true,
    "width": 6000,
    "height": 1758
   },
   {
    "camera": "Navcam",
    "id": "PIA04194",
    "sol": "581",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA04194",
    "note": "site 113에서 촬영, 약 16 m 떨어짐",
    "src": "assets/rover/pin5_navcam.jpg",
    "thumb": "assets/rover/pin5_navcam-thumb.jpg",
    "color": false,
    "width": 1024,
    "height": 1024
   }
  ],
  "elevM": -1856.1
 },
 {
  "id": 6,
  "name": "Home Plate 북서쪽 가장자리",
  "site": 124,
  "drive": 99,
  "startSol": 747,
  "endSol": 747,
  "lon": 175.529615,
  "lat": -14.605319,
  "photos": [
   {
    "camera": "Pancam",
    "id": "PIA02690",
    "sol": "748-751",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA02690",
    "note": null,
    "src": "assets/rover/pin6_pancam.jpg",
    "thumb": "assets/rover/pin6_pancam-thumb.jpg",
    "color": true,
    "width": 6000,
    "height": 2384
   },
   {
    "camera": "Navcam",
    "id": "PIA02399",
    "sol": "746, 748, 750",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA02399",
    "note": null,
    "src": "assets/rover/pin6_navcam.jpg",
    "thumb": "assets/rover/pin6_navcam-thumb.jpg",
    "color": false,
    "width": 6000,
    "height": 1243
   }
  ],
  "elevM": -1916.9
 },
 {
  "id": 7,
  "name": "Low Ridge (2006 겨울 정박지)",
  "site": 128,
  "drive": 0,
  "startSol": 880,
  "endSol": 1010,
  "lon": 175.530722,
  "lat": -14.606743,
  "photos": [
   {
    "camera": "Pancam",
    "id": "PIA01907",
    "sol": "814-932",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA01907",
    "note": "원본 JPEG 28 MB",
    "src": "assets/rover/pin7_pancam.jpg",
    "thumb": "assets/rover/pin7_pancam-thumb.jpg",
    "color": true,
    "width": 6000,
    "height": 1549
   },
   {
    "camera": "Navcam",
    "id": "PIA08497",
    "sol": "807",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA08497",
    "note": "Navcam(sol 807)과 Pancam(sol 835)을 합성한 모자이크",
    "src": "assets/rover/pin7_navcam.jpg",
    "thumb": "assets/rover/pin7_navcam-thumb.jpg",
    "color": false,
    "width": 6000,
    "height": 2885
   }
  ],
  "elevM": -1914.9
 },
 {
  "id": 8,
  "name": "Troy (마지막 정지 지점)",
  "site": 137,
  "drive": 178,
  "startSol": 1891,
  "endSol": 1892,
  "lon": 175.529192,
  "lat": -14.60604,
  "photos": [
   {
    "camera": "Pancam",
    "id": "PIA12078",
    "sol": "1892",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA12078",
    "note": null,
    "src": "assets/rover/pin8_pancam.jpg",
    "thumb": "assets/rover/pin8_pancam-thumb.jpg",
    "color": true,
    "width": 1019,
    "height": 1024
   },
   {
    "camera": "Navcam",
    "id": "PIA12142",
    "sol": "1891",
    "source": "NASA Photojournal",
    "page": "https://photojournal.jpl.nasa.gov/catalog/PIA12142",
    "note": null,
    "src": "assets/rover/pin8_navcam.jpg",
    "thumb": "assets/rover/pin8_navcam-thumb.jpg",
    "color": false,
    "width": 5712,
    "height": 1067
   }
  ],
  "elevM": -1917.0
 }
];
