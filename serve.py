"""
marsmother 개발용 로컬 서버

    python3 serve.py          # http://127.0.0.1:8000
    python3 serve.py 8080     # 포트 지정

`python3 -m http.server` 대신 이걸 쓰는 이유
  1) 캐시 끔: 파일을 고친 뒤 일반 새로고침(⌘R)만 해도 바로 반영됨
  2) 연결 대기열을 늘림: 기본 서버는 대기열이 5개라 HUD 타일 · DEM 처럼 파일을 한꺼번에 많이 받으면
     연결이 끊기고(ERR_CONNECTION_RESET) 스크립트가 빠져 화면이 깨질 수 있음
"""
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass  # 요청마다 찍히는 로그 끔


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with Server(("127.0.0.1", port), NoCacheHandler) as httpd:
        print(f"Mars Mother → http://127.0.0.1:{port}  (끄려면 Ctrl+C)")
        httpd.serve_forever()
