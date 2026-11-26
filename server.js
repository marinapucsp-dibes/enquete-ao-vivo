// Enquete ao vivo — servidor (Express + Socket.io)
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------- Armazenamento ----------
// Com DATABASE_URL (Postgres, ex.: Neon): tudo fica salvo online e sobrevive a reinícios.
// Sem DATABASE_URL: usa um arquivo JSON local (bom para testar no computador).
let sessions = {};
let pool = null;

const KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newKey = () => { const b = crypto.randomBytes(8); let k = ''; for (let i = 0; i < 8; i++) k += KEY_CHARS[b[i] % KEY_CHARS.length]; return k.slice(0, 4) + '-' + k.slice(4); };

const toJSON = s => ({ ...s, questions: s.questions.map(q => ({ ...q, voters: [...q.voters] })) });
function fromJSON(s) {
  for (const q of s.questions) q.voters = new Set(q.voters || []);
  if (!s.adminKey) s.adminKey = newKey();
  return s;
}

async function loadAll() {
  if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    await pool.query('CREATE TABLE IF NOT EXISTS sessions (code TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const r = await pool.query('SELECT data FROM sessions');
    for (const row of r.rows) { const s = fromJSON(row.data); sessions[s.code] = s; }
    console.log(`Banco de dados conectado: ${r.rows.length} sessão(ões) carregada(s).`);
  } else {
    try {
      for (const s of Object.values(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')))) sessions[s.code] = fromJSON(s);
    } catch (_) { /* sem dados anteriores */ }
    console.log('Sem DATABASE_URL: salvando em arquivo local', DATA_FILE);
  }
}

const dirty = new Set();
let saveTimer = null;
function save(s) {
  if (s) dirty.add(s.code);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}
async function flush() {
  clearTimeout(saveTimer);
  if (!pool) {
    const out = {};
    for (const s of Object.values(sessions)) out[s.code] = toJSON(s);
    fs.writeFileSync(DATA_FILE, JSON.stringify(out));
    dirty.clear();
    return;
  }
  const codes = [...dirty]; dirty.clear();
  for (const code of codes) {
    const s = sessions[code];
    try {
      if (s) await pool.query('INSERT INTO sessions (code, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (code) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [code, JSON.stringify(toJSON(s))]);
      else await pool.query('DELETE FROM sessions WHERE code = $1', [code]);
    } catch (e) {
      console.error('Erro ao salvar no banco:', e.message);
      dirty.add(code); saveTimer = setTimeout(flush, 3000);
    }
  }
}
// O Render avisa antes de desligar: grava o que estiver pendente
process.on('SIGTERM', async () => { try { await flush(); } finally { process.exit(0); } });

const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const hashVoter = (id, qid) => crypto.createHash('sha256').update(id + ':' + qid).digest('hex').slice(0, 16);

function newCode() {
  let c;
  do { c = String(Math.floor(100000 + Math.random() * 900000)); } while (sessions[c]);
  return c;
}

function clean(str, max) {
  return String(str ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Estado completo (apresentador e telão)
function fullState(s) {
  return {
    code: s.code,
    title: s.title,
    activeId: s.activeId,
    showResults: s.showResults,
    questions: s.questions.map(q => ({
      id: q.id, type: q.type, text: q.text, options: q.options,
      counts: q.counts, words: q.words,
      answers: q.answers, total: q.voters.size,
    })),
  };
}

// Estado público (participantes): só a pergunta ativa, sem resultados
function publicQuestion(s) {
  const q = s.questions.find(x => x.id === s.activeId);
  if (!q) return null;
  return { id: q.id, v: q.v || 0, type: q.type, text: q.text, options: q.options };
}

function broadcast(s) {
  const st = fullState(s);
  io.to('admin:' + s.code).emit('state', st);
  io.to('screen:' + s.code).emit('state', st);
  save(s);
}

function broadcastParticipants(s) {
  // cada participante precisa saber se já votou: pedimos que ressincronizem
  io.to('p:' + s.code).emit('refresh');
}

function restoreSession(code, token, b) {
  const num = n => Math.max(0, Math.floor(Number(n) || 0));
  const questions = (Array.isArray(b.questions) ? b.questions : []).slice(0, 100).map(q => {
    const type = ['choice', 'words', 'open'].includes(q.type) ? q.type : 'open';
    const options = type === 'choice' ? (q.options || []).map(o => clean(o, 80)).filter(Boolean).slice(0, 10) : [];
    const words = {};
    if (type === 'words' && q.words && typeof q.words === 'object') {
      for (const [w, c] of Object.entries(q.words).slice(0, 500)) { const k = clean(w, 25).toLowerCase(); if (k) words[k] = num(c); }
    }
    return {
      id: clean(q.id, 20) || rid(6), v: 0, type, text: clean(q.text, 200) || 'Pergunta',
      options, counts: options.map((_, i) => num((q.counts || [])[i])), words,
      answers: type === 'open' ? (q.answers || []).slice(0, 1000).map(a => ({ id: clean(a.id, 12) || rid(4), text: clean(a.text, 280), at: num(a.at), hidden: !!a.hidden })).filter(a => a.text) : [],
      voters: new Set(),
    };
  });
  const activeId = questions.some(q => q.id === b.activeId) ? b.activeId : null;
  return { code, adminToken: token, adminKey: newKey(), title: clean(b.title, 80) || 'Minha apresentação', questions, activeId, showResults: b.showResults !== false, createdAt: Date.now() };
}

function getAdmin(socket, code, token) {
  const s = sessions[code];
  if (!s || s.adminToken !== token) { socket.emit('erro', 'Sessão não encontrada ou sem permissão.'); return null; }
  return s;
}

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  // Apresentador
  socket.on('admin:create', ({ title } = {}, cb) => {
    const code = newCode();
    const s = { code, adminToken: rid(16), adminKey: newKey(), title: clean(title, 80) || 'Minha apresentação', questions: [], activeId: null, showResults: true, createdAt: Date.now() };
    sessions[code] = s;
    save(s);
    cb && cb({ code, token: s.adminToken, key: s.adminKey });
  });

  socket.on('admin:join', ({ code, token, backup }, cb) => {
    // Servidor reiniciou e perdeu a sessão? Recria a partir da cópia guardada no navegador do apresentador.
    if (!sessions[code] && backup && /^\d{6}$/.test(String(code)) && typeof token === 'string' && token.length >= 16) {
      sessions[code] = restoreSession(code, token, backup);
      save(sessions[code]);
    }
    const s = getAdmin(socket, code, token); if (!s) return cb && cb({ ok: false });
    socket.join('admin:' + code);
    socket.emit('state', fullState(s));
    cb && cb({ ok: true, key: s.adminKey });
  });

  // Abrir a sessão em outro computador: código + chave do apresentador
  let loginTries = 0;
  socket.on('admin:login', ({ code, key } = {}, cb) => {
    if (typeof cb !== 'function') return;
    if (++loginTries > 10) return cb({ ok: false, msg: 'Muitas tentativas. Recarregue a página e tente de novo.' });
    const s = sessions[String(code || '').trim()];
    const k = String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!s || s.adminKey.replace('-', '') !== k) return cb({ ok: false, msg: 'Código ou chave incorretos.' });
    cb({ ok: true, code: s.code, token: s.adminToken, key: s.adminKey, title: s.title });
  });

  socket.on('admin:addQuestion', ({ code, token, type, text, options }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    if (!['choice', 'words', 'open'].includes(type)) return;
    const q = {
      id: rid(6), type, text: clean(text, 200) || 'Pergunta sem título',
      options: [], counts: [], words: {}, answers: [], voters: new Set(),
    };
    if (type === 'choice') {
      q.options = (options || []).map(o => clean(o, 80)).filter(Boolean).slice(0, 10);
      if (q.options.length < 2) return socket.emit('erro', 'Informe ao menos 2 opções.');
      q.counts = q.options.map(() => 0);
    }
    s.questions.push(q);
    if (!s.activeId) s.activeId = q.id;
    broadcast(s); broadcastParticipants(s);
  });

  socket.on('admin:editQuestion', ({ code, token, id, type, text, options }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    const q = s.questions.find(x => x.id === id); if (!q) return;
    if (!['choice', 'words', 'open'].includes(type)) return;
    let opts = [];
    if (type === 'choice') {
      opts = (options || []).map(o => clean(o, 80)).filter(Boolean).slice(0, 10);
      if (opts.length < 2) return socket.emit('erro', 'Informe ao menos 2 opções.');
    }
    q.text = clean(text, 200) || q.text;
    if (type !== q.type) {
      // mudou o tipo: respostas antigas não fazem sentido, começa do zero
      q.type = type; q.options = opts; q.counts = opts.map(() => 0);
      q.words = {}; q.answers = []; q.voters = new Set();
    } else if (type === 'choice') {
      // mantém os votos das opções que continuam com o mesmo texto
      const old = new Map(q.options.map((o, i) => [o, q.counts[i]]));
      q.options = opts; q.counts = opts.map(o => old.get(o) || 0);
    }
    q.v = (q.v || 0) + 1;
    broadcast(s); broadcastParticipants(s);
  });

  socket.on('admin:setActive',({ code, token, id }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    s.activeId = s.questions.some(q => q.id === id) ? id : null;
    broadcast(s); broadcastParticipants(s);
  });

  socket.on('admin:delete', ({ code, token, id }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    s.questions = s.questions.filter(q => q.id !== id);
    if (s.activeId === id) s.activeId = null;
    broadcast(s); broadcastParticipants(s);
  });

  socket.on('admin:reset', ({ code, token, id }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    const q = s.questions.find(x => x.id === id); if (!q) return;
    q.counts = q.options.map(() => 0); q.words = {}; q.answers = []; q.voters = new Set();
    broadcast(s); broadcastParticipants(s);
  });

  socket.on('admin:toggleResults', ({ code, token }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    s.showResults = !s.showResults;
    broadcast(s);
  });

  socket.on('admin:hideAnswer', ({ code, token, id, answerId }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    const q = s.questions.find(x => x.id === id); if (!q) return;
    const a = q.answers.find(x => x.id === answerId); if (a) a.hidden = !a.hidden;
    broadcast(s);
  });

  // Telão
  socket.on('screen:join', ({ code }, cb) => {
    const s = sessions[code];
    if (!s) return cb && cb({ ok: false });
    socket.join('screen:' + code);
    socket.emit('state', fullState(s));
    cb && cb({ ok: true });
  });

  // Participante (anônimo: só um ID aleatório do navegador, guardado em forma de hash)
  socket.on('p:join', ({ code, voterId }, cb) => {
    const s = sessions[code];
    if (!s) return cb && cb({ ok: false });
    socket.join('p:' + code);
    const q = publicQuestion(s);
    const real = q && s.questions.find(x => x.id === q.id);
    cb && cb({ ok: true, title: s.title, question: q, voted: !!(real && real.voters.has(hashVoter(voterId, real.id))) });
  });

  socket.on('p:vote', ({ code, voterId, questionId, value }, cb) => {
    const s = sessions[code];
    if (!s || s.activeId !== questionId) return cb && cb({ ok: false, msg: 'Esta pergunta não está mais ativa.' });
    const q = s.questions.find(x => x.id === questionId);
    const h = hashVoter(String(voterId || ''), q.id);
    if (!voterId || q.voters.has(h)) return cb && cb({ ok: false, msg: 'Você já respondeu esta pergunta.' });

    if (q.type === 'choice') {
      const i = Number(value);
      if (!Number.isInteger(i) || i < 0 || i >= q.options.length) return cb && cb({ ok: false, msg: 'Opção inválida.' });
      q.counts[i]++;
    } else if (q.type === 'words') {
      const words = (Array.isArray(value) ? value : [value]).map(w => clean(w, 25).toLowerCase()).filter(Boolean).slice(0, 3);
      if (!words.length) return cb && cb({ ok: false, msg: 'Digite ao menos uma palavra.' });
      for (const w of new Set(words)) q.words[w] = (q.words[w] || 0) + 1;
    } else {
      const t = clean(value, 280);
      if (!t) return cb && cb({ ok: false, msg: 'Escreva sua resposta.' });
      q.answers.push({ id: rid(4), text: t, at: Date.now(), hidden: false });
    }
    q.voters.add(h);
    broadcast(s);
    cb && cb({ ok: true });
  });
});

// ---------- HTTP ----------
app.get('/qr/:code.svg', async (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const url = `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}/?c=${encodeURIComponent(req.params.code)}`;
  res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 1 }));
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/tela/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tela.html')));

loadAll().then(() => {
  server.listen(PORT, () => console.log(`Enquete rodando em http://localhost:${PORT}`));
}).catch(e => { console.error('Não foi possível carregar os dados:', e.message); process.exit(1); });
