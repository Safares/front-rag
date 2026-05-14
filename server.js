'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { spawn }        = require('child_process');
const { EventEmitter } = require('events');

const app    = express();
const upload = multer({ dest: path.join(__dirname, 'uploads') });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Persistência: PostgreSQL ou arquivo JSON ─────────────────
const RAGS_DIR = path.join(__dirname, 'rags');
fs.mkdirSync(RAGS_DIR,                       { recursive: true });
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

let db = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  db.query(`
    CREATE TABLE IF NOT EXISTS rags (
      id         SERIAL PRIMARY KEY,
      store_id   TEXT        NOT NULL,
      store_name TEXT,
      provider   TEXT        NOT NULL,
      filename   TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(e => console.error('Erro ao criar tabela rags:', e.message));
  console.log('Banco PostgreSQL conectado.');
} else {
  console.log('DATABASE_URL ausente — usando arquivos JSON locais.');
}

async function saveRag(data) {
  if (db) {
    await db.query(
      'INSERT INTO rags (store_id, store_name, provider, filename) VALUES ($1, $2, $3, $4)',
      [data.store_id, data.store_name, data.provider, data.filename]
    );
  } else {
    const stem    = path.parse(data.filename || 'rag').name;
    const ragFile = path.join(RAGS_DIR, `${stem}.json`);
    fs.writeFileSync(ragFile, JSON.stringify({ ...data, createdAt: new Date().toISOString() }, null, 2));
  }
}

async function listRags() {
  if (db) {
    const { rows } = await db.query(
      'SELECT store_id, store_name, provider, filename, created_at AS "createdAt" FROM rags ORDER BY created_at DESC'
    );
    return rows;
  }
  try {
    const files = fs.readdirSync(RAGS_DIR).filter(f => f.endsWith('.json'));
    return files
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(RAGS_DIR, f), 'utf-8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch { return []; }
}

// ─── Job store (in-memory) ────────────────────────────────────
const jobs = new Map();

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── POST /upload ─────────────────────────────────────────────
app.post('/upload', upload.single('file'), (req, res) => {
  const { api_key: apiKey, ai_type: aiType } = req.body;
  if (!req.file || !apiKey || !aiType) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const jobId   = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  jobs.set(jobId, { emitter, status: 'running', result: null, error: null });

  res.json({ jobId });

  const workerPath   = path.join(__dirname, 'rag_worker.py');
  const originalName = req.file.originalname;

  // Multer salva sem extensão — renomeia para o Python reconhecer o formato
  const origExt  = path.extname(originalName).toLowerCase();
  const filePath = origExt ? req.file.path + origExt : req.file.path;
  if (origExt) fs.renameSync(req.file.path, filePath);

  const py = spawn('python', [
    workerPath, 'upload',
    '--provider', aiType,
    '--key',      apiKey,
    '--file',     filePath,
  ]);

  let buf = '';

  py.stdout.on('data', (data) => {
    buf += data.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('PROGRESS:')) {
        emitter.emit('progress', t.slice('PROGRESS:'.length));
      } else if (t.startsWith('RESULT:')) {
        try {
          const r = JSON.parse(t.slice('RESULT:'.length));
          r.filename = originalName;
          saveRag(r).catch(e => console.error('Erro ao salvar RAG:', e.message));
          const job = jobs.get(jobId);
          job.result = r;
          job.status = 'done';
          emitter.emit('done', r);
        } catch (e) {
          const job = jobs.get(jobId);
          job.status = 'error';
          job.error  = `Erro ao parsear resultado: ${e.message}`;
          emitter.emit('error', job.error);
        }
      } else if (t.startsWith('ERROR:')) {
        const msg = t.slice('ERROR:'.length);
        const job = jobs.get(jobId);
        job.status = 'error';
        job.error  = msg;
        emitter.emit('error', msg);
      }
    }
  });

  py.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) emitter.emit('progress', msg);
  });

  py.on('close', (code) => {
    fs.unlink(filePath, () => {});
    const job = jobs.get(jobId);
    if (job && job.status === 'running') {
      job.status = 'error';
      job.error  = `Processo encerrado com código ${code}.`;
      emitter.emit('error', job.error);
    }
  });
});

// ─── GET /progress/:jobId — SSE ───────────────────────────────
app.get('/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (job.status === 'done')  { send('done',  job.result);           res.end(); return; }
  if (job.status === 'error') { send('error', { error: job.error }); res.end(); return; }

  const onProgress = (msg) => send('progress', { message: msg });
  const onDone     = (r)   => { send('done',  r);                 res.end(); cleanup(); };
  const onError    = (e)   => { send('error', { error: e });      res.end(); cleanup(); };

  function cleanup() {
    job.emitter.off('progress', onProgress);
    job.emitter.off('done',     onDone);
    job.emitter.off('error',    onError);
  }

  job.emitter.on('progress', onProgress);
  job.emitter.on('done',     onDone);
  job.emitter.on('error',    onError);
  req.on('close', cleanup);
});

// ─── POST /query ──────────────────────────────────────────────
app.post('/query', (req, res) => {
  const { question, api_key: apiKey, ai_type: aiType, store_id: storeId } = req.body || {};
  if (!question?.trim() || !apiKey || !aiType || !storeId) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const workerPath = path.join(__dirname, 'rag_worker.py');
  const py = spawn('python', [
    workerPath, 'query',
    '--provider', aiType,
    '--key',      apiKey,
    '--store',    storeId,
    '--question', question,
  ]);

  let out = '';
  py.stdout.on('data', (d) => { out += d.toString(); });
  py.on('close', () => {
    for (const line of out.split('\n')) {
      if (line.startsWith('RESULT:')) {
        try { return res.json(JSON.parse(line.slice('RESULT:'.length))); } catch {}
      }
      if (line.startsWith('ERROR:')) {
        return res.status(500).json({ error: line.slice('ERROR:'.length) });
      }
    }
    res.status(500).json({ error: 'Resposta inesperada do worker.' });
  });
});

// ─── POST /crawl — escaneia URLs, retorna lista para confirmação
app.post('/crawl', (req, res) => {
  const { url, depth = 2 } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL obrigatória.' });

  const jobId   = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  jobs.set(jobId, { emitter, status: 'running', result: null, error: null });

  res.json({ jobId });

  const { use_js: useJs = false } = req.body;
  const crawlArgs = [
    path.join(__dirname, 'rag_worker.py'), 'crawl',
    '--url',   url,
    '--depth', String(depth),
  ];
  if (useJs) crawlArgs.push('--js');

  const py = spawn('python', crawlArgs);

  let buf = '';
  py.stdout.on('data', (data) => {
    buf += data.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('PROGRESS:')) {
        emitter.emit('progress', t.slice('PROGRESS:'.length));
      } else if (t.startsWith('RESULT:')) {
        try {
          const r   = JSON.parse(t.slice('RESULT:'.length));
          const job = jobs.get(jobId);
          job.result = r;
          job.status = 'done';
          emitter.emit('done', r);
        } catch (e) {
          const job = jobs.get(jobId);
          job.status = 'error';
          job.error  = e.message;
          emitter.emit('error', e.message);
        }
      } else if (t.startsWith('ERROR:')) {
        const msg = t.slice('ERROR:'.length);
        const job = jobs.get(jobId);
        job.status = 'error';
        job.error  = msg;
        emitter.emit('error', msg);
      }
    }
  });
  py.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) emitter.emit('progress', m); });
  py.on('close', (code) => {
    const job = jobs.get(jobId);
    if (job && job.status === 'running') {
      job.status = 'error';
      job.error  = `Processo encerrado com código ${code}.`;
      emitter.emit('error', job.error);
    }
  });
});

// ─── POST /scrape — scrapa páginas confirmadas e cria RAG ─────
app.post('/scrape', (req, res) => {
  const { urls, api_key: apiKey, ai_type: aiType, name } = req.body || {};
  if (!urls?.length || !apiKey || !aiType || !name) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const jobId   = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  jobs.set(jobId, { emitter, status: 'running', result: null, error: null });

  res.json({ jobId });

  const urlsFile = path.join(__dirname, 'uploads', `urls_${jobId}.json`);
  fs.writeFileSync(urlsFile, JSON.stringify(urls));

  const py = spawn('python', [
    path.join(__dirname, 'rag_worker.py'), 'scrape',
    '--provider',  aiType,
    '--key',       apiKey,
    '--urls-file', urlsFile,
    '--name',      name,
  ]);

  let buf = '';
  py.stdout.on('data', (data) => {
    buf += data.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('PROGRESS:')) {
        emitter.emit('progress', t.slice('PROGRESS:'.length));
      } else if (t.startsWith('RESULT:')) {
        try {
          const r = JSON.parse(t.slice('RESULT:'.length));
          r.filename = name;
          saveRag(r).catch(e => console.error('Erro ao salvar RAG:', e.message));
          const job = jobs.get(jobId);
          job.result = r;
          job.status = 'done';
          emitter.emit('done', r);
        } catch (e) {
          const job = jobs.get(jobId);
          job.status = 'error';
          job.error  = e.message;
          emitter.emit('error', e.message);
        }
      } else if (t.startsWith('ERROR:')) {
        const msg = t.slice('ERROR:'.length);
        const job = jobs.get(jobId);
        job.status = 'error';
        job.error  = msg;
        emitter.emit('error', msg);
      }
    }
  });
  py.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) emitter.emit('progress', m); });
  py.on('close', (code) => {
    fs.unlink(urlsFile, () => {});
    const job = jobs.get(jobId);
    if (job && job.status === 'running') {
      job.status = 'error';
      job.error  = `Processo encerrado com código ${code}.`;
      emitter.emit('error', job.error);
    }
  });
});

// ─── GET /rags ────────────────────────────────────────────────
app.get('/rags', async (_req, res) => {
  try { res.json(await listRags()); } catch { res.json([]); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n✅ Servidor rodando na porta ${PORT}\n`));
