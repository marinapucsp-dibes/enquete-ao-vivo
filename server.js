// Enquete ao vivo — servidor (Express + Socket.io)
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const TYPES = ['choice', 'scale', 'words', 'open'];
const QUIZ_FAST_MS = 30000; // quem acerta nos primeiros 30 s ganha bônus de velocidade

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
  for (const q of s.questions) {
    q.voters = new Set(q.voters || []);
    if (!q.quiz) q.quiz = {};
    if (q.correct === undefined) q.correct = null;
  }
  if (!s.adminKey) s.adminKey = newKey();
  if (!s.players) s.players = {};
  if (!s.screen) s.screen = 'question';
  return s;
}

async function loadAll() {
  if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    await pool.query('CREATE TABLE IF NOT EXISTS enquete_sessions (code TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const r = await pool.query('SELECT data FROM enquete_sessions');
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
      if (s) await pool.query('INSERT INTO enquete_sessions (code, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (code) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [code, JSON.stringify(toJSON(s))]);
      else await pool.query('DELETE FROM enquete_sessions WHERE code = $1', [code]);
    } catch (e) {
      console.error('Erro ao salvar no banco:', e.message);
      dirty.add(code); saveTimer = setTimeout(flush, 3000);
    }
  }
}
// O Render avisa antes de desligar: grava o que estiver pendente
process.on('SIGTERM', async () => { try { await flush(); } finally { process.exit(0); } });

// ---------- Utilidades ----------
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashVoter = (id, qid) => sha(id + ':' + qid).slice(0, 16);
const hashPlayer = (id, code) => sha('player:' + id + ':' + code).slice(0, 16);

function newCode() {
  let c;
  do { c = String(Math.floor(100000 + Math.random() * 900000)); } while (sessions[c]);
  return c;
}
function clean(str, max) {
  return String(str ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
const scaleOptions = scale => scale === '0-10' ? Array.from({ length: 11 }, (_, i) => String(i)) : ['1', '2', '3', '4', '5'];

// Valida os dados de uma pergunta vindos do painel
function parseQuestion({ type, text, options, correct, scale, scaleLabels }) {
  if (!TYPES.includes(type)) return { error: 'Tipo inválido.' };
  const q = { type, text: clean(text, 200), options: [], correct: null, scale: null, scaleLabels: ['', ''] };
  if (!q.text) return { error: 'Escreva a pergunta.' };
  if (type === 'choice') {
    q.options = (options || []).map(o => clean(o, 80)).filter(Boolean).slice(0, 10);
    if (q.options.length < 2) return { error: 'Informe ao menos 2 opções.' };
    const c = Number(correct);
    q.correct = correct !== null && correct !== '' && Number.isInteger(c) && c >= 0 && c < q.options.length ? c : null;
  } else if (type === 'scale') {
    q.scale = scale === '0-10' ? '0-10' : '1-5';
    q.options = scaleOptions(q.scale);
    q.scaleLabels = [clean((scaleLabels || [])[0], 40), clean((scaleLabels || [])[1], 40)];
  }
  return q;
}

function quizPoints(correct, ms) {
  return correct ? Math.round(500 + 500 * Math.max(0, 1 - ms / QUIZ_FAST_MS)) : 0;
}

// Recalcula os pontos de uma pergunta de quiz (ex.: depois de trocar a resposta correta)
function rescore(s, q) {
  for (const e of Object.values(q.quiz)) {
    const c = q.correct !== null && e.o === q.options[q.correct];
    const p = q.correct !== null && !e.z ? quizPoints(c, e.t) : 0; // e.z: pontos zerados pelo "zerar ranking"
    const pl = s.players[e.pl];
    if (pl) pl.score += p - e.p;
    e.c = c; e.p = p;
  }
}

function clearResponses(s, q) {
  for (const e of Object.values(q.quiz || {})) { const pl = s.players[e.pl]; if (pl) pl.score -= e.p; }
  q.counts = q.options.map(() => 0); q.words = {}; q.answers = []; q.voters = new Set(); q.quiz = {}; q.revealed = false;
}

function ranking(s, limit = 50) {
  return Object.entries(s.players)
    .filter(([, p]) => p.name && !p.hidden)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([id, p]) => ({ id: id.slice(0, 8), name: p.name, score: p.score }));
}

// Estado completo (apresentador e telão)
function fullState(s) {
  const hasQuiz = s.questions.some(q => q.correct !== null);
  return {
    code: s.code,
    title: s.title,
    activeId: s.activeId,
    showResults: s.showResults,
    screen: s.screen,
    hasQuiz,
    ranking: ranking(s),
    questions: s.questions.map(q => ({
      id: q.id, type: q.type, text: q.text, options: q.options,
      correct: q.correct, revealed: !!q.revealed, scale: q.scale, scaleLabels: q.scaleLabels,
      counts: q.counts, words: q.words,
      answers: q.answers, total: q.voters.size,
    })),
  };
}

// Pergunta ativa para os participantes: sem resultados e sem a resposta correta (até ser revelada)
function publicQuestion(s) {
  const q = s.questions.find(x => x.id === s.activeId);
  if (!q) return null;
  const quiz = q.correct !== null;
  return {
    id: q.id, v: q.v || 0, type: q.type, text: q.text, options: q.options, scaleLabels: q.scaleLabels,
    quiz, revealed: quiz && !!q.revealed, correctText: quiz && q.revealed ? q.options[q.correct] : null,
  };
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

function newQuestion(data) {
  return {
    id: rid(6), v: 0, ...data,
    counts: data.options.map(() => 0), words: {}, answers: [], voters: new Set(), quiz: {}, revealed: false, openedAt: 0,
  };
}

function goLive(s, id) {
  s.activeId = s.questions.some(q => q.id === id) ? id : null;
  s.screen = 'question';
  const q = s.questions.find(x => x.id === s.activeId);
  if (q) q.openedAt = Date.now();
}

function restoreSession(code, token, b) {
  const num = n => Math.max(0, Math.floor(Number(n) || 0));
  const questions = (Array.isArray(b.questions) ? b.questions : []).slice(0, 100).map(raw => {
    const p = parseQuestion({ ...raw, type: TYPES.includes(raw.type) ? raw.type : 'open', text: raw.text || 'Pergunta' });
    const data = p.error ? parseQuestion({ type: 'open', text: raw.text || 'Pergunta' }) : p;
    const q = newQuestion(data);
    q.id = clean(raw.id, 20) || q.id;
    q.counts = q.options.map((_, i) => num((raw.counts || [])[i]));
    q.revealed = !!raw.revealed;
    if (q.type === 'words' && raw.words && typeof raw.words === 'object') {
      for (const [w, c] of Object.entries(raw.words).slice(0, 500)) { const k = clean(w, 25).toLowerCase(); if (k) q.words[k] = num(c); }
    }
    if (q.type === 'open') {
      q.answers = (raw.answers || []).slice(0, 1000).map(a => ({ id: clean(a.id, 12) || rid(4), text: clean(a.text, 280), at: num(a.at), hidden: !!a.hidden })).filter(a => a.text);
    }
    return q;
  });
  const activeId = questions.some(q => q.id === b.activeId) ? b.activeId : null;
  return { code, adminToken: token, adminKey: newKey(), title: clean(b.title, 80) || 'Minha apresentação', questions, activeId, showResults: b.showResults !== false, screen: 'question', players: {}, createdAt: Date.now() };
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
    const s = { code, adminToken: rid(16), adminKey: newKey(), title: clean(title, 80) || 'Minha apresentação', questions: [], activeId: null, showResults: true, screen: 'question', players: {}, createdAt: Date.now() };
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

  socket.on('admin:addQuestion', ({ code, token, ...data }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    const p = parseQuestion(data); if (p.error) return socket.emit('erro', p.error);
    const q = newQuestion(p);
    s.questions.push(q);
    if (!s.activeId && s.questions.length === 1) goLive(s, q.id);
    broadcast(s); broadcastParticipants(s);
  });

  socket.on('admin:editQuestion', ({ code, token, id, ...data }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    const q = s.questions.find(x => x.id === id); if (!q) return;
    const p = parseQuestion(data); if (p.error) return socket.emit('erro', p.error);
    const sameKind = p.type === q.type && (p.type !== 'scale' || p.scale === q.scale);
    q.text = p.text; q.scaleLabels = p.scaleLabels;
    if (!sameKind) {
      // mudou o tipo: respostas antigas não fazem sentido, começa do zero
      clearResponses(s, q);
      Object.assign(q, { type: p.type, options: p.options, correct: p.correct, scale: p.scale });
      q.counts = q.options.map(() => 0);
    } else if (p.type === 'choice') {
      // mantém os votos das opções que continuam com o mesmo texto
      const old = new Map(q.options.map((o, i) => [o, q.counts[i]]));
      q.options = p.options; q.counts = p.options.map(o => old.get(o) || 0);
      q.correct = p.correct;
      if (q.correct === null) q.revealed = false;
      rescore(s, q);
    }
    q.v = (q.v || 0) + 1;
    broadcast(s); broadcastParticipants(s);
  });

  socket.on('admin:setActive', ({ code, token, id }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    goLive(s, id);
    broadcast(s); broadcastParticipants(s);
  });

  socket.on('admin:move', ({ code, token, id, dir }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    const i = s.questions.findIndex(q => q.id === id), j = i + (dir > 0 ? 1 : -1);
    if (i < 0 || j < 0 || j >= s.questions.length) return;
    [s.questions[i], s.questions[j]] = [s.questions[j], s.questions[i]];
    broadcast(s);
  });

  socket.on('admin:delete', ({ code, token, id }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    const q = s.questions.find(x => x.id === id); if (!q) return;
    clearResponses(s, q);
    s.questions = s.questions.filter(x => x.id !== id);
    if (s.activeId === id) s.activeId = null;
    broadcast(s); broadcastParticipants(s);
  });

  socket.on('admin:reset', ({ code, token, id }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    const q = s.questions.find(x => x.id === id); if (!q) return;
    clearResponses(s, q);
    if (s.activeId === q.id) q.openedAt = Date.now();
    broadcast(s); broadcastParticipants(s);
  });

  socket.on('admin:reveal', ({ code, token, id }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    const q = s.questions.find(x => x.id === id); if (!q || q.correct === null) return;
    q.revealed = !q.revealed;
    if (q.revealed) s.showResults = true;
    broadcast(s); broadcastParticipants(s);
  });

  socket.on('admin:toggleResults', ({ code, token }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    s.showResults = !s.showResults;
    broadcast(s);
  });

  socket.on('admin:screen', ({ code, token, screen }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    s.screen = screen === 'ranking' ? 'ranking' : 'question';
    broadcast(s); broadcastParticipants(s);
  });

  socket.on('admin:hidePlayer', ({ code, token, playerId }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    const key = Object.keys(s.players).find(k => k.startsWith(String(playerId)) && String(playerId).length === 8);
    if (key) s.players[key].hidden = true;
    broadcast(s);
  });

  socket.on('admin:resetRanking', ({ code, token }) => {
    const s = getAdmin(socket, code, token); if (!s) return;
    for (const p of Object.values(s.players)) p.score = 0;
    for (const q of s.questions) for (const e of Object.values(q.quiz)) { e.p = 0; e.z = true; }
    broadcast(s); broadcastParticipants(s);
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
    const h = real && hashVoter(String(voterId || ''), real.id);
    const voted = !!(real && real.voters.has(h));
    const result = voted && q.quiz && q.revealed && real.quiz[h] ? { correct: real.quiz[h].c, points: real.quiz[h].p } : null;
    const ph = hashPlayer(String(voterId || ''), s.code), pl = s.players[ph];
    let me = null;
    if (pl && pl.name) {
      const r = ranking(s, 100000);
      me = { name: pl.name, score: pl.score, rank: pl.hidden ? null : r.findIndex(x => x.id === ph.slice(0, 8)) + 1 || null, players: r.length };
    }
    cb && cb({ ok: true, title: s.title, question: q, voted, result, me, screen: s.screen });
  });

  socket.on('p:setName', ({ code, voterId, name }, cb) => {
    const s = sessions[code]; if (!s || !voterId) return cb && cb({ ok: false });
    const n = clean(name, 20);
    if (!n) return cb && cb({ ok: false, msg: 'Digite um apelido.' });
    const ph = hashPlayer(String(voterId), s.code);
    s.players[ph] = { ...(s.players[ph] || { score: 0 }), name: n };
    broadcast(s);
    cb && cb({ ok: true });
  });

  socket.on('p:vote', ({ code, voterId, questionId, value }, cb) => {
    const s = sessions[code];
    if (!s || s.activeId !== questionId) return cb && cb({ ok: false, msg: 'Esta pergunta não está mais ativa.' });
    const q = s.questions.find(x => x.id === questionId);
    const h = hashVoter(String(voterId || ''), q.id);
    if (!voterId || q.voters.has(h)) return cb && cb({ ok: false, msg: 'Você já respondeu esta pergunta.' });

    if (q.type === 'choice' || q.type === 'scale') {
      const i = Number(value);
      if (!Number.isInteger(i) || i < 0 || i >= q.options.length) return cb && cb({ ok: false, msg: 'Opção inválida.' });
      q.counts[i]++;
      if (q.type === 'choice' && q.correct !== null) {
        const ph = hashPlayer(String(voterId), s.code);
        if (!s.players[ph]) s.players[ph] = { name: '', score: 0 };
        const t = Math.max(0, Date.now() - (q.openedAt || Date.now()));
        const c = i === q.correct, p = quizPoints(c, t);
        q.quiz[h] = { o: q.options[i], t, c, p, pl: ph };
        s.players[ph].score += p;
      }
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
function participantUrl(req, code) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}/?c=${encodeURIComponent(code)}`;
}

app.get('/qr/:code.svg', async (req, res) => {
  res.type('image/svg+xml').send(await QRCode.toString(participantUrl(req, req.params.code), { type: 'svg', margin: 1 }));
});

app.get('/qr/:code.png', async (req, res) => {
  const width = Math.min(2000, Math.max(200, Number(req.query.w) || 1000));
  res.type('image/png').send(await QRCode.toBuffer(participantUrl(req, req.params.code), { width, margin: 2, errorCorrectionLevel: 'M' }));
});

const typeLabel = { choice: 'Múltipla escolha', scale: 'Escala', words: 'Nuvem de palavras', open: 'Resposta aberta' };

app.get('/export/:code.xlsx', async (req, res) => {
  const s = sessions[req.params.code];
  if (!s || req.query.t !== s.adminToken) return res.status(403).send('Sem permissão.');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Enquete ao vivo';
  const head = ws => { ws.getRow(1).font = { bold: true }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9E6FF' } }; ws.views = [{ state: 'frozen', ySplit: 1 }]; };

  const r = wb.addWorksheet('Resultados');
  r.columns = [
    { header: 'Nº', key: 'n', width: 5 }, { header: 'Pergunta', key: 'q', width: 50 }, { header: 'Tipo', key: 't', width: 18 },
    { header: 'Opção / palavra', key: 'o', width: 36 }, { header: 'Respostas', key: 'c', width: 11 }, { header: '%', key: 'p', width: 8 }, { header: 'Observação', key: 'obs', width: 22 },
  ];
  s.questions.forEach((q, n) => {
    const base = { n: n + 1, q: q.text, t: q.correct !== null ? 'Quiz' : typeLabel[q.type] };
    if (q.type === 'choice' || q.type === 'scale') {
      const total = q.counts.reduce((a, b) => a + b, 0);
      q.options.forEach((o, i) => r.addRow({ ...base, o, c: q.counts[i], p: total ? q.counts[i] / total : 0, obs: q.correct === i ? '✔ resposta correta' : '' }));
      if (q.type === 'scale' && total) {
        const avg = q.counts.reduce((a, c, i) => a + c * Number(q.options[i]), 0) / total;
        r.addRow({ ...base, o: 'MÉDIA', c: Math.round(avg * 100) / 100, obs: `${total} resposta(s)` }).font = { bold: true };
      }
    } else if (q.type === 'words') {
      const entries = Object.entries(q.words).sort((a, b) => b[1] - a[1]);
      if (!entries.length) r.addRow({ ...base, o: '(sem respostas)' });
      entries.forEach(([w, c]) => r.addRow({ ...base, o: w, c }));
    } else {
      r.addRow({ ...base, o: 'ver aba "Respostas abertas"', c: q.answers.length });
    }
  });
  r.getColumn('p').numFmt = '0%';
  head(r);

  const a = wb.addWorksheet('Respostas abertas');
  a.columns = [{ header: 'Pergunta', key: 'q', width: 45 }, { header: 'Resposta', key: 'a', width: 70 }, { header: 'Horário', key: 'h', width: 18 }, { header: 'Ocultada no telão', key: 'x', width: 16 }];
  for (const q of s.questions.filter(x => x.type === 'open')) {
    for (const ans of q.answers) a.addRow({ q: q.text, a: ans.text, h: ans.at ? new Date(ans.at) : '', x: ans.hidden ? 'sim' : '' });
  }
  a.getColumn('h').numFmt = 'dd/mm/yyyy hh:mm';
  a.getColumn('a').alignment = { wrapText: true, vertical: 'top' };
  head(a);

  if (s.questions.some(q => q.correct !== null)) {
    const k = wb.addWorksheet('Ranking do quiz');
    k.columns = [{ header: 'Posição', key: 'p', width: 9 }, { header: 'Apelido', key: 'n', width: 28 }, { header: 'Pontos', key: 's', width: 10 }];
    ranking(s, 100000).forEach((x, i) => k.addRow({ p: i + 1, n: x.name, s: x.score }));
    head(k);
  }

  const safe = clean(s.title, 60).replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'enquete';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="resultados.xlsx"; filename*=UTF-8''${encodeURIComponent(safe + ' - resultados.xlsx')}`);
  await wb.xlsx.write(res);
  res.end();
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/tela/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tela.html')));

loadAll().then(() => {
  server.listen(PORT, () => console.log(`Enquete rodando em http://localhost:${PORT}`));
}).catch(e => { console.error('Não foi possível carregar os dados:', e.message); process.exit(1); });
