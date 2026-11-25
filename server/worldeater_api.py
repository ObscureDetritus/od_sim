#!/usr/bin/env python3
"""World Eater shared store: one world (heading, intro, numbered facts) that every visitor sees.

Python standard library only. Run it behind an HTTPS proxy (Caddy) on the Contabo server.

  GET  /world            -> {"rev", "title", "intro", "facts": [{"id", "text"}]}
  GET  /world?since=REV  -> 204 if nothing changed since REV, else the world as above
  GET  /world.md         -> the world as markdown (what agents read)
  GET  /health           -> {"ok", "rev", "locked"}
  GET  /auth             -> 200 if header X-World-Key is right (or no key is set), else 401
  POST /world/ops        -> apply one edit, returns the new world. Needs header X-World-Key if WORLD_KEY is set.
       {"op": "add",     "text": "..."}
       {"op": "edit",    "id": "...", "text": "..."}
       {"op": "remove",  "id": "..."}
       {"op": "move",    "id": "...", "to": 0}
       {"op": "meta",    "title": "...", "intro": "..."}     (either key optional)
       {"op": "replace", "title": "...", "intro": "...", "facts": ["...", ...]}

Environment:
  WORLD_KEY        passphrase for editing (unset = anyone can edit)
  WORLD_DATA       path of the JSON store (default ./data/world.json)
  WORLD_ORIGINS    comma-separated origins allowed by CORS
  WORLD_HOST/PORT  listen address (default 127.0.0.1:8787)
"""
import hmac, json, os, re, secrets, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

KEY = os.environ.get('WORLD_KEY', '')
DATA = os.environ.get('WORLD_DATA', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'world.json'))
ORIGINS = {o.strip() for o in os.environ.get(
    'WORLD_ORIGINS', 'https://od.declino.systems,http://od.declino.systems,http://localhost:8000,http://127.0.0.1:8000').split(',') if o.strip()}
HOST, PORT = os.environ.get('WORLD_HOST', '127.0.0.1'), int(os.environ.get('WORLD_PORT', '8787'))

MAX_BODY, MAX_TEXT, MAX_FACTS = 256 * 1024, 4000, 2000
DEFAULT_INTRO = 'Collective knowledge: facts every agent already knows before arriving in the play.'
lock = threading.Lock()


def load():
    try:
        with open(DATA, encoding='utf-8') as f:
            w = json.load(f)
        if isinstance(w.get('facts'), list):
            return w
    except (OSError, ValueError):
        pass
    return {'rev': 0, 'title': 'WORLD', 'intro': DEFAULT_INTRO, 'facts': []}


def save(w):
    os.makedirs(os.path.dirname(DATA), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(DATA), suffix='.tmp')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(w, f, ensure_ascii=False, indent=1)
    os.replace(tmp, DATA)   # atomic: a crash never leaves a half-written world


WORLD = load()


def to_markdown(w):
    lines = [f"# {w['title'].strip() or 'WORLD'}", '']
    if w['intro'].strip():
        lines += [w['intro'].strip(), '']
    for i, f in enumerate(w['facts']):
        lead = f'{i + 1}. '
        lines.append(lead + f['text'].strip().replace('\r', '').replace('\n', '\n' + ' ' * len(lead)))
    return '\n'.join(lines).rstrip('\n') + '\n'


class Bad(Exception):
    pass


def text_of(v, limit=MAX_TEXT):
    if not isinstance(v, str):
        raise Bad('text must be a string')
    v = v.replace('\r', '')
    if len(v) > limit:
        raise Bad(f'text longer than {limit} characters')
    return v


def find(w, fid):
    for i, f in enumerate(w['facts']):
        if f['id'] == fid:
            return i
    raise Bad('no such fact')   # already removed by someone else


def apply(w, op):
    kind = op.get('op')
    facts = w['facts']
    if kind == 'add':
        t = text_of(op.get('text')).strip()
        if not t:
            raise Bad('empty fact')
        if len(facts) >= MAX_FACTS:
            raise Bad('too many facts')
        fid = op.get('id')   # the page picks the id so it can keep editing the fact before the reply arrives
        if not (isinstance(fid, str) and re.fullmatch(r'[0-9a-z]{4,24}', fid)) or any(f['id'] == fid for f in facts):
            fid = secrets.token_hex(6)
        facts.append({'id': fid, 'text': t})
    elif kind == 'edit':
        facts[find(w, op.get('id'))]['text'] = text_of(op.get('text'))
    elif kind == 'remove':
        facts.pop(find(w, op.get('id')))
    elif kind == 'move':
        f = facts.pop(find(w, op.get('id')))
        to = op.get('to')
        if not isinstance(to, int):
            raise Bad('to must be a number')
        facts.insert(max(0, min(to, len(facts))), f)
    elif kind == 'meta':
        if 'title' in op:
            w['title'] = text_of(op['title'], 200)
        if 'intro' in op:
            w['intro'] = text_of(op['intro'], MAX_TEXT)
    elif kind == 'replace':
        new = op.get('facts')
        if not isinstance(new, list) or len(new) > MAX_FACTS:
            raise Bad('facts must be a list')
        w['title'] = text_of(op.get('title', 'WORLD'), 200)
        w['intro'] = text_of(op.get('intro', ''), MAX_TEXT)
        w['facts'] = [{'id': secrets.token_hex(6), 'text': t} for t in (text_of(x).strip() for x in new) if t]
    else:
        raise Bad('unknown op')
    w['rev'] += 1


class Handler(BaseHTTPRequestHandler):
    server_version = 'WorldEater/1'

    def cors(self):
        origin = self.headers.get('Origin', '')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')

    def reply(self, code, body=b'', ctype='application/json; charset=utf-8'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.cors()
        self.send_header('Cache-Control', 'no-store')
        if code != 204:
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if code != 204:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-World-Key')
        self.send_header('Access-Control-Max-Age', '86400')
        self.end_headers()

    def do_GET(self):
        url = urlsplit(self.path)
        with lock:
            w = json.loads(json.dumps(WORLD))
        if url.path == '/world':
            since = parse_qs(url.query).get('since', [''])[0]
            if since.isdigit() and int(since) == w['rev']:
                return self.reply(204)
            return self.reply(200, w)
        if url.path == '/world.md':
            return self.reply(200, to_markdown(w), 'text/markdown; charset=utf-8')
        if url.path == '/health':
            return self.reply(200, {'ok': True, 'rev': w['rev'], 'locked': bool(KEY)})
        if url.path == '/auth':   # lets the page check a key before showing edit controls
            ok = not KEY or hmac.compare_digest(self.headers.get('X-World-Key', '').encode(), KEY.encode())
            return self.reply(200 if ok else 401, {'ok': ok})
        self.reply(404, {'error': 'not found'})

    def do_POST(self):
        if urlsplit(self.path).path != '/world/ops':
            return self.reply(404, {'error': 'not found'})
        if KEY and not hmac.compare_digest(self.headers.get('X-World-Key', '').encode(), KEY.encode()):
            return self.reply(401, {'error': 'wrong or missing key'})
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BODY:
            return self.reply(413, {'error': 'body too large or empty'})
        try:
            op = json.loads(self.rfile.read(n))
            if not isinstance(op, dict):
                raise Bad('body must be an object')
            with lock:
                trial = json.loads(json.dumps(WORLD))
                apply(trial, op)
                save(trial)
                WORLD.clear()
                WORLD.update(trial)
                w = json.loads(json.dumps(WORLD))
        except ValueError:
            return self.reply(400, {'error': 'invalid JSON'})
        except Bad as e:
            with lock:
                w = json.loads(json.dumps(WORLD))
            return self.reply(409, {'error': str(e), 'world': w})
        self.reply(200, w)

    def log_message(self, fmt, *args):
        print(f'{self.address_string()} {fmt % args}', flush=True)


if __name__ == '__main__':
    print(f'World Eater API on http://{HOST}:{PORT}  key={"set" if KEY else "OFF (open editing)"}  data={DATA}', flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
