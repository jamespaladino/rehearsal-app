#!/usr/bin/env python3
"""Local development server for Rehearsal and the Speech Recognition Lab.

Serves the repository root (not just speech-lab/) with caching disabled, so the
browser always loads the current HTML, CSS and JavaScript. Python's plain
`http.server` sends no cache headers, and browsers then reuse stale scripts after
edits (for example, a new sidebar button whose click handler is missing).

    python3 speech-lab/serve.py            # http://localhost:8000/
    python3 speech-lab/serve.py 8010       # another port
"""

import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def list_directory(self, path):
        folder = os.path.normpath(path)
        if folder in {os.path.join(ROOT, "speech-lab"), os.path.join(ROOT, "script-import")}:
            self.send_error(404)
            return None
        return super().list_directory(path)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Serving {ROOT} at http://localhost:{port}/ (caching disabled). Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
