#!/usr/bin/env python3
import http.server, socketserver

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

PORT = 8080
with socketserver.TCPServer(('', PORT), NoCacheHandler) as httpd:
    print(f'http://localhost:{PORT}')
    httpd.serve_forever()
