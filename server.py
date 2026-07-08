#!/usr/bin/env python3
# innerFace dev server.
# - Serves the static app with caching disabled (edits show on plain reload).
# - POST /api/agent: relays a prompt to a local coding agent CLI (claude -p)
#   and returns its reply. The agent harness keeps its own conversation
#   memory via --continue. Bound to localhost only.
import http.server
import json
import os
import subprocess

PORT = 8137
AGENT_TIMEOUT = 600   # seconds — agent turns can legitimately take minutes

VOICE_INSTRUCTIONS = (
    'Your final reply is spoken aloud by a voice interface. After doing the '
    'work, reply conversationally in a few short sentences — plain spoken '
    'English, no markdown, no code blocks, no bullet lists. Summarize what '
    'you did or found; never read code aloud.'
)


def run_agent(prompt):
    """Run the coding agent; returns (text, error). Tries to continue the
    agent's most recent conversation, falls back to starting fresh."""
    base = [
        'claude', '-p', prompt,
        '--output-format', 'json',
        '--append-system-prompt', VOICE_INSTRUCTIONS,
    ]
    cwd = os.environ.get('AGENT_CWD') or None
    proc = None
    for args in (base + ['--continue'], base):
        try:
            proc = subprocess.run(
                args, capture_output=True, text=True,
                timeout=AGENT_TIMEOUT, cwd=cwd,
            )
        except FileNotFoundError:
            return None, 'claude CLI not found on PATH'
        except subprocess.TimeoutExpired:
            return None, 'agent timed out after %ds' % AGENT_TIMEOUT
        if proc.returncode == 0:
            try:
                data = json.loads(proc.stdout)
                return data.get('result') or '(the agent finished but said nothing)', None
            except json.JSONDecodeError:
                return proc.stdout.strip() or '(empty reply)', None
        # non-zero: loop once more without --continue (no prior conversation)
    err = (proc.stderr or proc.stdout or 'agent failed').strip()
    return None, err[:500]


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/api/agent':
            return self._json(404, {'error': 'not found'})
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length) or b'{}')
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {'error': 'bad request body'})
        prompt = (body.get('prompt') or '').strip()
        if not prompt:
            return self._json(400, {'error': 'empty prompt'})
        text, err = run_agent(prompt)
        if err is not None:
            return self._json(502, {'error': err})
        return self._json(200, {'text': text})


if __name__ == '__main__':
    print(f'innerFace dev server → http://localhost:{PORT}')
    print(f'agent cwd: {os.environ.get("AGENT_CWD") or os.getcwd()}')
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
