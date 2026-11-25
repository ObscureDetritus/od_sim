#!/usr/bin/env python3
"""World Eater shared store: one world (heading, intro, numbered facts) that every visitor sees.

Python standard library only. Run it behind an HTTPS proxy (Caddy) on the Contabo server.

  GET  /world            -> {"rev", "title", "intro", "facts": [{"id", "text"}]}
  GET  /world?since=REV  -> 204 if nothing changed since REV, else the world as above
  GET  /world.md         -> the world as markdown (what agents read)
  GET  /health           -> {"ok", "rev", "locked", "public_add"}
  GET  /auth             -> 200 if header X-World-Key is right (or no key is set), else 401
  POST /world/ops        -> apply one edit, returns the new world.
                            With no WORLD_KEY anyone may make any edit. Without the key every edit is
                            rate-limited per visitor and each text is capped at 1000 characters.
                            With WORLD_KEY set, only "add" stays open (if WORLD_PUBLIC_ADD), the rest need the key.
       {"op": "add",     "text": "..."}
       {"op": "edit",    "id": "...", "text": "..."}
       {"op": "remove",  "id": "..."}
       {"op": "move",    "id": "...", "to": 0}
       {"op": "meta",    "title": "...", "intro": "..."}     (key holders only; either key optional)
       {"op": "replace", "facts": ["...", ...]}              (title/intro only honoured for key holders)

Environment:
  WORLD_KEY        passphrase for editing (unset = anyone can edit)
  WORLD_PUBLIC_ADD 1 (default) = anyone may add facts; 0 = adding needs the key too
  WORLD_ADD_LIMIT  adds allowed per visitor without the key: "per_minute,per_day" (default 6,60)
  WORLD_EDIT_LIMIT other edits allowed per visitor without the key (default 90,1500)

Safety: nothing a visitor sends is ever executed, evaluated, used in a file path or passed to a shell.
Text is only stored as JSON strings and returned as JSON or plain markdown.
  WORLD_DATA       path of the JSON store (default ./data/world.json)
  WORLD_ORIGINS    comma-separated origins allowed by CORS
  WORLD_HOST/PORT  listen address (default 127.0.0.1:8787)
"""
import hmac, json, os, re, secrets, tempfile, threading, time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

KEY = os.environ.get('WORLD_KEY', '')
DATA = os.environ.get('WORLD_DATA', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'world.json'))
ORIGINS = {o.strip() for o in os.environ.get(
    'WORLD_ORIGINS', 'https://od.declino.systems,http://od.declino.systems,http://localhost:8000,http://127.0.0.1:8000').split(',') if o.strip()}
HOST, PORT = os.environ.get('WORLD_HOST', '127.0.0.1'), int(os.environ.get('WORLD_PORT', '8787'))
PUBLIC_ADD = os.environ.get('WORLD_PUBLIC_ADD', '1') != '0'
LIMITS = {'add': tuple(int(x) for x in os.environ.get('WORLD_ADD_LIMIT', '6,60').split(',')),
          'edit': tuple(int(x) for x in os.environ.get('WORLD_EDIT_LIMIT', '90,1500').split(','))}
MAX_PUBLIC_TEXT = 1000

MAX_BODY, MAX_TEXT, MAX_FACTS = 64 * 1024, 4000, 2000
DEFAULT_INTRO = 'Facts every character knows about the world. A sort of collective knowledge. This is available to everyone equally when they spawn.'
lock = threading.Lock()
recent = defaultdict(deque)   # (visitor, kind) -> times of their edits in the last day
rate_lock = threading.Lock()


def allow(who, kind):
    per_min, per_day = LIMITS[kind]
    now = time.time()
    with rate_lock:
        q = recent[(who, kind)]
        while q and q[0] < now - 86400:
            q.popleft()
        if len(q) >= per_day or sum(1 for t in q if t > now - 60) >= per_min:
            return False
        q.append(now)
        if len(recent) > 20000:   # forget idle visitors so memory stays small
            for k in [k for k, v in recent.items() if not v or v[-1] < now - 86400]:
                del recent[k]
    return True


def check_public_sizes(op):
    texts = [op.get('text'), op.get('intro')] + (op['facts'] if isinstance(op.get('facts'), list) else [])
    if any(isinstance(t, str) and len(t) > MAX_PUBLIC_TEXT for t in texts):
        raise Bad(f'each text is limited to {MAX_PUBLIC_TEXT} characters')


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
        if 'title' in op:
            w['title'] = text_of(op['title'], 200)
        if 'intro' in op:
            w['intro'] = text_of(op['intro'], MAX_TEXT)
        w['facts'] = [{'id': secrets.token_hex(6), 'text': t} for t in (text_of(x).strip() for x in new) if t]
    else:
        raise Bad('unknown op')
    w['rev'] += 1


class Handler(BaseHTTPRequestHandler):
    server_version = 'WorldEater/1'
    timeout = 15   # drop connections that stall

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
            return self.reply(200, {'ok': True, 'rev': w['rev'], 'locked': bool(KEY), 'public_add': PUBLIC_ADD})
        if url.path == '/auth':   # lets the page check a key before showing edit controls
            ok = not KEY or hmac.compare_digest(self.headers.get('X-World-Key', '').encode(), KEY.encode())
            return self.reply(200 if ok else 401, {'ok': ok})
        self.reply(404, {'error': 'not found'})

    def do_POST(self):
        if urlsplit(self.path).path != '/world/ops':
            return self.reply(404, {'error': 'not found'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = -1
        if n <= 0 or n > MAX_BODY:
            return self.reply(413, {'error': 'body too large or empty'})
        try:
            op = json.loads(self.rfile.read(n))
            if not isinstance(op, dict):
                raise Bad('body must be an object')
            keyed = bool(KEY) and hmac.compare_digest(self.headers.get('X-World-Key', '').encode(), KEY.encode())
            if not keyed:   # everyone without a key: open edits, but capped and rate-limited
                kind = 'add' if op.get('op') == 'add' else 'edit'
                if KEY and not (PUBLIC_ADD and kind == 'add'):
                    return self.reply(401, {'error': 'wrong or missing key'})
                if op.get('op') == 'meta':   # heading and intro are read-only for visitors
                    return self.reply(403, {'error': 'the heading and intro are read-only'})
                op.pop('title', None)
                op.pop('intro', None)
                check_public_sizes(op)
                if not allow(self.visitor(), kind):
                    return self.reply(429, {'error': 'Too many changes at once. Try again in a minute.'})
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

    def visitor(self):
        # behind Caddy every request comes from 127.0.0.1; Caddy puts the real address in X-Forwarded-For
        ip = self.client_address[0]
        if ip in ('127.0.0.1', '::1'):
            ip = (self.headers.get('X-Forwarded-For', '').split(',')[0].strip() or ip)
        return ip

    def log_message(self, fmt, *args):
        print(f'{self.address_string()} {fmt % args}', flush=True)


if __name__ == '__main__':
    print(f'World Eater API on http://{HOST}:{PORT}  key={"set" if KEY else "OFF (open editing)"}  data={DATA}', flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
