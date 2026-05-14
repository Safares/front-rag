'use strict';

const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const fileNameEl    = document.getElementById('file-name');
const uploadBtn     = document.getElementById('upload-btn');
const progressLog   = document.getElementById('progress-log');
const uploadStatus  = document.getElementById('upload-status');
const resultPanel   = document.getElementById('result-panel');
const chatPanel     = document.getElementById('chat-panel');
const chatBox       = document.getElementById('chat-box');
const questionInput = document.getElementById('question-input');
const sendBtn       = document.getElementById('send-btn');
const apiKeyInput   = document.getElementById('api_key');
const copyBtn       = document.getElementById('copy-btn');

// Estado da sessão atual
let session = { apiKey: '', aiType: '', storeId: '' };
let selectedFile = null;

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
  if (!allowed.includes(ext)) {
    showStatus('Formato não suportado. Use .txt, .md, .pdf, .xlsx ou .xls', 'error');
    return;
  }
  selectedFile = file;
  fileNameEl.textContent = file.name;
  fileNameEl.classList.remove('hidden');
  checkReady();
}

apiKeyInput.addEventListener('input', checkReady);

function checkReady() {
  uploadBtn.disabled = !(selectedFile && apiKeyInput.value.trim());
}

function getAiType() {
  return document.querySelector('input[name="ai_type"]:checked').value;
}

// ─── Criar RAG ────────────────────────────────────────────────
uploadBtn.addEventListener('click', async () => {
  if (!selectedFile || !apiKeyInput.value.trim()) return;

  uploadBtn.disabled = true;
  hideStatus();
  clearLog();
  progressLog.classList.remove('hidden');
  appendLog('Enviando arquivo...');

  const formData = new FormData();
  formData.append('file',    selectedFile);
  formData.append('api_key', apiKeyInput.value.trim());
  formData.append('ai_type', getAiType());

  let jobId;
  try {
    const res  = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.error) { showStatus(data.error, 'error'); uploadBtn.disabled = false; return; }
    jobId = data.jobId;
  } catch (e) {
    showStatus('Erro de conexão: ' + e.message, 'error');
    uploadBtn.disabled = false;
    return;
  }

  // SSE para progresso em tempo real
  const es = new EventSource(`/progress/${jobId}`);

  es.addEventListener('progress', (e) => {
    const { message } = JSON.parse(e.data);
    appendLog(message);
  });

  es.addEventListener('done', (e) => {
    es.close();
    const r = JSON.parse(e.data);
    appendLog('Concluido!');
    showResult(r);
  });

  es.addEventListener('error', (e) => {
    es.close();
    let msg = 'Erro desconhecido.';
    try { msg = JSON.parse(e.data).error; } catch {}
    showStatus(msg, 'error');
    uploadBtn.disabled = false;
  });
});

// ─── Painel de resultado ──────────────────────────────────────
function showResult(r) {
  const providerLabel = r.provider === 'openai' ? 'OpenAI GPT' : 'Google Gemini';
  const stem = r.filename ? r.filename.replace(/\.[^.]+$/, '') : 'arquivo';

  document.getElementById('r-filename').textContent = r.filename || '—';
  document.getElementById('r-provider').textContent = providerLabel;
  document.getElementById('r-store-id').textContent = r.store_id;
  document.getElementById('r-saved').textContent    = `rags/${stem}.json`;

  resultPanel.classList.remove('hidden');
  resultPanel.scrollIntoView({ behavior: 'smooth' });

  // Salva sessão para o chat
  session = { apiKey: apiKeyInput.value.trim(), aiType: r.provider, storeId: r.store_id };

  chatPanel.classList.remove('hidden');
  chatBox.innerHTML = '';
  addMessage(`RAG pronto! Pode fazer perguntas sobre "${r.filename}".`, 'assistant');
  chatPanel.scrollIntoView({ behavior: 'smooth' });
}

// ─── Copiar Store ID ──────────────────────────────────────────
copyBtn.addEventListener('click', () => {
  const id = document.getElementById('r-store-id').textContent;
  navigator.clipboard.writeText(id).then(() => {
    copyBtn.textContent = 'Copiado!';
    setTimeout(() => { copyBtn.textContent = 'Copiar Store ID'; }, 2000);
  });
});

// ─── Log de progresso ─────────────────────────────────────────
function appendLog(msg) {
  const div = document.createElement('div');
  div.className = 'log-line';
  div.textContent = msg;
  progressLog.appendChild(div);
  progressLog.scrollTop = progressLog.scrollHeight;
}

function clearLog() {
  progressLog.innerHTML = '';
}

// ─── Status bar ───────────────────────────────────────────────
function showStatus(msg, type) {
  uploadStatus.textContent = msg;
  uploadStatus.className   = `status ${type}`;
  uploadStatus.classList.remove('hidden');
}

function hideStatus() {
  uploadStatus.classList.add('hidden');
}

// ─── Chat ─────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendQuestion);
questionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) sendQuestion();
});

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
      body: JSON.stringify({
        question: q,
        api_key:  session.apiKey,
        ai_type:  session.aiType,
        store_id: session.storeId,
      }),
    });
    const data = await res.json();
    thinking.remove();
    addMessage(data.error ? 'Erro: ' + data.error : data.answer, 'assistant');
  } catch (e) {
    thinking.remove();
    addMessage('Erro de conexão: ' + e.message, 'assistant');
  }

  sendBtn.disabled = false;
  questionInput.focus();
}

function addMessage(text, role) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
  return div;
}

