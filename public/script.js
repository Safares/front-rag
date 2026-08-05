'use strict';

// ─── Elementos ────────────────────────────────────────────────
const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const fileListEl    = document.getElementById('file-list');
const uploadBtn     = document.getElementById('upload-btn');
const urlInput      = document.getElementById('url-input');
const scanBtn       = document.getElementById('scan-btn');
const pagesPanel    = document.getElementById('pages-panel');
const pagesList     = document.getElementById('pages-list');
const pagesCount    = document.getElementById('pages-count');
const selectAllBtn  = document.getElementById('select-all-btn');
const deselectAllBtn= document.getElementById('deselect-all-btn');
const scrapeBtn     = document.getElementById('scrape-btn');
const progressLog      = document.getElementById('progress-log');
const previewPanel     = document.getElementById('preview-panel');
const previewList      = document.getElementById('preview-list');
const confirmBtn       = document.getElementById('confirm-btn');
const cancelPreviewBtn = document.getElementById('cancel-preview-btn');
const uploadStatus     = document.getElementById('upload-status');
const resultPanel   = document.getElementById('result-panel');
const chatPanel     = document.getElementById('chat-panel');
const chatBox       = document.getElementById('chat-box');
const questionInput = document.getElementById('question-input');
const sendBtn       = document.getElementById('send-btn');
const apiKeyInput   = document.getElementById('api_key');
const copyBtn       = document.getElementById('copy-btn');
const testPanel          = document.getElementById('test-panel');
const testCsvInput       = document.getElementById('test-csv-input');
const importCsvBtn       = document.getElementById('import-csv-btn');
const addTestQuestionBtn = document.getElementById('add-test-question-btn');
const testQuestionsList  = document.getElementById('test-questions-list');
const runTestBtn         = document.getElementById('run-test-btn');
const closeTestBtn       = document.getElementById('close-test-btn');
const testProgressLog    = document.getElementById('test-progress-log');
const testResults        = document.getElementById('test-results');

let selectedFiles = [];
let session = { apiKey: '', aiType: '', storeId: '', storeIds: null };
let extractJobId = null;
let lastQuestion  = '';
let selectedRags = [];  // array of {store_id, provider, filename}
let testRag = null;     // RAG currently being tested

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
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) addFiles(fileInput.files);
  fileInput.value = '';
});

const ALLOWED_EXTS = ['.txt', '.md', '.pdf', '.xlsx', '.xls', '.csv', '.docx', '.pptx'];

function addFiles(fileList) {
  let added = 0;
  for (const file of fileList) {
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) { showStatus(`Formato não suportado: ${file.name}`, 'error'); continue; }
    if (selectedFiles.some(f => f.name === file.name)) continue;
    selectedFiles.push(file);
    added++;
  }
  if (added > 0) hideStatus();
  renderFileList();
  checkFileReady();
}

function renderFileList() {
  if (!selectedFiles.length) { fileListEl.classList.add('hidden'); return; }
  fileListEl.classList.remove('hidden');
  fileListEl.innerHTML = '';
  selectedFiles.forEach((file, i) => {
    const size = file.size < 1024 * 1024
      ? `${(file.size / 1024).toFixed(1)} KB`
      : `${(file.size / 1024 / 1024).toFixed(1)} MB`;
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
      <div class="file-item-info">
        <span class="file-item-name">${file.name}</span>
        <span class="file-item-size">${size}</span>
      </div>
      <button class="file-remove" data-idx="${i}" title="Remover">&times;</button>
    `;
    item.querySelector('.file-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      selectedFiles.splice(Number(e.currentTarget.dataset.idx), 1);
      renderFileList();
      checkFileReady();
    });
    fileListEl.appendChild(item);
  });
}

apiKeyInput.addEventListener('input', () => { checkFileReady(); checkUrlReady(); });
urlInput.addEventListener('input', checkUrlReady);

function checkFileReady() { uploadBtn.disabled = !(selectedFiles.length > 0 && apiKeyInput.value.trim()); }
function checkUrlReady()  { scanBtn.disabled   = !(urlInput.value.trim() && apiKeyInput.value.trim()); }
function getAiType()      { return document.querySelector('input[name="ai_type"]:checked').value; }
function getDepth()  { return Number(document.querySelector('input[name="depth"]:checked').value); }
function getUseJs()      { return document.getElementById('use-js').checked; }
function getScrapeSchedule() { return document.querySelector('input[name="scrape_schedule"]:checked')?.value || 'never'; }

// ─── Criar RAG por arquivo (fase 1: extrair) ─────────────────
uploadBtn.addEventListener('click', async () => {
  if (!selectedFiles.length || !apiKeyInput.value.trim()) return;
  uploadBtn.disabled = true;
  hideStatus(); clearLog();
  progressLog.classList.remove('hidden');
  previewPanel.classList.add('hidden');
  appendLog(`Extraindo texto de ${selectedFiles.length} arquivo${selectedFiles.length > 1 ? 's' : ''}...`);

  const formData = new FormData();
  for (const file of selectedFiles) formData.append('files', file);
  formData.append('api_key', apiKeyInput.value.trim());
  formData.append('ai_type', getAiType());

  try {
    const res  = await fetch('/extract', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.error) { showStatus(data.error, 'error'); uploadBtn.disabled = false; return; }

    const es = new EventSource(`/progress/${data.jobId}`);
    es.addEventListener('progress', (e) => appendLog(JSON.parse(e.data).message));
    es.addEventListener('done', (e) => {
      es.close();
      const { previews, jobId } = JSON.parse(e.data);
      extractJobId = jobId;
      showPreviewPanel(previews);
      uploadBtn.disabled = false;
    });
    es.addEventListener('error', (e) => {
      es.close();
      let msg = 'Erro ao extrair.';
      try { msg = JSON.parse(e.data).error; } catch {}
      showStatus(msg, 'error');
      uploadBtn.disabled = false;
    });
  } catch (e) {
    showStatus('Erro de conexão: ' + e.message, 'error');
    uploadBtn.disabled = false;
  }
});

function showPreviewPanel(previews) {
  previewList.innerHTML = '';
  previews.forEach((p) => {
    const item = document.createElement('div');
    item.style.cssText = 'margin-bottom:16px';

    const label = document.createElement('div');
    label.style.cssText = 'font-weight:600;margin-bottom:6px;font-size:0.9rem';
    label.textContent = p.name;
    item.appendChild(label);

    if (p.already_chunked !== undefined) {
      const badge = document.createElement('div');
      badge.style.cssText = `margin-bottom:8px;padding:6px 10px;border-radius:6px;font-size:0.8rem;
        background:${p.already_chunked ? 'rgba(74,222,128,0.12)' : 'rgba(251,191,36,0.12)'};
        color:${p.already_chunked ? '#4ade80' : '#fbbf24'};
        border:1px solid ${p.already_chunked ? '#4ade80' : '#fbbf24'}`;
      badge.textContent = (p.already_chunked
        ? '✓ Já dividido em chunks — será enviado como está. '
        : '⚠ Será recortado automaticamente. ') + (p.chunk_note || '');
      item.appendChild(badge);
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'preview-textarea';
    textarea.dataset.name = p.name;
    textarea.dataset.original = p.preview;
    textarea.style.cssText = 'width:100%;height:600px;box-sizing:border-box;background:#1a1a2e;color:#e2e8f0;border:1px solid #4c1d95;border-radius:8px;padding:10px;font-family:monospace;font-size:0.8rem;resize:vertical;overflow:auto';
    textarea.value = p.preview;

    const hint = document.createElement('small');
    hint.style.opacity = '0.6';
    hint.textContent = 'Confirme ou edite o texto antes de indexar.';

    item.appendChild(textarea);
    item.appendChild(hint);
    previewList.appendChild(item);
  });
  previewPanel.classList.remove('hidden');
  previewPanel.scrollIntoView({ behavior: 'smooth' });
}

// ─── Confirmar e criar RAG (fase 2: upload) ───────────────────
confirmBtn.addEventListener('click', async () => {
  console.log('[CONFIRM] extractJobId:', extractJobId);
  if (!extractJobId) { 
    console.error('[CONFIRM] extractJobId está vazio!');
    showStatus('Erro: Nenhum arquivo foi extraído. Tente fazer upload novamente.', 'error');
    return;
  }
  confirmBtn.disabled = true;
  hideStatus(); clearLog();
  progressLog.classList.remove('hidden');
  appendLog('Iniciando indexação...');

  const edits = [...previewList.querySelectorAll('.preview-textarea')]
    .filter(ta => ta.value !== ta.dataset.original)
    .map(ta => ({ name: ta.dataset.name, text: ta.value }));

  console.log('[CONFIRM] edits:', edits.length, 'textareas found:', previewList.querySelectorAll('.preview-textarea').length);

  try {
    const payload = { extractJobId, edits, name: selectedFiles[0]?.name };
    console.log('[CONFIRM] Enviando:', JSON.stringify(payload).substring(0, 100));
    
    const res  = await fetch('/confirm-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    console.log('[CONFIRM] Response:', data);
    
    if (data.error) { showStatus(data.error, 'error'); confirmBtn.disabled = false; return; }
    previewPanel.classList.add('hidden');
    listenProgress(data.jobId, () => { confirmBtn.disabled = false; });
  } catch (e) {
    console.error('[CONFIRM] Exception:', e);
    showStatus('Erro de conexão: ' + e.message, 'error');
    confirmBtn.disabled = false;
  }
});

cancelPreviewBtn.addEventListener('click', () => {
  previewPanel.classList.add('hidden');
  extractJobId = null;
  uploadBtn.disabled = false;
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
        schedule: getScrapeSchedule(),
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
  const apiKeyEl = document.getElementById('r-api-key');
  if (apiKeyEl) apiKeyEl.textContent = r.api_key || '—';

  resultPanel.classList.remove('hidden');
  resultPanel.scrollIntoView({ behavior: 'smooth' });

  session = { apiKey: apiKeyInput.value.trim(), aiType: r.provider, storeId: r.store_id };

  chatPanel.classList.remove('hidden');
  const existing = loadHistory(r.store_id);
  if (existing.length > 0) {
    renderHistory(r.store_id);
  } else {
    addMessage(`RAG pronto! Pode fazer perguntas sobre "${r.filename}".`, 'assistant');
    appendToHistory(r.store_id, 'assistant', `RAG pronto! Pode fazer perguntas sobre "${r.filename}".`);
  }
  chatPanel.scrollIntoView({ behavior: 'smooth' });
}

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('r-store-id').textContent).then(() => {
    copyBtn.textContent = 'Copiado!';
    setTimeout(() => { copyBtn.textContent = 'Copiar Store ID'; }, 2000);
  });
});

const copyApiKeyBtn = document.getElementById('copy-api-key-btn');
copyApiKeyBtn.addEventListener('click', () => {
  const key = document.getElementById('r-api-key').textContent;
  if (!key || key === '—') return;
  navigator.clipboard.writeText(key).then(() => {
    copyApiKeyBtn.textContent = 'Copiado!';
    setTimeout(() => { copyApiKeyBtn.textContent = 'Copiar API Key'; }, 2000);
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

// ─── Histórico localStorage ───────────────────────────────────
const CHAT_HISTORY_LIMIT = 50;

function historyKey(storeId) {
  return `chat_${storeId}`;
}

function loadHistory(storeId) {
  try {
    return JSON.parse(localStorage.getItem(historyKey(storeId)) || '[]');
  } catch {
    return [];
  }
}

function saveHistory(storeId, messages) {
  const trimmed = messages.slice(-CHAT_HISTORY_LIMIT);
  localStorage.setItem(historyKey(storeId), JSON.stringify(trimmed));
}

function appendToHistory(storeId, role, text, citations = []) {
  const messages = loadHistory(storeId);
  messages.push({ role, text, citations });
  saveHistory(storeId, messages);
}

function renderHistory(storeId) {
  chatBox.innerHTML = '';
  const messages = loadHistory(storeId);
  messages.forEach(m => addMessage(m.text, m.role, m.citations || []));
}

function clearHistory(storeId) {
  localStorage.removeItem(historyKey(storeId));
}

// ─── Exportar conversa ────────────────────────────────────────
const exportChatBtn = document.getElementById('export-chat-btn');

exportChatBtn.addEventListener('click', () => {
  if (!session.storeId && !session.storeIds?.length) return;
  showExportMenu();
});

function showExportMenu() {
  // Remove menu anterior se existir
  const existing = document.getElementById('export-menu');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'export-menu';
  menu.className = 'export-menu';

  const mdBtn = document.createElement('button');
  mdBtn.textContent = 'Markdown (.md)';
  mdBtn.addEventListener('click', () => { exportAsMarkdown(); menu.remove(); });

  const pdfBtn = document.createElement('button');
  pdfBtn.textContent = 'PDF (.pdf)';
  pdfBtn.addEventListener('click', () => { exportAsPDF(); menu.remove(); });

  menu.appendChild(mdBtn);
  menu.appendChild(pdfBtn);

  // Posicionar próximo ao botão
  exportChatBtn.parentNode.appendChild(menu);

  // Fechar ao clicar fora
  setTimeout(() => {
    document.addEventListener('click', function closeMenu(e) {
      if (!menu.contains(e.target) && e.target !== exportChatBtn) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    });
  }, 0);
}

function buildMarkdownText() {
  const ragName = document.getElementById('r-filename').textContent || session.storeId;
  const date    = new Date().toLocaleDateString('pt-BR');
  const messages = loadHistory(session.storeId);

  let md = `# Chat com ${ragName} — ${date}\n\n`;
  messages.forEach(m => {
    if (m.role === 'user') {
      md += `**Você:** ${m.text}\n\n`;
    } else if (m.role === 'assistant') {
      md += `**IA:** ${m.text}\n`;
      if (m.citations?.length) {
        md += `\n*Fontes: ${m.citations.join(', ')}*\n`;
      }
      md += '\n---\n\n';
    }
  });
  return md;
}

function exportAsMarkdown() {
  const ragName = document.getElementById('r-filename').textContent || 'chat';
  const md      = buildMarkdownText();
  const blob    = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement('a');
  a.href        = url;
  a.download    = `chat-${ragName.replace(/[^a-z0-9]/gi, '_')}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportAsPDF() {
  const ragName  = document.getElementById('r-filename').textContent || session.storeId;
  const date     = new Date().toLocaleDateString('pt-BR');
  const messages = loadHistory(session.storeId);

  const printWindow = window.open('', '_blank');
  if (!printWindow) return;

  const doc = printWindow.document;
  doc.documentElement.lang = 'pt-BR';

  // Build <head> with safe DOM APIs — never interpolate ragName into innerHTML
  const metaEl = doc.createElement('meta');
  metaEl.setAttribute('charset', 'UTF-8');
  const titleEl = doc.createElement('title');
  titleEl.textContent = `Chat — ${ragName}`;
  const styleEl = doc.createElement('style');
  styleEl.textContent = [
    'body{font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px;color:#1a1a2e}',
    'h1{color:#7c3aed}',
    '.msg-user{background:#f3f0ff;padding:10px 14px;border-radius:8px;margin:8px 0}',
    '.msg-ai{background:#f8fafc;padding:10px 14px;border-radius:8px;margin:8px 0;border-left:3px solid #7c3aed}',
    '.label{font-weight:bold;font-size:.85em;color:#7c3aed;margin-bottom:4px}',
    '.citations{font-size:.8em;color:#6b7280;margin-top:4px}',
    'hr{border:none;border-top:1px solid #e5e7eb;margin:16px 0}',
  ].join('');
  doc.head.appendChild(metaEl);
  doc.head.appendChild(titleEl);
  doc.head.appendChild(styleEl);

  const body = doc.body;

  const h1 = doc.createElement('h1');
  h1.textContent = `Chat com ${ragName}`;
  body.appendChild(h1);

  const meta = doc.createElement('p');
  meta.style.color = '#6b7280';
  meta.textContent = `Exportado em ${date}`;
  body.appendChild(meta);

  const hr = doc.createElement('hr');
  body.appendChild(hr);

  messages.forEach(m => {
    if (m.role === 'user') {
      const wrap = doc.createElement('div');
      wrap.className = 'msg-user';
      const label = doc.createElement('div');
      label.className = 'label';
      label.textContent = 'Você';
      const text = doc.createElement('div');
      text.textContent = m.text;
      wrap.appendChild(label);
      wrap.appendChild(text);
      body.appendChild(wrap);
    } else if (m.role === 'assistant') {
      const wrap = doc.createElement('div');
      wrap.className = 'msg-ai';
      const label = doc.createElement('div');
      label.className = 'label';
      label.textContent = 'IA';
      const text = doc.createElement('div');
      text.textContent = m.text;
      wrap.appendChild(label);
      wrap.appendChild(text);
      if (m.citations?.length) {
        const cit = doc.createElement('div');
        cit.className = 'citations';
        cit.textContent = `Fontes: ${m.citations.join(', ')}`;
        wrap.appendChild(cit);
      }
      body.appendChild(wrap);
    }
  });

  printWindow.print();
}

// ─── Chat ─────────────────────────────────────────────────────
const clearHistoryBtn = document.getElementById('clear-history-btn');
clearHistoryBtn.addEventListener('click', () => {
  if (session.storeId) clearHistory(session.storeId);
  chatBox.innerHTML = '';
  addMessage('Conversa limpa. Faça uma nova pergunta.', 'assistant');
});

sendBtn.addEventListener('click', sendQuestion);
questionInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) sendQuestion(); });

async function sendQuestion() {
  const q = questionInput.value.trim();
  if (!q || (!session.storeId && !session.storeIds?.length)) return;
  questionInput.value = '';
  sendBtn.disabled = true;
  lastQuestion = q;
  addMessage(q, 'user');
  // Only persist history for single-RAG sessions
  if (session.storeId) appendToHistory(session.storeId, 'user', q);
  const thinking = addMessage('Pensando...', 'thinking');

  const queryBody = {
    question: q,
    api_key: session.apiKey,
    ai_type: session.aiType,
  };
  if (session.storeIds) {
    queryBody.store_ids = session.storeIds;
  } else {
    queryBody.store_id = session.storeId;
  }

  try {
    const res = await fetch('/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(queryBody),
    });
    const data = await res.json();
    thinking.remove();
    const answerText = data.error ? 'Erro: ' + data.error : (data.answer || '');
    const answerCitations = data.error ? [] : (data.citations || []);
    addMessage(answerText, 'assistant', answerCitations);
    // Only persist history for single-RAG sessions
    if (session.storeId) appendToHistory(session.storeId, 'assistant', answerText, answerCitations);
  } catch (e) {
    thinking.remove();
    const errText = 'Erro: ' + e.message;
    addMessage(errText, 'assistant');
    if (session.storeId) appendToHistory(session.storeId, 'assistant', errText);
  }

  sendBtn.disabled = false;
  questionInput.focus();
}

function addMessage(text, role, citations = []) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;

  const textEl = document.createElement('span');
  textEl.className = 'msg-text';
  textEl.textContent = text;
  div.appendChild(textEl);

  if (citations && citations.length > 0) {
    const citDiv = document.createElement('div');
    citDiv.className = 'msg-citations';
    citations.forEach(c => {
      const chip = document.createElement('span');
      chip.className = 'citation-chip';
      chip.textContent = c;
      citDiv.appendChild(chip);
    });
    div.appendChild(citDiv);
  }

  if (role === 'assistant') {
    const fbDiv = document.createElement('div');
    fbDiv.className = 'feedback-btns';
    ['up', 'down'].forEach(rating => {
      const btn = document.createElement('button');
      btn.className = 'feedback-btn';
      btn.dataset.rating = rating;
      btn.textContent = rating === 'up' ? '👍' : '👎';
      btn.addEventListener('click', () => sendFeedback(rating, div, textEl.textContent));
      fbDiv.appendChild(btn);
    });
    div.appendChild(fbDiv);
  }

  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
  return div;
}

function sendFeedback(rating, msgEl, answerText) {
  const storeId = session.storeId || session.storeIds?.[0]?.store_id || '';
  fetch('/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ store_id: storeId, question: lastQuestion, answer: answerText, rating }),
  }).catch(() => {});
  msgEl.querySelectorAll('.feedback-btn').forEach(b => { b.disabled = true; });
  msgEl.querySelector(`.feedback-btn[data-rating="${rating}"]`)?.classList.add('feedback-btn--chosen');
}

// ─── Chat manual (RAG existente por Store ID) ─────────────────
const manualStoreIdInput = document.getElementById('manual-store-id');
const manualApiKeyInput  = document.getElementById('manual-api-key');
const manualChatBtn      = document.getElementById('manual-chat-btn');

function getManualAiType() {
  return document.querySelector('input[name="manual_ai_type"]:checked').value;
}

manualChatBtn.addEventListener('click', () => {
  const storeId = manualStoreIdInput.value.trim();
  const apiKey  = manualApiKeyInput.value.trim();
  if (!storeId || !apiKey) {
    showStatus('Informe o Store ID e a API key para abrir o chat.', 'error');
    return;
  }
  const aiType = getManualAiType();
  session = { apiKey, aiType, storeId };

  document.getElementById('r-filename').textContent = storeId;
  document.getElementById('r-provider').textContent = aiType === 'openai' ? 'OpenAI GPT' : 'Google Gemini';
  document.getElementById('r-store-id').textContent = storeId;
  document.getElementById('r-saved').textContent = '—';
  const apiKeyEl = document.getElementById('r-api-key');
  if (apiKeyEl) apiKeyEl.textContent = '—';
  resultPanel.classList.remove('hidden');

  chatPanel.classList.remove('hidden');
  const existing = loadHistory(storeId);
  if (existing.length > 0) {
    renderHistory(storeId);
  } else {
    chatBox.innerHTML = '';
    addMessage(`Chat conectado ao RAG "${storeId}". Faça uma pergunta!`, 'assistant');
  }
  chatPanel.scrollIntoView({ behavior: 'smooth' });
});

// ─── Dashboard de RAGs ────────────────────────────────────────
const ragsDashboard  = document.getElementById('rags-dashboard');
const ragsList       = document.getElementById('rags-list');
const refreshRagsBtn = document.getElementById('refresh-rags-btn');

async function loadRags() {
  // Reset multi-RAG selection state
  selectedRags = [];
  const existingMultiBtn = document.getElementById('multi-query-btn');
  if (existingMultiBtn) existingMultiBtn.remove();

  try {
    const res  = await fetch('/rags');
    const rags = await res.json();
    if (!Array.isArray(rags) || !rags.length) {
      ragsDashboard.style.display = 'none';
      return;
    }
    ragsDashboard.style.display = '';
    ragsList.innerHTML = '';
    rags.forEach(rag => {
      const card = document.createElement('div');
      card.className = 'rag-card';

      const providerLabel = rag.provider === 'openai' ? '🤖 OpenAI' : '✨ Gemini';
      const dateStr = rag.createdAt
        ? new Date(rag.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
        : '—';
      const fileCount = rag.file_count != null ? `${rag.file_count} arquivo${rag.file_count !== 1 ? 's' : ''}` : '—';
      const scheduleLabel = rag.schedule === 'daily' ? ' · Atualização diária' : rag.schedule === 'weekly' ? ' · Atualização semanal' : '';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'rag-select-check';
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          if (!selectedRags.some(r => r.store_id === rag.store_id)) selectedRags.push(rag);
        } else {
          selectedRags = selectedRags.filter(r => r.store_id !== rag.store_id);
        }
        updateMultiQueryBtn();
      });

      const nameEl = document.createElement('div');
      nameEl.className = 'rag-card-name';
      nameEl.textContent = rag.filename || rag.store_name || rag.store_id;

      const metaEl = document.createElement('div');
      metaEl.className = 'rag-card-meta';
      metaEl.textContent = `${providerLabel} · ${fileCount} · ${dateStr}${scheduleLabel}`;

      const useBtn = document.createElement('button');
      useBtn.className = 'btn-text';
      useBtn.textContent = 'Usar';
      useBtn.addEventListener('click', () => selectRag(rag));

      const addBtn = document.createElement('button');
      addBtn.className = 'btn-text';
      addBtn.textContent = 'Adicionar';
      addBtn.addEventListener('click', () => openAddFilesDialog(rag));

      const testBtn = document.createElement('button');
      testBtn.className = 'btn-text';
      testBtn.textContent = 'Testar';
      testBtn.addEventListener('click', () => openTestPanel(rag));

      const resetBtn = document.createElement('button');
      resetBtn.className = 'btn-text';
      resetBtn.textContent = 'Substituir conteúdo';
      resetBtn.addEventListener('click', () => resetRagContent(rag));

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-text';
      deleteBtn.textContent = 'Excluir';
      deleteBtn.style.color = '#f87171';
      deleteBtn.addEventListener('click', () => deleteRag(rag));

      card.insertBefore(checkbox, card.firstChild);
      card.appendChild(nameEl);
      card.appendChild(metaEl);
      card.appendChild(useBtn);
      card.appendChild(addBtn);
      card.appendChild(testBtn);
      card.appendChild(resetBtn);
      card.appendChild(deleteBtn);
      ragsList.appendChild(card);
    });
  } catch {
    ragsDashboard.style.display = 'none';
  }
}

function updateMultiQueryBtn() {
  let btn = document.getElementById('multi-query-btn');
  if (selectedRags.length >= 2) {
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'multi-query-btn';
      btn.className = 'btn-primary';
      btn.style.cssText = 'margin-top:12px;width:100%';
      btn.addEventListener('click', startMultiRagChat);
      ragsDashboard.appendChild(btn);
    }
    btn.textContent = `Consultar ${selectedRags.length} RAGs selecionados`;
  } else {
    if (btn) btn.remove();
  }
}

function startMultiRagChat() {
  if (!apiKeyInput.value.trim()) {
    showStatus('Insira sua API key antes de consultar.', 'error');
    apiKeyInput.focus();
    return;
  }
  if (selectedRags.length < 2) return;

  // Use first RAG's provider (mixed providers not supported in a single query)
  const aiType = selectedRags[0].provider;
  const names = selectedRags.map(r => r.filename || r.store_id).join(', ');

  session = {
    apiKey: apiKeyInput.value.trim(),
    aiType,
    storeId: null,
    storeIds: selectedRags.map(r => ({ store_id: r.store_id, name: r.filename || r.store_id, provider: r.provider })),
  };

  document.getElementById('r-filename').textContent = `Multi-RAG: ${names}`;
  document.getElementById('r-provider').textContent = aiType === 'openai' ? 'OpenAI GPT' : 'Google Gemini';
  document.getElementById('r-store-id').textContent = selectedRags.map(r => r.store_id).join(', ');
  document.getElementById('r-saved').textContent = '—';
  resultPanel.classList.remove('hidden');

  chatPanel.classList.remove('hidden');
  chatBox.innerHTML = '';
  addMessage(`Chat multi-RAG ativo com: ${names}. Faça uma pergunta!`, 'assistant');
  chatPanel.scrollIntoView({ behavior: 'smooth' });
}

function openAddFilesDialog(rag) {
  if (!apiKeyInput.value.trim()) {
    showStatus('Insira sua API key antes de adicionar arquivos.', 'error');
    apiKeyInput.focus();
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.md,.pdf,.xlsx,.xls,.csv,.docx,.pptx';
  input.multiple = true;
  input.addEventListener('change', () => {
    if (!input.files.length) return;
    addFilesToRag(rag, input.files);
  });
  input.click();
}

async function addFilesToRag(rag, files) {
  clearLog();
  progressLog.classList.remove('hidden');
  appendLog(`Adicionando ${files.length} arquivo(s) ao RAG "${rag.filename || rag.store_id}"...`);

  const formData = new FormData();
  for (const file of files) formData.append('files', file);
  formData.append('api_key', apiKeyInput.value.trim());
  formData.append('ai_type', rag.provider);

  try {
    const res  = await fetch(`/rags/${rag.store_id}/add`, { method: 'POST', body: formData });
    const data = await res.json();
    if (data.error) { showStatus(data.error, 'error'); return; }

    const es = new EventSource(`/progress/${data.jobId}`);
    es.addEventListener('progress', (e) => appendLog(JSON.parse(e.data).message));
    es.addEventListener('done', (e) => {
      es.close();
      const r = JSON.parse(e.data);
      showStatus(`${r.added} arquivo(s) adicionado(s) com sucesso ao RAG!`, 'success');
      loadRags();
    });
    es.addEventListener('error', (e) => {
      es.close();
      let msg = 'Erro ao adicionar arquivos.';
      try { msg = JSON.parse(e.data).error; } catch {}
      showStatus(msg, 'error');
    });
  } catch (e) {
    showStatus('Erro de conexão: ' + e.message, 'error');
  }
}

function deleteRag(rag) {
  if (!apiKeyInput.value.trim()) {
    showStatus('Insira sua API key da LLM antes de excluir.', 'error');
    apiKeyInput.focus();
    return;
  }
  const label = rag.filename || rag.store_id;
  if (!confirm(`Tem certeza que deseja excluir permanentemente o RAG "${label}" (${rag.store_id})?\n\nEssa ação apaga o vector store no provedor e não pode ser desfeita.`)) return;

  fetch(`/rags/${rag.store_id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: rag.provider, ai_key: apiKeyInput.value.trim() }),
  })
    .then(res => res.json())
    .then(data => {
      if (data.error) { showStatus(data.error, 'error'); return; }
      showStatus(`RAG "${label}" excluído com sucesso.`, 'success');
      loadRags();
    })
    .catch(e => showStatus('Erro de conexão: ' + e.message, 'error'));
}

function resetRagContent(rag) {
  if (!apiKeyInput.value.trim()) {
    showStatus('Insira sua API key da LLM antes de substituir o conteúdo.', 'error');
    apiKeyInput.focus();
    return;
  }
  const label = rag.filename || rag.store_id;
  if (!confirm(`Isso vai apagar TODO o conteúdo atual do RAG "${label}" para você enviar arquivos novos no lugar, mantendo o mesmo Store ID.\n\nContinuar?`)) return;

  clearLog();
  progressLog.classList.remove('hidden');
  appendLog(`Limpando conteúdo do RAG "${label}"...`);

  fetch(`/rags/${rag.store_id}/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: rag.provider, ai_key: apiKeyInput.value.trim() }),
  })
    .then(res => res.json())
    .then(data => {
      if (data.error) { showStatus(data.error, 'error'); return; }
      const es = new EventSource(`/progress/${data.jobId}`);
      es.addEventListener('progress', (e) => appendLog(JSON.parse(e.data).message));
      es.addEventListener('done', () => {
        es.close();
        showStatus(`Conteúdo antigo removido. Selecione os arquivos novos para "${label}".`, 'success');
        openAddFilesDialog(rag);
      });
      es.addEventListener('error', (e) => {
        es.close();
        let msg = 'Erro ao limpar conteúdo.';
        try { msg = JSON.parse(e.data).error; } catch {}
        showStatus(msg, 'error');
      });
    })
    .catch(e => showStatus('Erro de conexão: ' + e.message, 'error'));
}

function selectRag(rag) {
  if (!apiKeyInput.value.trim()) {
    showStatus('Insira sua API key antes de usar um RAG existente.', 'error');
    apiKeyInput.focus();
    return;
  }
  session = { apiKey: apiKeyInput.value.trim(), aiType: rag.provider, storeId: rag.store_id };

  document.getElementById('r-filename').textContent = rag.filename || '—';
  document.getElementById('r-provider').textContent = rag.provider === 'openai' ? 'OpenAI GPT' : 'Google Gemini';
  document.getElementById('r-store-id').textContent = rag.store_id;
  document.getElementById('r-saved').textContent = `rags/${(rag.filename || 'rag').replace(/\.[^.]+$/, '')}.json`;
  const apiKeyEl = document.getElementById('r-api-key');
  if (apiKeyEl) apiKeyEl.textContent = rag.api_key || '—';
  resultPanel.classList.remove('hidden');

  chatPanel.classList.remove('hidden');
  const existing = loadHistory(rag.store_id);
  if (existing.length > 0) {
    renderHistory(rag.store_id);
  } else {
    chatBox.innerHTML = '';
    addMessage(`RAG "${rag.filename || rag.store_name}" selecionado. Faça uma pergunta!`, 'assistant');
  }
  chatPanel.scrollIntoView({ behavior: 'smooth' });
}

refreshRagsBtn.addEventListener('click', loadRags);

// ─── Painel de Teste ──────────────────────────────────────────
function openTestPanel(rag) {
  testRag = rag;
  testPanel.classList.remove('hidden');
  testProgressLog.classList.add('hidden');
  testProgressLog.innerHTML = '';
  testResults.classList.add('hidden');
  testResults.innerHTML = '';
  testQuestionsList.innerHTML = '';
  runTestBtn.disabled = true;
  testPanel.scrollIntoView({ behavior: 'smooth' });
}

importCsvBtn.addEventListener('click', () => testCsvInput.click());

testCsvInput.addEventListener('change', () => {
  if (!testCsvInput.files.length) return;
  const file = testCsvInput.files[0];
  testCsvInput.value = '';
  const reader = new FileReader();
  reader.onload = (e) => {
    const rows = parseTestCSV(e.target.result);
    if (!rows.length) { showStatus('CSV sem perguntas válidas.', 'error'); return; }
    rows.forEach(r => addTestRow(r.question, r.expected));
  };
  reader.readAsText(file, 'utf-8');
});

function parseTestCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  // Skip header row if it starts with "pergunta" (case-insensitive)
  const start = lines[0].toLowerCase().startsWith('pergunta') ? 1 : 0;
  return lines.slice(start).map(line => {
    const cols = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === ',' && !inQ) { cols.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cols.push(cur.trim());
    return { question: cols[0] || '', expected: cols[1] || '' };
  }).filter(r => r.question);
}

addTestQuestionBtn.addEventListener('click', () => addTestRow('', ''));

function addTestRow(question = '', expected = '') {
  const row = document.createElement('div');
  row.className = 'test-row';
  row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-bottom:8px;align-items:center';

  const qInput = document.createElement('input');
  qInput.type = 'text';
  qInput.placeholder = 'Pergunta';
  qInput.value = question;
  qInput.style.cssText = 'padding:8px;background:#1a1a2e;color:#e2e8f0;border:1px solid #4c1d95;border-radius:6px;font-size:0.85rem;width:100%;box-sizing:border-box';

  const eInput = document.createElement('input');
  eInput.type = 'text';
  eInput.placeholder = 'Resposta esperada (opcional)';
  eInput.value = expected;
  eInput.style.cssText = 'padding:8px;background:#1a1a2e;color:#e2e8f0;border:1px solid #4c1d95;border-radius:6px;font-size:0.85rem;width:100%;box-sizing:border-box';

  const removeBtn = document.createElement('button');
  removeBtn.textContent = '×';
  removeBtn.className = 'btn-text';
  removeBtn.style.cssText = 'font-size:1.2rem;padding:0 6px';
  removeBtn.addEventListener('click', () => { row.remove(); syncRunTestBtn(); });

  qInput.addEventListener('input', syncRunTestBtn);

  row.appendChild(qInput);
  row.appendChild(eInput);
  row.appendChild(removeBtn);
  testQuestionsList.appendChild(row);
  syncRunTestBtn();
}

function syncRunTestBtn() {
  const hasQ = [...testQuestionsList.querySelectorAll('.test-row')].some(r => {
    const inputs = r.querySelectorAll('input');
    return inputs[0] && inputs[0].value.trim();
  });
  runTestBtn.disabled = !testRag || !hasQ;
}

runTestBtn.addEventListener('click', async () => {
  if (!testRag) return;
  const cases = [...testQuestionsList.querySelectorAll('.test-row')].map(r => {
    const inputs = r.querySelectorAll('input');
    return { question: inputs[0].value.trim(), expected: inputs[1].value.trim() };
  }).filter(c => c.question);
  if (!cases.length) return;

  runTestBtn.disabled = true;
  testProgressLog.innerHTML = '';
  testProgressLog.classList.remove('hidden');
  testResults.classList.add('hidden');
  testResults.innerHTML = '';

  const logTest = (msg) => {
    const div = document.createElement('div');
    div.className = 'log-line';
    div.textContent = msg;
    testProgressLog.appendChild(div);
    testProgressLog.scrollTop = testProgressLog.scrollHeight;
  };

  logTest(`Executando ${cases.length} teste(s) com o RAG "${testRag.filename || testRag.store_id}"...`);

  try {
    const res = await fetch(`/rags/${testRag.store_id}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKeyInput.value.trim(),
        ai_type: testRag.provider,
        cases,
      }),
    });
    const data = await res.json();
    if (data.error) { logTest('Erro: ' + data.error); runTestBtn.disabled = false; return; }

    const es = new EventSource(`/progress/${data.jobId}`);
    es.addEventListener('progress', (e) => logTest(JSON.parse(e.data).message));
    es.addEventListener('done', (e) => {
      es.close();
      renderTestResults(JSON.parse(e.data));
      runTestBtn.disabled = false;
    });
    es.addEventListener('error', (e) => {
      es.close();
      let msg = 'Erro ao executar testes.';
      try { msg = JSON.parse(e.data).error; } catch {}
      logTest(msg);
      runTestBtn.disabled = false;
    });
  } catch (e) {
    logTest('Erro de conexão: ' + e.message);
    runTestBtn.disabled = false;
  }
});

function renderTestResults({ results, accuracy }) {
  testResults.classList.remove('hidden');
  testResults.innerHTML = '';

  const passed = results.filter(r => r.verdict === 'pass').length;
  const summary = document.createElement('div');
  summary.style.cssText = 'font-size:1.05rem;font-weight:600;margin-bottom:12px;color:#c084fc';
  summary.textContent = `Precisão: ${(accuracy * 100).toFixed(0)}% — ${passed}/${results.length} passaram`;
  testResults.appendChild(summary);

  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.82rem';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ['Pergunta', 'Esperado', 'Obtido', 'Veredicto'].forEach(col => {
    const th = document.createElement('th');
    th.textContent = col;
    th.style.cssText = 'text-align:left;padding:8px;border-bottom:2px solid #4c1d95;color:#a78bfa;white-space:nowrap';
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  results.forEach(r => {
    const pass = r.verdict === 'pass';
    const tr = document.createElement('tr');
    const vals = [r.question, r.expected || '—', r.answer, r.verdict];
    vals.forEach((val, i) => {
      const td = document.createElement('td');
      td.textContent = val;
      td.style.cssText = 'padding:8px;border-bottom:1px solid #2d1b69;vertical-align:top';
      if (i === 3) {
        td.style.fontWeight = '600';
        td.style.color = pass ? '#4ade80' : '#f87171';
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  testResults.appendChild(table);
  testResults.scrollIntoView({ behavior: 'smooth' });
}

closeTestBtn.addEventListener('click', () => {
  testPanel.classList.add('hidden');
  testRag = null;
});

// Carregar RAGs na inicialização
loadRags();
