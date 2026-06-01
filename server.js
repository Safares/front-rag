'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { spawn }        = require('child_process');
const { EventEmitter } = require('events');
const cron             = require('node-cron');

const app    = express();
const upload = multer({ dest: path.join(__dirname, 'uploads'), limits: { fileSize: 100 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Persistência: PostgreSQL ou arquivo JSON ─────────────────
const RAGS_DIR = path.join(__dirname, 'rags');
fs.mkdirSync(RAGS_DIR,                       { recursive: true });
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

// GC: limpa arquivos temporários de jobs de extração que nunca foram confirmados (> 2h)
setInterval(() => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    const jobAge = now - parseInt(id.slice(0, 8), 36);
    if (jobAge > TWO_HOURS && job.result?.renamedPaths) {
      job.result.renamedPaths.forEach(p => fs.unlink(p, () => {}));
      if (job.result.filesManifest) fs.unlink(job.result.filesManifest, () => {});
      jobs.delete(id);
    }
  }
}, 60 * 60 * 1000); // roda a cada hora

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
      file_count INT         DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(e => console.error('Erro ao criar tabela rags:', e.message));
  db.query(`ALTER TABLE rags ADD COLUMN IF NOT EXISTS api_key TEXT`).catch(() => {});
  db.query(`ALTER TABLE rags ADD COLUMN IF NOT EXISTS urls TEXT`).catch(() => {});
  db.query(`ALTER TABLE rags ADD COLUMN IF NOT EXISTS schedule TEXT DEFAULT 'never'`).catch(() => {});
  db.query(`ALTER TABLE rags ADD COLUMN IF NOT EXISTS scrape_ai_key TEXT`).catch(() => {});
  db.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id         SERIAL PRIMARY KEY,
      store_id   TEXT        NOT NULL,
      question   TEXT,
      answer     TEXT,
      rating     TEXT        NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(e => console.error('Erro ao criar tabela feedback:', e.message));
  console.log('Banco PostgreSQL conectado.');
} else {
  console.log('DATABASE_URL ausente — usando arquivos JSON locais.');
}

async function saveRag(data) {
  const apiKey = data.api_key || crypto.randomUUID();
  if (db) {
    await db.query(
      'INSERT INTO rags (store_id, store_name, provider, filename, file_count, api_key, urls, schedule, scrape_ai_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [data.store_id, data.store_name, data.provider, data.filename, data.file_count || 0, apiKey,
       JSON.stringify(data.urls || []), data.schedule || 'never', data.scrape_ai_key || null]
    );
  } else {
    const stem    = path.parse(data.filename || 'rag').name;
    const ragFile = path.join(RAGS_DIR, `${stem}.json`);
    fs.writeFileSync(ragFile, JSON.stringify({ ...data, api_key: apiKey, createdAt: new Date().toISOString() }, null, 2));
  }
  return apiKey;
}

async function listRags() {
  if (db) {
    const { rows } = await db.query(
      'SELECT store_id, store_name, provider, filename, file_count, schedule, created_at AS "createdAt" FROM rags ORDER BY created_at DESC'
    );
    return rows;
  }
  try {
    const files = fs.readdirSync(RAGS_DIR).filter(f => f.endsWith('.json'));
    return files
      .map(f => {
        try {
          const { api_key: _k, scrape_ai_key: _s, ...rag } = JSON.parse(fs.readFileSync(path.join(RAGS_DIR, f), 'utf-8'));
          return rag;
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch { return []; }
}

async function listRagsWithSchedule() {
  if (db) {
    const { rows } = await db.query(
      `SELECT store_id, store_name, provider, filename, api_key, scrape_ai_key, urls, schedule
       FROM rags WHERE schedule != 'never' AND urls IS NOT NULL`
    );
    return rows.map(r => ({ ...r, urls: r.urls ? JSON.parse(r.urls) : [] }));
  }
  const files = fs.readdirSync(RAGS_DIR).filter(f => f.endsWith('.json'));
  return files
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(RAGS_DIR, f), 'utf-8')); } catch { return null; } })
    .filter(r => r && r.schedule && r.schedule !== 'never' && r.urls?.length);
}

async function findRagByApiKey(apiKey) {
  if (db) {
    const { rows } = await db.query(
      'SELECT store_id, store_name, provider, filename, file_count, api_key, created_at AS "createdAt" FROM rags WHERE api_key = $1',
      [apiKey]
    );
    return rows[0] || null;
  }
  const files = fs.readdirSync(RAGS_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const rag = JSON.parse(fs.readFileSync(path.join(RAGS_DIR, f), 'utf-8'));
      if (rag.api_key === apiKey) return rag;
    } catch {}
  }
  return null;
}

// ─── Per-api-key rate limiting for public API ─────────────────
const apiKeyHitMap = new Map(); // api_key -> { count, windowStart }
function checkRateLimit(apiKey) {
  const now = Date.now();
  const WINDOW_MS = 60 * 1000;
  const MAX_HITS  = 60;
  const entry = apiKeyHitMap.get(apiKey) || { count: 0, windowStart: now };
  if (now - entry.windowStart > WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  apiKeyHitMap.set(apiKey, entry);
  return entry.count <= MAX_HITS;
}

// ─── Job store (in-memory) ────────────────────────────────────
const jobs = new Map();

// ─── Re-scraping automático ───────────────────────────────────
const activeJobs = new Map(); // store_id → cron job instance

function runReScrape(rag) {
  if (!rag.urls?.length || !rag.scrape_ai_key) {
    console.log(`[cron] Pulando ${rag.store_id}: sem AI key armazenada.`);
    return;
  }
  console.log(`[cron] Re-scraping ${rag.store_id} (${rag.filename})...`);
  const urlsFile = path.join(__dirname, 'uploads', `rescrape_${Date.now().toString(36)}.json`);
  fs.writeFileSync(urlsFile, JSON.stringify(rag.urls));

  const py = spawn('python', [
    path.join(__dirname, 'rag_worker.py'), 'scrape',
    '--provider',  rag.provider,
    '--key',       rag.scrape_ai_key,
    '--urls-file', urlsFile,
    '--name',      rag.filename || rag.store_id,
  ]);

  let buf = '';
  py.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('PROGRESS:')) console.log(`[cron] ${t.slice('PROGRESS:'.length)}`);
      else if (t.startsWith('RESULT:')) console.log(`[cron] Re-scrape concluída: ${rag.store_id}`);
      else if (t.startsWith('ERROR:'))  console.error(`[cron] Erro: ${t.slice('ERROR:'.length)}`);
    }
  });
  py.stderr.on('data', (d) => { const m = d.toString().trim(); if (m) console.log(`[cron] ${m}`); });
  py.on('close', () => fs.unlink(urlsFile, () => {}));
}

function scheduleCronForRag(rag) {
  if (rag.schedule === 'daily')  return cron.schedule('0 3 * * *', () => runReScrape(rag));
  if (rag.schedule === 'weekly') return cron.schedule('0 3 * * 1', () => runReScrape(rag));
  return null;
}

async function initCronJobs() {
  try {
    const rags = await listRagsWithSchedule();
    for (const rag of rags) {
      const job = scheduleCronForRag(rag);
      if (job) activeJobs.set(rag.store_id, job);
    }
    if (activeJobs.size > 0) console.log(`[cron] ${activeJobs.size} job(s) de re-scraping agendados.`);
  } catch (e) {
    console.error('[cron] Erro ao inicializar jobs:', e.message);
  }
}

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── POST /upload ─────────────────────────────────────────────
app.post('/upload', upload.array('files', 20), (req, res) => {
  const { api_key: apiKey, ai_type: aiType } = req.body;
  if (!req.files?.length || !apiKey || !aiType) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const jobId   = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  jobs.set(jobId, { emitter, status: 'running', result: null, error: null });

  res.json({ jobId });

  const workerPath = path.join(__dirname, 'rag_worker.py');

  // Multer salva sem extensão — renomeia cada arquivo para o Python reconhecer o formato
  const renamedPaths = req.files.map(f => {
    const ext  = path.extname(f.originalname).toLowerCase();
    const dest = ext ? f.path + ext : f.path;
    if (ext) fs.renameSync(f.path, dest);
    return dest;
  });

  const filesManifest = path.join(__dirname, 'uploads', `files_${jobId}.json`);
  fs.writeFileSync(filesManifest, JSON.stringify(
    req.files.map((f, i) => ({ path: renamedPaths[i], name: f.originalname }))
  ));

  const firstName   = req.files[0].originalname;
  const extra       = req.files.length - 1;
  const displayName = extra === 0
    ? firstName
    : `${firstName} + ${extra} outro${extra > 1 ? 's' : ''}`;

  const py = spawn('python', [
    workerPath, 'upload',
    '--provider',   aiType,
    '--key',        apiKey,
    '--files-file', filesManifest,
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
          r.filename   = displayName;
          r.file_count = r.files_uploaded?.length || 0;
          saveRag(r).then(apiKey => {
            r.api_key = apiKey;
            const job = jobs.get(jobId);
            job.result = r;
            job.status = 'done';
            emitter.emit('done', r);
          }).catch(e => {
            console.error('Erro ao salvar RAG:', e.message);
            const job = jobs.get(jobId);
            job.result = r;
            job.status = 'done';
            emitter.emit('done', r);
          });
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
    renamedPaths.forEach(p => fs.unlink(p, () => {}));
    fs.unlink(filesManifest, () => {});
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
  const { question, api_key: apiKey, ai_type: aiType, store_id: storeId, store_ids: storeIds } = req.body || {};
  if (!question?.trim() || !apiKey || !aiType || (!storeId && !storeIds?.length)) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const workerPath = path.join(__dirname, 'rag_worker.py');

  // Multi-RAG: use multi-query subcommand
  if (storeIds?.length > 1) {
    const storesFile = path.join(__dirname, 'uploads', `stores_${Date.now().toString(36)}.json`);
    fs.writeFileSync(storesFile, JSON.stringify(storeIds));  // storeIds is array of {store_id, name, provider}

    const py = spawn('python', [
      workerPath, 'multi-query',
      '--provider', aiType,
      '--key',      apiKey,
      '--stores-file', storesFile,
      '--question', question,
    ]);

    let out = '';
    py.stdout.on('data', (d) => { out += d.toString(); });
    py.on('close', () => {
      fs.unlink(storesFile, () => {});
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
    return;
  }

  // Single RAG: existing behavior
  const py = spawn('python', [
    workerPath, 'query',
    '--provider', aiType,
    '--key',      apiKey,
    '--store',    storeId || storeIds?.[0]?.store_id,
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
  const { urls, api_key: apiKey, ai_type: aiType, name, schedule = 'never' } = req.body || {};
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
          r.filename   = name;
          r.file_count = r.files_uploaded?.length || 0;
          r.urls       = urls;
          r.schedule   = schedule;
          if (schedule !== 'never') r.scrape_ai_key = apiKey;
          saveRag(r).then(ragApiKey => {
            r.api_key = ragApiKey;
            if (schedule !== 'never' && urls?.length) {
              const job2 = scheduleCronForRag({ ...r, api_key: ragApiKey });
              if (job2) activeJobs.set(r.store_id, job2);
            }
            const job = jobs.get(jobId);
            job.result = r;
            job.status = 'done';
            emitter.emit('done', r);
          }).catch(e => {
            console.error('Erro ao salvar RAG:', e.message);
            const job = jobs.get(jobId);
            job.result = r;
            job.status = 'done';
            emitter.emit('done', r);
          });
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

async function updateRagFileCount(storeId, countDelta) {
  if (db) {
    await db.query(
      'UPDATE rags SET file_count = file_count + $1 WHERE store_id = $2',
      [countDelta, storeId]
    );
  } else {
    const files = fs.readdirSync(RAGS_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const ragFile = path.join(RAGS_DIR, f);
        const rag = JSON.parse(fs.readFileSync(ragFile, 'utf-8'));
        if (rag.store_id === storeId) {
          rag.file_count = (rag.file_count || 0) + countDelta;
          fs.writeFileSync(ragFile, JSON.stringify(rag, null, 2));
          break;
        }
      } catch {}
    }
  }
}

// ─── GET /rags/:storeId ───────────────────────────────────────
app.get('/rags/:storeId', async (req, res) => {
  try {
    const { storeId } = req.params;
    if (db) {
      const { rows } = await db.query(
        'SELECT store_id, store_name, provider, filename, file_count, created_at AS "createdAt" FROM rags WHERE store_id = $1',
        [storeId]
      );
      if (!rows.length) return res.status(404).json({ error: 'RAG não encontrado.' });
      return res.json(rows[0]);
    }
    const files = fs.readdirSync(RAGS_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const { api_key: _omit, ...rag } = JSON.parse(fs.readFileSync(path.join(RAGS_DIR, f), 'utf-8'));
        if (rag.store_id === storeId) return res.json(rag);
      } catch {}
    }
    res.status(404).json({ error: 'RAG não encontrado.' });
  } catch {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ─── POST /rags/:storeId/add ──────────────────────────────────
app.post('/rags/:storeId/add', upload.array('files', 20), (req, res) => {
  const { storeId } = req.params;
  const { api_key: apiKey, ai_type: aiType } = req.body;
  if (!req.files?.length || !apiKey || !aiType) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const jobId   = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  jobs.set(jobId, { emitter, status: 'running', result: null, error: null });
  res.json({ jobId });

  const renamedPaths = req.files.map(f => {
    const ext  = path.extname(f.originalname).toLowerCase();
    const dest = ext ? f.path + ext : f.path;
    if (ext) fs.renameSync(f.path, dest);
    return dest;
  });

  const filesManifest = path.join(__dirname, 'uploads', `files_${jobId}.json`);
  fs.writeFileSync(filesManifest, JSON.stringify(
    req.files.map((f, i) => ({ path: renamedPaths[i], name: f.originalname }))
  ));

  const py = spawn('python', [
    path.join(__dirname, 'rag_worker.py'), 'add',
    '--provider',   aiType,
    '--key',        apiKey,
    '--store',      storeId,
    '--files-file', filesManifest,
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
          const addedCount = r.files_uploaded?.length || 0;
          updateRagFileCount(storeId, addedCount).catch(e => console.error('Erro ao atualizar file_count:', e.message));
          const job = jobs.get(jobId);
          job.result = r;
          job.status = 'done';
          emitter.emit('done', { ...r, added: addedCount });
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
    renamedPaths.forEach(p => fs.unlink(p, () => {}));
    fs.unlink(filesManifest, () => {});
    const job = jobs.get(jobId);
    if (job && job.status === 'running') {
      job.status = 'error';
      job.error  = `Processo encerrado com código ${code}.`;
      emitter.emit('error', job.error);
    }
  });
});

// ─── POST /extract ────────────────────────────────────────────
app.post('/extract', upload.array('files', 20), (req, res) => {
  const { api_key: apiKey, ai_type: aiType } = req.body;
  if (!req.files?.length || !apiKey || !aiType) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const jobId   = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  jobs.set(jobId, { emitter, status: 'running', result: null, error: null });

  res.json({ jobId, aiType, apiKey: apiKey.substring(0, 8) + '...' });

  const workerPath = path.join(__dirname, 'rag_worker.py');
  const renamedPaths = req.files.map(f => {
    const ext  = path.extname(f.originalname).toLowerCase();
    const dest = ext ? f.path + ext : f.path;
    if (ext) fs.renameSync(f.path, dest);
    return dest;
  });

  const filesManifest = path.join(__dirname, 'uploads', `files_${jobId}.json`);
  fs.writeFileSync(filesManifest, JSON.stringify(
    req.files.map((f, i) => ({ path: renamedPaths[i], name: f.originalname }))
  ));

  const py = spawn('python', [workerPath, 'extract', '--files-file', filesManifest]);
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
          // Store metadata for confirm-upload
          r.renamedPaths  = renamedPaths;
          r.aiType        = aiType;
          r.apiKey        = apiKey;
          r.filesManifest = filesManifest;
          const job = jobs.get(jobId);
          job.result = r;
          job.status = 'done';
          emitter.emit('done', { previews: r.previews.map(p => ({ name: p.name, preview: p.text.slice(0, 500) })), jobId });
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

// ─── POST /confirm-upload ─────────────────────────────────────
app.post('/confirm-upload', async (req, res) => {
  const { extractJobId, edits, name } = req.body || {};
  if (!extractJobId || !edits?.length) {
    return res.status(400).json({ error: 'extractJobId e edits são obrigatórios.' });
  }

  const extractJob = jobs.get(extractJobId);
  if (!extractJob?.result) {
    return res.status(404).json({ error: 'Job de extração não encontrado.' });
  }

  const { aiType, apiKey, renamedPaths, filesManifest } = extractJob.result;
  jobs.delete(extractJobId); // libera memória e remove apiKey do Map

  const jobId   = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  jobs.set(jobId, { emitter, status: 'running', result: null, error: null });

  res.json({ jobId });

  // Merge: se o usuário editou, usa o texto editado; senão usa o original
  const originalPreviews = extractJob.result.previews;
  const editMap = Object.fromEntries(edits.map(e => [e.name, e.text]));
  const texts = originalPreviews.map(p => ({
    name: p.name,
    text: editMap[p.name] !== undefined ? editMap[p.name] : p.text,
  }));

  const displayName = texts.length === 1
    ? texts[0].name
    : `${texts[0].name} + ${texts.length - 1} outro${texts.length > 2 ? 's' : ''}`;

  const textsFile = path.join(__dirname, 'uploads', `texts_${jobId}.json`);
  fs.writeFileSync(textsFile, JSON.stringify(texts));

  const ragName = name || (texts[0]?.name || 'rag').replace(/\.[^.]+$/, '');

  const py = spawn('python', [
    path.join(__dirname, 'rag_worker.py'), 'upload-text',
    '--provider',   aiType,
    '--key',        apiKey,
    '--texts-file', textsFile,
    '--name',       ragName,
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
          r.filename   = displayName;
          r.file_count = r.files_uploaded?.length || 0;
          saveRag(r).then(apiKey => {
            r.api_key = apiKey;
            const job = jobs.get(jobId);
            job.result = r;
            job.status = 'done';
            emitter.emit('done', r);
          }).catch(e => {
            console.error('Erro ao salvar RAG:', e.message);
            const job = jobs.get(jobId);
            job.result = r;
            job.status = 'done';
            emitter.emit('done', r);
          });
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
    // Cleanup
    renamedPaths?.forEach(p => fs.unlink(p, () => {}));
    if (filesManifest) fs.unlink(filesManifest, () => {});
    fs.unlink(textsFile, () => {});
    const job = jobs.get(jobId);
    if (job && job.status === 'running') {
      job.status = 'error';
      job.error  = `Processo encerrado com código ${code}.`;
      emitter.emit('error', job.error);
    }
  });
});

// ─── GET /api/docs ────────────────────────────────────────────
app.get('/api/docs', (_req, res) => {
  res.type('application/json');
  res.json({
    openapi: '3.0.0',
    info: { title: 'FRONT RAG API', version: '1.0.0', description: 'Query RAG bases programmatically.' },
    paths: {
      '/api/v1/query': {
        post: {
          summary: 'Query a RAG base',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['question', 'ai_key'],
                  properties: {
                    question: { type: 'string', example: 'O que é X?' },
                    ai_key:   { type: 'string', example: 'sk-...' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Answer', content: { 'application/json': { schema: { type: 'object', properties: { answer: { type: 'string' }, citations: { type: 'array', items: { type: 'string' } } } } } } },
            401: { description: 'Invalid or missing API key' },
            429: { description: 'Rate limit exceeded' },
          },
        },
      },
    },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
  });
});

// ─── POST /api/v1/query ───────────────────────────────────────
app.post('/api/v1/query', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!apiKey) return res.status(401).json({ error: 'Authorization header obrigatório: Bearer {api_key}' });

  if (!checkRateLimit(apiKey)) {
    return res.status(429).json({ error: 'Rate limit excedido. Máximo: 60 requisições/minuto.' });
  }

  const { question, ai_key: aiKey } = req.body || {};
  if (!question?.trim() || !aiKey) {
    return res.status(400).json({ error: 'Campos obrigatórios: question, ai_key' });
  }
  // Guard against argv flag injection (spawn is used, not exec, but argparse could misparse leading dashes)
  if (typeof aiKey !== 'string' || aiKey.startsWith('-')) {
    return res.status(400).json({ error: 'Formato de ai_key inválido.' });
  }
  if (question.trimStart().startsWith('--')) {
    return res.status(400).json({ error: 'Formato de question inválido.' });
  }

  let rag;
  try { rag = await findRagByApiKey(apiKey); } catch { return res.status(500).json({ error: 'Erro interno.' }); }
  if (!rag) return res.status(401).json({ error: 'API key inválida.' });

  const workerPath = path.join(__dirname, 'rag_worker.py');
  const py = spawn('python', [
    workerPath, 'query',
    '--provider', rag.provider,
    '--key',      aiKey,
    '--store',    rag.store_id,
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

// ─── POST /feedback ───────────────────────────────────────────
app.post('/feedback', async (req, res) => {
  const { store_id, question, answer, rating } = req.body || {};
  if (!store_id || !rating || !['up', 'down'].includes(rating)) {
    return res.status(400).json({ error: 'store_id e rating (up|down) são obrigatórios.' });
  }
  try {
    if (db) {
      await db.query(
        'INSERT INTO feedback (store_id, question, answer, rating) VALUES ($1, $2, $3, $4)',
        [store_id, question || '', answer || '', rating]
      );
    } else {
      const feedbackFile = path.join(__dirname, 'rags', 'feedback.json');
      let entries = [];
      try { entries = JSON.parse(fs.readFileSync(feedbackFile, 'utf-8')); } catch {}
      entries.push({ store_id, question: question || '', answer: answer || '', rating, timestamp: new Date().toISOString() });
      fs.writeFileSync(feedbackFile, JSON.stringify(entries, null, 2));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /admin/feedback ──────────────────────────────────────
app.get('/admin/feedback', async (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  const provided   = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!adminToken || provided !== adminToken) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
  try {
    if (db) {
      const { rows } = await db.query(
        `SELECT store_id, question, answer, rating, created_at
         FROM feedback WHERE rating = 'down'
         ORDER BY question, created_at DESC`
      );
      return res.json(rows);
    }
    const feedbackFile = path.join(__dirname, 'rags', 'feedback.json');
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(feedbackFile, 'utf-8')); } catch {}
    const negatives = entries
      .filter(e => e.rating === 'down')
      .sort((a, b) => a.question.localeCompare(b.question));
    res.json(negatives);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Servidor rodando na porta ${PORT}\n`);
  initCronJobs();
});
