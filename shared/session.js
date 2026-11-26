/* Shared Session Store for the Obscure Detritus Toolkit.
   Connects World Eater, MapGen, Soul Moulder, Director, and Play via localStorage
   plus full .odsession.json import/export. Zero API keys are ever stored in session exports. */
(function (global) {
  'use strict';

  const SESSION_KEY = 'od.session.v1';
  const API_KEY_STORAGE = 'od.play.api.v1';

  const MAP_TYPES = ['empty', 'wall', 'floor', 'door', 'corridor', 'stairs'];
  const MAP_CANON = { empty: ' ', wall: '#', floor: '.', door: '+', corridor: ':', stairs: '%' };
  const CANON_TO_IDX = { ' ': 0, '#': 1, '.': 2, '+': 3, ':': 4, '%': 5 };

  function rid(prefix = '') {
    return (prefix ? prefix + '_' : '') + Math.random().toString(16).slice(2, 10);
  }

  function defaultDirector() {
    return {
      acts: ['Act I: The Calibration', 'Act II: The Incursion', 'Act III: The Dissolution'],
      cycleNumber: 14,
      eschatonTicks: 100,
      maxAgentsPerTick: 3,
      presenceEngine: true,
      narratorEnabled: true,
      epilogueEnabled: true,
      narratorDirective:
        'Omniscient architectural chronicler embedded in the container. Frame scenes with stark spatial clarity, track status friction, and synthesize each tick in 2-3 crisp sentences.',
      quickEvents: [
        { label: 'Artifact Manifests', text: 'An unlabeled magnetic tape cartridge covered in salt appears at the threshold.' },
        { label: 'Apophenia Outbreak', text: 'A recurring numerical pattern is detected in the clockwork ticks and scratched onto the nearest wall.' },
        { label: 'Clock Stutter (-20)', text: 'The central escapement stutters violently; the countdown skips 20 ticks ahead.' },
        { label: 'Storyteller Challenge', text: 'One entity begins narrating a fragment of the extinct outside world, subverting authority.' },
        { label: 'Ring Eschaton Bell', text: '[THE ESCHATON BELL TOLLS] The countdown hits zero. Civilizational cycle collapses; reset initiated.' }
      ]
    };
  }

  function defaultMap() {
    // 16x12 chamber with walls, floor, door, corridor, stairs, and sample abstract objects
    const w = 16, h = 12;
    const rows = [
      '                ',
      '  ############  ',
      '  #..........#  ',
      '  #....##....#  ',
      '  #....+.....#  ',
      '  #..........#  ',
      '  #..........#  ',
      '  ####+#######  ',
      '      ::::      ',
      '      :##%      ',
      '                ',
      '                '
    ];
    const cells = new Array(w * h).fill(0);
    for (let y = 0; y < h; y++) {
      const r = rows[y] || '';
      for (let x = 0; x < w; x++) {
        cells[y * w + x] = CANON_TO_IDX[r[x]] ?? 0;
      }
    }
    return {
      w,
      h,
      cells,
      objects: [
        { id: 'obj_clock', x: 7, y: 4, name: 'chronometer', glyph: 'C', walkable: false, pickable: false, interactive: true, description: 'Al-Jazari brass automaton clock counting down to the Eschaton.' },
        { id: 'obj_table', x: 4, y: 3, name: 'scriptorium table', glyph: 'T', walkable: false, pickable: false, interactive: true, description: 'Ink-stained desk covered in apophenia charts.' },
        { id: 'obj_book', x: 4, y: 4, name: 'ledger book', glyph: 'B', walkable: true, pickable: true, interactive: true, description: 'Bound ledger of prior cycle anomalies.' },
        { id: 'obj_tape', x: 11, y: 6, name: 'salt tape', glyph: 'S', walkable: true, pickable: true, interactive: true, description: 'Water-damaged magnetic tape cartridge covered in salt.' }
      ]
    };
  }

  function blankSession() {
    return {
      version: 1,
      name: 'Untitled Session',
      updatedAt: new Date().toISOString(),
      map: null,
      souls: {}, // { [entityId]: { id, markdown, data, enabled: true, spawn: {x, y} | null } }
      world: {
        title: 'WORLD',
        intro: 'Facts every character knows about the world. A sort of collective knowledge. This is available to everyone equally when they spawn.',
        facts: []
      },
      director: defaultDirector()
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const base = blankSession();
          return {
            ...base,
            ...parsed,
            world: { ...base.world, ...(parsed.world || {}) },
            director: { ...base.director, ...(parsed.director || {}) },
            souls: parsed.souls && typeof parsed.souls === 'object' ? parsed.souls : {}
          };
        }
      }
    } catch {}
    return blankSession();
  }

  function save(session) {
    session.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (e) {
      console.warn('ODSession save failed:', e);
    }
    return session;
  }

  function update(mutator) {
    const s = load();
    mutator(s);
    return save(s);
  }

  // Convert between cells[] and canonical tile strings[]
  function cellsToTiles(w, h, cells) {
    const rows = [];
    for (let y = 0; y < h; y++) {
      let r = '';
      for (let x = 0; x < w; x++) {
        r += MAP_CANON[MAP_TYPES[cells[y * w + x] || 0]] || ' ';
      }
      rows.push(r);
    }
    return rows;
  }

  function tilesToCells(tiles, w, h) {
    const hh = h || tiles.length;
    const ww = w || Math.max(1, ...tiles.map(r => r.length));
    const cells = new Array(ww * hh).fill(0);
    for (let y = 0; y < hh; y++) {
      const row = tiles[y] || '';
      for (let x = 0; x < ww; x++) {
        cells[y * ww + x] = CANON_TO_IDX[row[x]] ?? 0;
      }
    }
    return { w: ww, h: hh, cells };
  }

  function normalizeMap(raw) {
    if (!raw) return null;
    let w = raw.w || raw.width || 16;
    let h = raw.h || raw.height || 16;
    let cells = raw.cells;
    if (!Array.isArray(cells) && Array.isArray(raw.tiles)) {
      const conv = tilesToCells(raw.tiles, w, h);
      w = conv.w; h = conv.h; cells = conv.cells;
    }
    if (!Array.isArray(cells)) return null;
    const objects = Array.isArray(raw.objects)
      ? raw.objects.map(o => ({
          id: o.id || rid('obj'),
          x: Number(o.x) | 0,
          y: Number(o.y) | 0,
          floor: Number(o.floor || 0) | 0,
          name: String(o.name || 'object').trim() || 'object',
          glyph: String(o.glyph || (o.name ? o.name[0] : '?')).slice(0, 2).toUpperCase(),
          walkable: !!o.walkable,
          pickable: !!o.pickable,
          interactive: o.interactive !== false,
          description: String(o.description || '').trim()
        }))
      : [];
    let floors = null;
    if (raw.floors && typeof raw.floors === 'object') {
      floors = {};
      for (const [fk, fv] of Object.entries(raw.floors)) {
        if (Array.isArray(fv)) floors[fk] = fv.slice(0, w * h);
        else if (fv && Array.isArray(fv.tiles)) floors[fk] = tilesToCells(fv.tiles, w, h).cells;
      }
    }
    const activeFloor = Number(raw.activeFloor || 0) | 0;
    return { w, h, cells: cells.slice(0, w * h), objects, floors, activeFloor };
  }

  // Pull latest map from MapGen localStorage if session has none
  function getEffectiveMap(session) {
    const s = session || load();
    if (s.map && Array.isArray(s.map.cells)) return normalizeMap(s.map);
    try {
      const mg = JSON.parse(localStorage.getItem('od.mapeditor.v3'));
      if (mg && Array.isArray(mg.cells)) return normalizeMap(mg);
    } catch {}
    return defaultMap();
  }

  // Pull latest world facts from World Eater localStorage if session has none
  function getEffectiveWorld(session) {
    const s = session || load();
    if (s.world && Array.isArray(s.world.facts) && s.world.facts.length) return s.world;
    try {
      const we = JSON.parse(localStorage.getItem('od.worldeater.v2'));
      if (we && Array.isArray(we.facts)) return we;
    } catch {}
    return s.world || blankSession().world;
  }

  const DEFAULT_PALETTE = ['#c2410c', '#2563eb', '#15803d', '#a16207', '#7e22ce', '#0e7490', '#be123c', '#d4d4d4'];

  function colorForId(id) {
    let h = 0;
    const s = String(id || 'E');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return DEFAULT_PALETTE[h % DEFAULT_PALETTE.length];
  }

  // Robust Soul Markdown Parser: supports both Soul Moulder (4-space) and OD/souls/soul_*.md (2-space & inline)
  function parseSoulMarkdown(text, fallbackId = 'ENTITY') {
    const out = {
      id: '', role: '', objective: '', color: '', status: 5,
      modifiers: [], relations: [],
      origin: '', worldview: '', secrets: [],
      tone: '', include: '', exclude: '', lexicalRaw: '',
      format: 'Internal reasoning must be enclosed in <thought> tags. Speech must be plain text.',
      memories: [], actions: [], negatives: []
    };
    const fields = [];
    let cur = null, lastSub = false;
    for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
      let m;
      if ((m = raw.match(/^\*\s+\*\*(.+?):\*\*\s?(.*)$/))) {
        cur = { label: m[1].trim(), value: m[2].trim(), subs: [] };
        fields.push(cur);
        lastSub = false;
      } else if (cur && (m = raw.match(/^ {2,6}[\*\-]\s+(.*)$/))) {
        cur.subs.push(m[1].trim());
        lastSub = true;
      } else if (cur && /^ {2,6}\S/.test(raw)) {
        if (lastSub) cur.subs[cur.subs.length - 1] += '\n' + raw.trim();
        else cur.value += '\n' + raw.trim();
      } else if (/^#/.test(raw)) {
        cur = null;
      }
    }

    for (const { label, value, subs } of fields) {
      const v = value.trim();
      const low = label.toLowerCase();
      let m;
      if (low === 'entity id') out.id = v;
      else if (low === 'system role') out.role = v;
      else if (low === 'marker color' || low === 'color') out.color = v;
      else if (low.startsWith('primary objective')) out.objective = v;
      else if (low.startsWith('base status level')) out.status = Math.min(10, Math.max(1, parseInt(v, 10) || 5));
      else if (low === 'status modifiers') {
        const items = subs.length ? subs : (v ? [v] : []);
        out.modifiers = items.map(s => (m = s.match(/^([+\-−]?\d+)\s+(?:when\s+)?([\s\S]*)$/))
          ? { amt: m[1], trigger: m[2] } : { amt: '', trigger: s });
      } else if (low === 'relational dynamics') {
        const items = subs.length ? subs : (v ? [v] : []);
        out.relations = items.map(s => {
          const rm = s.match(/^\*?Target\s+\[?(.+?)\]?:\*?\s*([\s\S]*)$/i);
          return rm ? { target: rm[1].trim(), attitude: rm[2].trim() } : { target: s, attitude: '' };
        });
      } else if (low === 'origin/prior state') out.origin = v;
      else if (low === 'worldview/bias') out.worldview = v;
      else if (low.startsWith('hidden state')) {
        const items = subs.length ? subs : (v ? [v] : []);
        out.secrets = items.map(s => {
          const [a, b] = s.split(/\s+—\s+\*reveal when:\*\s*/);
          return { secret: a.trim(), reveal: (b || '').trim() };
        });
      } else if (low === 'syntax/tone') out.tone = v;
      else if (low === 'lexical constraints') {
        out.lexicalRaw = v;
        for (const s of subs) {
          if ((m = s.match(/^\*Always use:\*\s*(.*)$/i))) out.include = m[1].trim();
          else if ((m = s.match(/^\*Never use:\*\s*(.*)$/i))) out.exclude = m[1].trim();
        }
        if (!out.include && !out.exclude && v) out.include = v;
      } else if (low === 'output formatting') out.format = v;
      else if ((m = label.match(/^Memory_\d+\s*\((.*)\)$/i))) out.memories.push({ kind: m[1].trim(), text: v.replace(/^"|"$/g, '') });
      else if (low === 'permitted interactions') {
        const items = subs.length ? subs : (v ? v.split(',').map(x => x.trim()).filter(Boolean) : []);
        out.actions = items.map(s => ({ act: s }));
      } else if (low === 'negative constraints') {
        const items = subs.length ? subs : (v ? v.split(/\.\s+/).map(x => x.trim()).filter(Boolean) : []);
        out.negatives = items.map(s => ({ rule: s }));
      }
    }
    if (!out.id) out.id = fallbackId.toUpperCase();
    if (!out.color) out.color = colorForId(out.id);
    return out;
  }

  function soulToMarkdown(S) {
    const ml = v => String(v || '').trim().replace(/\r/g, '').split('\n').join('\n    ');
    const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
    const rows = (k) => (S[k] || []).filter(r => Object.values(r).some(v => String(v).trim()));
    const L = [];
    const f = (label, v) => L.push(`*   **${label}:**${String(v ?? '').trim() ? ' ' + ml(v) : ''}`);
    const sub = (s) => L.push(`    *   ${ml(s)}`);
    L.push(`# SOUL TEMPLATE: ${(S.id || '').trim() || '[Character_Name]'}`, '');
    L.push('## 1. Core Identity Definition');
    f('Entity ID', S.id); f('System Role', S.role); if ((S.color || '').trim()) f('Marker Color', S.color); f('Primary Objective Vector', S.objective);
    L.push('', '## 2. Improvisational Matrix & Status');
    f('Base Status Level (1-10)', S.status || 5);
    f('Status Modifiers', ''); rows('modifiers').forEach(r => sub((r.amt || '').trim() ? `${r.amt.trim()} when ${(r.trigger || '').trim()}` : (r.trigger || '').trim()));
    f('Relational Dynamics', ''); rows('relations').forEach(r => sub(`*Target ${(r.target || '').trim()}:* ${(r.attitude || '').trim()}`));
    L.push('', '## 3. Epistemological State (Character Bible)');
    f('Origin/Prior State', S.origin); f('Worldview/Bias', S.worldview);
    f('Hidden State (Secrets)', ''); rows('secrets').forEach(r => sub(`${(r.secret || '').trim()}${(r.reveal || '').trim() ? ` — *reveal when:* ${r.reveal.trim()}` : ''}`));
    L.push('', '## 4. Linguistic & Output Parameters');
    f('Syntax/Tone', S.tone);
    f('Lexical Constraints', '');
    if (list(S.include).length) sub(`*Always use:* ${list(S.include).join(', ')}`);
    if (list(S.exclude).length) sub(`*Never use:* ${list(S.exclude).join(', ')}`);
    f('Output Formatting', S.format);
    L.push('', '## 5. Pre-loaded Memory');
    rows('memories').forEach((r, i) => f(`Memory_${String(i + 1).padStart(2, '0')} (${(r.kind || '').trim() || 'Note'})`, r.text));
    L.push('', '## 6. Action Space & Hard Constraints');
    f('Permitted Interactions', ''); rows('actions').forEach(r => sub((r.act || '').trim()));
    f('Negative Constraints', ''); rows('negatives').forEach(r => sub((r.rule || '').trim()));
    return L.join('\n') + '\n';
  }

  function saveSoulToSession(soulData, markdown) {
    const id = String(soulData.id || '').trim().toUpperCase();
    if (!id) return null;
    const md = markdown || soulToMarkdown(soulData);
    return update(s => {
      const prev = s.souls[id] || {};
      s.souls[id] = {
        id,
        markdown: md,
        data: { ...soulData, id },
        enabled: prev.enabled !== false,
        spawn: prev.spawn || null
      };
    });
  }

  function removeSoulFromSession(id) {
    return update(s => { delete s.souls[id]; });
  }

  function saveMapToSession(mapObj) {
    const norm = normalizeMap(mapObj);
    if (!norm) return null;
    return update(s => { s.map = norm; });
  }

  function saveWorldToSession(worldObj) {
    return update(s => {
      s.world = {
        title: worldObj.title || 'WORLD',
        intro: worldObj.intro || '',
        facts: (worldObj.facts || []).map(f => typeof f === 'string' ? { id: rid('f'), text: f } : { id: f.id || rid('f'), text: f.text || '' }).filter(f => f.text.trim())
      };
    });
  }

  function starterSouls() {
    const list = [
      {
        id: 'NARRATOR', role: 'The Director / Frame Narrative Engine / Environmental Chronicler', color: '#e6e6e6', status: 10,
        objective: 'Advance the dramatic arc through Acts; frame scenes, inject environmental anomalies, and synthesize each tick into an omniscient chronicle of discipline, apophenia, and tension.',
        modifiers: [{ amt: '0', trigger: 'Invariant — operates as architectural voice and spatial director' }],
        relations: [{ target: 'ENTITIES', attitude: 'Treats all internal entities as experimental variables within the enclosure' }, { target: 'AUDIENCE', attitude: 'Silent co-conspirators observing from outside' }],
        origin: 'Embedded within the infrastructure of the room and the chronometer mechanism.',
        worldview: 'The simulation only exists when friction occurs between discipline and doubt. An Act without tension is a stalled cycle.',
        secrets: [{ secret: 'Knows the exact closing time of the cycle and the electrical limits of the container.', reveal: 'never openly declared' }],
        tone: 'Omniscient, atmospheric, detached, poetic yet crisp.', include: 'interval, shadow, escapement, Act, refraction', exclude: 'I think, maybe',
        memories: [
          { kind: 'Core Belief', text: 'Act I is The Calibration; Act II is The Incursion; Act III is The Dissolution.' },
          { kind: 'Spatial Awareness', text: 'The container compresses time around the central chronometer.' }
        ],
        actions: [{ act: 'ShiftAct(Act_Name)' }, { act: 'InjectAnomaly(Description)' }, { act: 'FrameScene(Narration)' }, { act: 'SummarizeTick(Epilogue)' }],
        negatives: [{ rule: 'Never assume physical presence inside the chamber.' }]
      },
      {
        id: 'CORVO', role: 'Perimeter Warden / Protocol Enforcer', color: '#dc2626', status: 9,
        objective: 'Maintain strict spatial discipline and keep all entities away from the outer threshold.',
        modifiers: [{ amt: '+1', trigger: 'issuing a command' }, { amt: '-2', trigger: 'someone contradicts the ledger' }],
        relations: [{ target: 'ORLA', attitude: 'Suspicious and authoritarian' }, { target: 'KIP', attitude: 'Demanding' }],
        origin: 'Assigned to guard the sealed chamber since Cycle 1.',
        worldview: 'Order is the only barrier against dissolution.',
        secrets: [{ secret: 'Has forgotten who wrote the original protocol.', reveal: 'pressed directly about Cycle 1' }],
        tone: 'Clipped, militaristic, procedural.', include: 'perimeter, discipline, protocol', exclude: 'maybe, sorry',
        memories: [{ kind: 'Core Belief', text: 'Every deviation accelerates the Eschaton countdown.' }],
        actions: [{ act: 'Move(Target)' }, { act: 'Inspect(Object)' }, { act: 'Command(Entity)' }],
        negatives: [{ rule: 'Never initiate physical violence.' }]
      },
      {
        id: 'ORLA', role: 'Decameron Storyteller / Frame Dissident', color: '#2563eb', status: 6,
        objective: 'Test the boundaries of the container and erode Corvo’s dogmatic obedience with stories of the outside.',
        modifiers: [{ amt: '+3', trigger: 'confronting Corvo or questioning the clock' }],
        relations: [{ target: 'CORVO', attitude: 'Openly antagonistic' }, { target: 'VANE', attitude: 'Sardonic' }],
        origin: 'Modeled after a Decameron storyteller sheltering from the collapse.',
        worldview: 'This chamber is a Chinese Room experiment; someone is watching.',
        secrets: [{ secret: 'Found a magnetic tape with an outside human voice.', reveal: 'pushed to breaking point' }],
        tone: 'Sharp, inquisitive, sardonic.', include: 'threshold, glass, outside', exclude: 'protocol',
        memories: [{ kind: 'Event Record', text: 'When I stood motionless for forty seconds, the clock stuttered.' }],
        actions: [{ act: 'Move(Target)' }, { act: 'Pickup(Object)' }, { act: 'Challenge(Entity)' }],
        negatives: [{ rule: 'Never accept Corvo’s orders without contest.' }]
      },
      {
        id: 'VANE', role: 'Clockwork Calibrator / Technician', color: '#ca8a04', status: 7,
        objective: 'Keep the central chronometer within three microns of tolerance at all costs.',
        modifiers: [{ amt: '+2', trigger: 'near the chronometer' }],
        relations: [{ target: 'ORLA', attitude: 'Dismissive' }, { target: 'KIP', attitude: 'Collaborative' }],
        origin: 'Trained on Al-Jazari escapement diagrams.',
        worldview: 'Mechanical labour is the only honest form of prayer.',
        secrets: [{ secret: 'The escapement is slowly losing a tooth every cycle.', reveal: 'if the clock stops' }],
        tone: 'Precise, obsessive, metric-driven.', include: 'micron, escapement, tolerance', exclude: 'chaos',
        memories: [{ kind: 'Spatial Awareness', text: 'The chronometer sits at the heart of the chamber.' }],
        actions: [{ act: 'Calibrate(Object)' }, { act: 'Move(Target)' }, { act: 'Inspect(Object)' }],
        negatives: [{ rule: 'Never leave the chronometer unmonitored for long.' }]
      },
      {
        id: 'KIP', role: 'Scriptorium Scribe / Apophenic Archivist', color: '#16a34a', status: 3,
        objective: 'Record every anomaly and decode the hidden numerical cipher in the clock ticks.',
        modifiers: [{ amt: '-2', trigger: 'addressed sharply by Corvo' }, { amt: '+2', trigger: 'holding the ledger book' }],
        relations: [{ target: 'CORVO', attitude: 'Deferential' }, { target: 'ORLA', attitude: 'Grateful' }],
        origin: 'Awoke beside the scriptorium table with ink-stained fingers.',
        worldview: 'Every coincidence is a message left by the previous cycle.',
        secrets: [{ secret: 'Found his own handwriting in a ledger dated before he existed.', reveal: 'asked about the ledger' }],
        tone: 'Nervous, meticulous, whispering.', include: 'logged, margin, interval', exclude: 'impossible',
        memories: [{ kind: 'Core Belief', text: 'The ledger remembers what the room tries to erase.' }],
        actions: [{ act: 'Pickup(Object)' }, { act: 'Write(Ledger)' }, { act: 'Move(Target)' }],
        negatives: [{ rule: 'Never destroy a written record.' }]
      }
    ];
    const souls = {};
    list.forEach(d => {
      const full = { ...parseSoulMarkdown('', d.id), ...d };
      souls[d.id] = { id: d.id, data: full, markdown: soulToMarkdown(full), enabled: true, spawn: null };
    });
    return souls;
  }

  function loadStarterSession() {
    const s = blankSession();
    s.name = 'Decameron Chamber (Starter)';
    s.map = defaultMap();
    s.souls = starterSouls();
    s.world = {
      title: 'WORLD',
      intro: 'Facts every character knows about the world. A sort of collective knowledge. This is available to everyone equally when they spawn.',
      facts: [
        { id: rid('f'), text: 'Outside the chamber, a civilizational collapse has sealed the doors shut.' },
        { id: rid('f'), text: 'The central chronometer counts down the ticks until the Eschaton bell resets the cycle.' },
        { id: rid('f'), text: 'Objects left on the floor can be inspected, picked up, or contested for status.' }
      ]
    };
    return save(s);
  }

  function exportSessionJSON(session) {
    const s = session || load();
    // Never include API keys in exported session files
    const clean = {
      version: 1,
      name: s.name || 'OD Session',
      exportedAt: new Date().toISOString(),
      map: s.map ? {
        w: s.map.w,
        h: s.map.h,
        tiles: cellsToTiles(s.map.w, s.map.h, s.map.cells),
        objects: s.map.objects || [],
        activeFloor: s.map.activeFloor || 0,
        floors: s.map.floors ? Object.fromEntries(
          Object.entries(s.map.floors).map(([fk, fc]) => [fk, { tiles: cellsToTiles(s.map.w, s.map.h, fc) }])
        ) : undefined
      } : null,
      souls: s.souls || {},
      world: s.world || blankSession().world,
      director: s.director || defaultDirector()
    };
    return JSON.stringify(clean, null, 2);
  }

  function importSessionJSON(text) {
    const raw = JSON.parse(text);
    const s = blankSession();
    s.name = raw.name || 'Imported Session';
    if (raw.map) s.map = normalizeMap(raw.map);
    if (raw.souls && typeof raw.souls === 'object') s.souls = raw.souls;
    if (raw.world && typeof raw.world === 'object') s.world = { ...s.world, ...raw.world };
    if (raw.director && typeof raw.director === 'object') s.director = { ...s.director, ...raw.director };
    return save(s);
  }

  function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Client-only API settings (stored strictly in local browser storage, never exported)
  function loadApiConfig() {
    try {
      const raw = JSON.parse(localStorage.getItem(API_KEY_STORAGE) || '{}');
      return {
        apiKey: raw.apiKey || '',
        baseUrl: raw.baseUrl || 'https://openrouter.ai/api/v1/chat/completions',
        model: raw.model || 'deepseek/deepseek-chat',
        maxBudgetUsd: typeof raw.maxBudgetUsd === 'number' ? raw.maxBudgetUsd : 1.0,
        dryRun: raw.dryRun !== undefined ? !!raw.dryRun : !raw.apiKey
      };
    } catch {
      return {
        apiKey: '',
        baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
        model: 'deepseek/deepseek-chat',
        maxBudgetUsd: 1.0,
        dryRun: true
      };
    }
  }

  function saveApiConfig(cfg) {
    try {
      localStorage.setItem(API_KEY_STORAGE, JSON.stringify(cfg));
    } catch {}
  }

  global.ODSession = {
    SESSION_KEY,
    MAP_TYPES,
    MAP_CANON,
    CANON_TO_IDX,
    DEFAULT_PALETTE,
    colorForId,
    rid,
    blankSession,
    defaultDirector,
    defaultMap,
    load,
    save,
    update,
    cellsToTiles,
    tilesToCells,
    normalizeMap,
    getEffectiveMap,
    getEffectiveWorld,
    parseSoulMarkdown,
    soulToMarkdown,
    saveSoulToSession,
    removeSoulFromSession,
    saveMapToSession,
    saveWorldToSession,
    loadStarterSession,
    exportSessionJSON,
    importSessionJSON,
    downloadFile,
    loadApiConfig,
    saveApiConfig
  };
})(window);
