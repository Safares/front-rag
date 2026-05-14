'use strict';

// ─── Elementos ────────────────────────────────────────────────
const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const fileNameEl    = document.getElementById('file-name');
const uploadBtn     = document.getElementById('upload-btn');
const urlInput      = document.getElementById('url-input');
const scanBtn       = document.getElementById('scan-btn');
const pagesPanel    = document.getElementById('pages-panel');
const pagesList     = document.getElementById('pages-list');
const pagesCount    = document.getElementById('pages-count');
const selectAllBtn  = document.getElementById('select-all-btn');
const deselectAllBtn= document.getElementById('deselect-all-btn');
const scrapeBtn     = document.getElementById('scrape-btn');
const progressLog   = document.getElementById('progress-log');
const uploadStatus  = document.getElementById('upload-status');
const resultPanel   = document.getElementById('result-panel');
const chatPanel     = document.getElementById('chat-panel');
const chatBox       = document.getElementById('chat-box');
const questionInput = document.getElementById('question-input');
const sendBtn       = document.getElementById('send-btn');
const apiKeyInput   = document.getElementById('api_key');
const copyBtn       = document.getElementById('copy-btn');

let selectedFile = null;
let session = { apiKey: '', aiType: '', storeId: '' };

// ─── Abas ─────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

// ─── Drop zone ────────────────────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });

function setFile(file) {
  const allowed = ['.txt', '.md', '.pdf', '.xlsx', '.xls'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!allowed.includes(ext)) { showStatus('Formato não suportado.', 'error'); return; }
  selectedFile = file;
  fileNameEl.textContent = file.name;
  fileNameEl.classList.remove('hidden');
  checkFileReady();
}

apiKeyInput.addEventListener('input', () => { checkFileReady(); checkUrlReady(); });
urlInput.addEventListener('input', checkUrlReady);

function checkFileReady() { uploadBtn.disabled = !(selectedFile && apiKeyInput.value.trim()); }
function checkUrlReady()  { scanBtn.disabled   = !(urlInput.value.trim() && apiKeyInput.value.trim()); }
function getAiType()      { return document.querySelector('input[name="ai_type"]:checked').value; }
function getDepth()  { return Number(document.querySelector('input[name="depth"]:checked').value); }
function getUseJs()  { return document.getElementById('use-js').checked; }

// ─── Criar RAG por arquivo ────────────────────────────────────
uploadBtn.addEventListener('click', async () => {
  if (!selectedFile || !apiKeyInput.value.trim()) return;
  uploadBtn.disabled = true;
  hideStatus(); clearLog();
  progressLog.classList.remove('hidden');
  appendLog('Enviando arquivo...');

  const formData = new FormData();
  formData.append('file',    selectedFile);
  formData.append('api_key', apiKeyInput.value.trim());
  formData.append('ai_type', getAiType());

  try {
    const res  = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.error) { showStatus(data.error, 'error'); uploadBtn.disabled = false; return; }
    listenProgress(data.jobId, () => { uploadBtn.disabled = false; });
  } catch (e) {
    showStatus('Erro de conexão: ' + e.message, 'error');
    uploadBtn.disabled = false;
  }
});

// ─── Escanear páginas ─────────────────────────────────────────
scanBtn.addEventListener('click', async () => {
  if (!urlInput.value.trim()) return;
  scanBtn.disabled = true;
  pagesPanel.classList.add('hidden');
  pagesList.innerHTML = '';
  hideStatus(); clearLog();
  progressLog.classList.remove('hidden');
  appendLog('Escaneando páginas...');

  try {
    const res  = await fetch('/crawl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlInput.value.trim(), depth: getDepth(), use_js: getUseJs() }),
    });
    const data = await res.json();
    if (data.error) { showStatus(data.error, 'error'); scanBtn.disabled = false; return; }

    const es = new EventSource(`/progress/${data.jobId}`);

    es.addEventListener('progress', (e) => {
      appendLog(JSON.parse(e.data).message);
    });

    es.addEventListener('done', (e) => {
      es.close();
      const { pages } = JSON.parse(e.data);
      if (!pages?.length) { showStatus('Nenhuma página encontrada.', 'error'); scanBtn.disabled = false; return; }
      renderPagesList(pages);
      scanBtn.disabled = false;
    });

    es.addEventListener('error', (e) => {
      es.close();
      let msg = 'Erro ao escanear.';
      try { msg = JSON.parse(e.data).error; } catch {}
      showStatus(msg, 'error');
      scanBtn.disabled = false;
    });
  } catch (e) {
    showStatus('Erro de conexão: ' + e.message, 'error');
    scanBtn.disabled = false;
  }
});

function renderPagesList(pages) {
  pagesList.innerHTML = '';
  pages.forEach((p, i) => {
    const row = document.createElement('label');
    row.className = 'page-row';
    row.innerHTML = `
      <input type="checkbox" class="page-check" data-url="${p.url}" data-title="${p.title.replace(/"/g, '&quot;')}" checked />
      <span class="page-title">${p.title}</span>
      <span class="page-url">${p.url}</span>
    `;
    pagesList.appendChild(row);
  });
  updatePagesCount();
  pagesList.querySelectorAll('.page-check').forEach(cb => cb.addEventListener('change', updatePagesCount));
  pagesPanel.classList.remove('hidden');
  pagesPanel.scrollIntoView({ behavior: 'smooth' });
}

function updatePagesCount() {
  const total    = pagesList.querySelectorAll('.page-check').length;
  const selected = pagesList.querySelectorAll('.page-check:checked').length;
  pagesCount.textContent = `${selected} de ${total} páginas selecionadas`;
  scrapeBtn.disabled = selected === 0;
  scrapeBtn.textContent = `Criar RAG com ${selected} página${selected !== 1 ? 's' : ''} selecionada${selected !== 1 ? 's' : ''}`;
}

selectAllBtn.addEventListener('click',   () => { pagesList.querySelectorAll('.page-check').forEach(cb => cb.checked = true);  updatePagesCount(); });
deselectAllBtn.addEventListener('click', () => { pagesList.querySelectorAll('.page-check').forEach(cb => cb.checked = false); updatePagesCount(); });

// ─── Criar RAG por scraping ───────────────────────────────────
scrapeBtn.addEventListener('click', async () => {
  const checked = [...pagesList.querySelectorAll('.page-check:checked')];
  if (!checked.length) return;

  scrapeBtn.disabled = true;
  scanBtn.disabled   = true;
  clearLog();
  progressLog.classList.remove('hidden');
  appendLog(`Iniciando scraping de ${checked.length} páginas...`);

  const urls = checked.map(cb => cb.dataset.url);
  const name = new URL(urlInput.value.trim()).hostname;

  try {
    const res  = await fetch('/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls,
        api_key: apiKeyInput.value.trim(),
        ai_type: getAiType(),
        name,
      }),
    });
    const data = await res.json();
    if (data.error) { showStatus(data.error, 'error'); scrapeBtn.disabled = false; scanBtn.disabled = false; return; }
    listenProgress(data.jobId, () => { scrapeBtn.disabled = false; scanBtn.disabled = false; });
  } catch (e) {
    showStatus('Erro de conexão: ' + e.message, 'error');
    scrapeBtn.disabled = false;
    scanBtn.disabled   = false;
  }
});

// ─── SSE helper reutilizável ──────────────────────────────────
function listenProgress(jobId, onError) {
  const es = new EventSource(`/progress/${jobId}`);

  es.addEventListener('progress', (e) => {
    appendLog(JSON.parse(e.data).message);
  });

  es.addEventListener('done', (e) => {
    es.close();
    showResult(JSON.parse(e.data));
  });

  es.addEventListener('error', (e) => {
    es.close();
    let msg = 'Erro desconhecido.';
    try { msg = JSON.parse(e.data).error; } catch {}
    showStatus(msg, 'error');
    if (onError) onError();
  });
}

// ─── Resultado ────────────────────────────────────────────────
function showResult(r) {
  document.getElementById('r-filename').textContent = r.filename || '—';
  document.getElementById('r-provider').textContent = r.provider === 'openai' ? 'OpenAI GPT' : 'Google Gemini';
  document.getElementById('r-store-id').textContent = r.store_id;
  document.getElementById('r-saved').textContent    = `rags/${(r.filename || 'rag').replace(/\.[^.]+$/, '')}.json`;

  resultPanel.classList.remove('hidden');
  resultPanel.scrollIntoView({ behavior: 'smooth' });

  session = { apiKey: apiKeyInput.value.trim(), aiType: r.provider, storeId: r.store_id };

  chatPanel.classList.remove('hidden');
  chatBox.innerHTML = '';
  addMessage(`RAG pronto! Pode fazer perguntas sobre "${r.filename}".`, 'assistant');
  chatPanel.scrollIntoView({ behavior: 'smooth' });
}

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('r-store-id').textContent).then(() => {
    copyBtn.textContent = 'Copiado!';
    setTimeout(() => { copyBtn.textContent = 'Copiar Store ID'; }, 2000);
  });
});

// ─── Log ──────────────────────────────────────────────────────
function appendLog(msg) {
  const div = document.createElement('div');
  div.className   = 'log-line';
  div.textContent = msg;
  progressLog.appendChild(div);
  progressLog.scrollTop = progressLog.scrollHeight;
}
function clearLog()  { progressLog.innerHTML = ''; }

// ─── Status ───────────────────────────────────────────────────
function showStatus(msg, type) {
  uploadStatus.textContent = msg;
  uploadStatus.className   = `status ${type}`;
  uploadStatus.classList.remove('hidden');
}
function hideStatus() { uploadStatus.classList.add('hidden'); }

// ─── Chat ─────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendQuestion);
questionInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) sendQuestion(); });

async function sendQuestion() {
  const q = questionInput.value.trim();
  if (!q || !session.storeId) return;
  questionInput.value = '';
  sendBtn.disabled = true;
  addMessage(q, 'user');
  const thinking = addMessage('Pensando...', 'thinking');

  try {
    const res = await fetch('/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, api_key: session.apiKey, ai_type: session.aiType, store_id: session.storeId }),
    });
    const data = await res.json();
    thinking.remove();
    addMessage(data.error ? 'Erro: ' + data.error : data.answer, 'assistant');
  } catch (e) {
    thinking.remove();
    addMessage('Erro: ' + e.message, 'assistant');
  }

  sendBtn.disabled = false;
  questionInput.focus();
}

function addMessage(text, role) {
  const div = document.createElement('div');
  div.className   = 'msg ' + role;
  div.textContent = text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
  return div;
}
