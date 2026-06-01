# FRONT RAG — Plano de Melhorias (15 Ideias)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evoluir o FRONT RAG de uma ferramenta funcional para uma plataforma robusta de criação e consulta de bases de conhecimento RAG, priorizando qualidade de indexação, experiência do usuário e extensibilidade.

**Architecture:** O projeto usa Node.js como orquestrador + Python como worker de processamento/IA. A maioria das melhorias de qualidade de RAG ficam no `rag_worker.py`; melhorias de UX ficam em `public/script.js` e `public/index.html`; novas rotas ficam em `server.js`.

**Tech Stack:** Node.js + Express, Python 3, OpenAI Vector Stores, Google Gemini File Search, Vanilla JS, Playwright, BeautifulSoup.

---

## Contexto de Qualidade RAG

O sistema já faz upload de documentos completos para o OpenAI/Gemini. O ponto crítico é que **a qualidade da resposta depende diretamente da qualidade do texto enviado**. Documentos mal extraídos, com lixo HTML, cabeçalhos/rodapés repetidos, ou arquivos gigantes sem segmentação resultam em respostas imprecisas. As melhorias abaixo foram pensadas com isso em mente.

---

## Grupo 1 — Qualidade de Extração e Indexação (RAG Quality)

### Melhoria 1: Chunking Semântico por Seção

**Problema atual:** O sistema envia o documento inteiro como um único arquivo para o vector store. Documentos grandes têm contextos muito distantes entre si, diluindo a relevância.

**O que fazer:**
- No `rag_worker.py`, antes de fazer upload, quebrar textos longos em chunks por seção (headings `#`, `##` para Markdown; blocos de parágrafo para texto puro; sheets separados para Excel)
- Cada chunk vira um arquivo separado no vector store com nome `{doc_name}_chunk_{n}.txt`
- Limite sugerido: 1500–2000 tokens por chunk com sobreposição de 200 tokens

**Arquivos:** `rag_worker.py` (função `process_file` e `upload_files`)

**Impacto:** Respostas mais precisas em documentos longos; o vector store recupera só o trecho relevante, não o doc inteiro.

---

### Melhoria 2: Pré-processamento Inteligente de HTML (Scraping)

**Problema atual:** O scraping remove `<script>`, `<style>`, `<nav>`, `<footer>`, mas ainda pode trazer menus repetidos, banners de cookies, breadcrumbs e outros ruídos que poluem o contexto.

**O que fazer:**
- Adicionar remoção de elementos por seletores CSS comuns: `.cookie-banner`, `.breadcrumb`, `[aria-label="navigation"]`, `[role="banner"]`, `.sidebar`
- Preservar `<table>` como texto formatado (pipe-separated, tipo Markdown) em vez de concatenar células
- Extrair `<code>` e `<pre>` com marcação explícita (````código aqui````)
- Adicionar campo `source_url` no início de cada página scrapeada para a IA poder citar a fonte

**Arquivos:** `rag_worker.py` (função de scraping HTML)

**Impacto:** Texto enviado para o vector store é mais limpo; a IA consegue citar a URL de origem na resposta.

---

### Melhoria 3: Preview e Edição do Texto Extraído

**Problema atual:** O usuário não sabe o que foi extraído dos seus arquivos antes de indexar. Se a extração de PDF foi ruim (PDF scaneado, layout em colunas), o RAG fica comprometido sem aviso.

**O que fazer:**
- Após upload mas **antes** do índice ser criado, enviar preview do texto extraído (primeiros 500 chars por arquivo) via SSE
- UI mostra um accordion com o texto extraído por arquivo
- Usuário pode editar o texto extraído diretamente no browser antes de confirmar indexação
- Texto editado é reenviado para o server via `POST /confirm-upload`

**Arquivos:** `rag_worker.py` (emitir `PREVIEW: {json}`), `server.js` (nova rota `/confirm-upload`), `public/script.js` e `public/index.html`

**Impacto:** Usuário tem controle total sobre o que entra no RAG; debugging óbvio quando a extração falha.

---

### Melhoria 4: OCR em PDFs Escaneados

**Problema atual:** `pdfplumber` e `pypdf` falham silenciosamente em PDFs escaneados (imagens de texto) — extraem string vazia ou lixo.

**O que fazer:**
- Detectar PDFs com texto vazio após extração (< 50 chars por página)
- Usar `pytesseract` + `pdf2image` como fallback para OCR
- Emitir `PROGRESS: PDF escaneado detectado, usando OCR (pode demorar)` via stdout
- Adicionar `pytesseract` e `pdf2image` ao `requirements.txt`

**Arquivos:** `rag_worker.py`, `requirements.txt`

**Impacto:** PDFs de contratos, notas fiscais, manuais físicos digitalizados passam a ser indexados corretamente.

---

### Melhoria 5: Suporte a DOCX e PowerPoint

**Problema atual:** Apenas PDF, Excel, CSV, TXT, Markdown são suportados. DOCX e PPTX são formatos muito comuns.

**O que fazer:**
- DOCX: usar `python-docx` — extrair parágrafos e tabelas com estrutura preservada
- PPTX: usar `python-pptx` — extrair texto por slide com header `## Slide N: {título}`
- Adicionar extensões ao check de tipos em `server.js` (Multer filter) e `rag_worker.py`
- Adicionar `python-docx` e `python-pptx` ao `requirements.txt`

**Arquivos:** `rag_worker.py`, `server.js`, `requirements.txt`

**Impacto:** Cobre a maioria dos documentos corporativos reais.

---

## Grupo 2 — Experiência do Usuário (UX)

### Melhoria 6: Citations / Fontes nas Respostas

**Problema atual:** A resposta do chat não indica de qual documento ou trecho veio a informação. O usuário não consegue validar a resposta.

**O que fazer:**
- OpenAI já retorna `annotations` com `file_citation` no response object — extrair e formatar como `[1]`, `[2]`
- Gemini: incluir instrução no prompt `"Ao final da resposta, cite as fontes no formato [Fonte: nome_arquivo]"`
- UI renderiza as citations como chips clicáveis abaixo da resposta

**Arquivos:** `rag_worker.py` (parser do response), `public/script.js` (render de citations), `public/index.html` (estilo dos chips)

**Impacto:** Respostas auditáveis; aumenta confiança do usuário.

---

### Melhoria 7: Histórico de Conversas Persistente por RAG

**Problema atual:** O chat não tem memória — cada query é independente. Recarregar a página apaga tudo.

**O que fazer:**
- Salvar mensagens no `localStorage` com chave `chat_{store_id}`
- Ao selecionar um RAG existente, carregar histórico do localStorage e renderizar no chat
- Botão "Limpar conversa" que reseta o localStorage para aquele RAG
- Limite de 50 mensagens por RAG (remove as mais antigas com FIFO)

**Arquivos:** `public/script.js`, `public/index.html`

**Impacto:** Usuário não perde o fio da pesquisa ao recarregar; pode voltar onde parou.

---

### Melhoria 8: Dashboard de RAGs com Metadados

**Problema atual:** A lista de RAGs mostra apenas nome e provider. O usuário não sabe quantos arquivos tem, qual o tamanho, quando foi criado ou se está atualizado.

**O que fazer:**
- Ao criar o RAG, salvar no JSON/PostgreSQL: `{ file_count, total_size_bytes, files: [{name, size, type}], created_at, last_queried_at }`
- Endpoint `GET /rags/:id` retorna esses metadados
- UI do dashboard mostra cards com: ícone do provider, nome, # de documentos, data de criação, botão "Ver detalhes"

**Arquivos:** `rag_worker.py` (enriquecer RESULT JSON), `server.js` (nova rota), `public/script.js`, `public/index.html`

**Impacto:** Gestão clara do que está indexado; usuário sabe o que cada RAG contém sem precisar recriar.

---

### Melhoria 9: Exportar Conversa como PDF ou Markdown

**Problema atual:** Insights gerados no chat desaparecem quando a página é fechada ou o histórico é limpo.

**O que fazer:**
- Botão "Exportar" no chat que pega o histórico de mensagens
- Opção 1: Markdown (simples, client-side — `Blob` + `a.download`)
- Opção 2: PDF usando `jsPDF` (lib leve, client-side)
- Formato: `# Chat com {RAG name} — {data}\n\n**Você:** pergunta\n\n**IA:** resposta\n\n---`

**Arquivos:** `public/script.js`, `public/index.html`

**Impacto:** Fluxo de trabalho completo — pesquisa e salva os resultados.

---

## Grupo 3 — Funcionalidades Novas

### Melhoria 10: Reindexação Incremental (Adicionar Docs ao RAG)

**Problema atual:** Para adicionar um documento a um RAG existente, o usuário precisa recriar o RAG inteiro.

**O que fazer:**
- Botão "Adicionar documentos" no card do RAG existente
- `POST /rags/:id/add` recebe novos arquivos + API key
- Python worker faz upload dos novos arquivos ao `store_id` existente (OpenAI suporta `client.beta.vector_stores.files.create(vector_store_id=...)`)
- Atualiza metadata do RAG (file_count, total_size_bytes)

**Arquivos:** `server.js` (nova rota), `rag_worker.py` (modo `add`), `public/script.js`, `public/index.html`

**Impacto:** RAG evolui com o conhecimento sem custo de reindexação total.

---

### Melhoria 11: Multi-RAG Query (Busca em Múltiplas Bases)

**Problema atual:** Cada query é feita em um único RAG. Para times que têm múltiplas bases (produtos, suporte, RH), precisam trocar de RAG manualmente.

**O que fazer:**
- UI permite selecionar múltiplos RAGs (checkboxes no dashboard)
- `POST /query` recebe array de `store_ids`
- Para cada store, Python faz a query em paralelo (asyncio)
- Respostas são consolidadas com header `### Fonte: {rag_name}`
- Opcionalmente, um prompt de síntese final une as respostas em uma resposta única coerente

**Arquivos:** `server.js`, `rag_worker.py` (modo `multi-query`), `public/script.js`, `public/index.html`

**Impacto:** Elimina a troca manual de contexto; consultas cross-domínio em um único chat.

---

### Melhoria 12: API REST Pública para Integração Externa

**Problema atual:** O FRONT RAG é uma ferramenta isolada. Outros sistemas (chatbots, apps internos, Zapier) não conseguem consumir os RAGs programaticamente.

**O que fazer:**
- Gerar um `api_key` por RAG na criação (UUID v4 salvo no JSON/DB)
- Endpoint público: `POST /api/v1/query` com header `Authorization: Bearer {api_key}`, body `{ question: "..." }`
- Retorna `{ answer: "...", citations: [...] }`
- Documentação inline (Swagger/OpenAPI) em `/api/docs`
- Rate limiting básico: 60 requests/minuto por chave (usando `express-rate-limit`)

**Arquivos:** `server.js` (novas rotas `/api/v1/`), `public/index.html` (mostrar API key na UI)

**Impacto:** O RAG vira uma API de conhecimento consumível por qualquer sistema.

---

### Melhoria 13: Agendamento de Re-Scraping Automático

**Problema atual:** Sites indexados ficam desatualizados. O usuário precisa re-scrapar manualmente para atualizar o RAG.

**O que fazer:**
- Na criação de RAG via scraping, campo "Atualizar automaticamente: diário / semanal / nunca"
- Node.js usa `node-cron` para agendar jobs de re-scraping
- Job re-scrapa as URLs salvas no metadata do RAG e substitui os arquivos no vector store
- Notificação no dashboard: "Atualizado há 2 horas"

**Arquivos:** `server.js` (integrar node-cron), `rag_worker.py`, metadados do RAG (adicionar `urls[]` e `schedule`)

**Impacto:** RAGs de knowledge bases (Zoho Desk, Confluence, sites de produto) sempre atualizados sem intervenção manual.

---

### Melhoria 14: Sistema de Feedback nas Respostas (Thumbs Up/Down)

**Problema atual:** Não há como medir se as respostas do RAG são boas. Não há dados para identificar gaps na base de conhecimento.

**O que fazer:**
- Botões 👍 / 👎 em cada resposta do chat
- `POST /feedback` salva `{ store_id, question, answer, rating, timestamp }` em `feedback.json` ou tabela `feedback` no PostgreSQL
- Página `/admin/feedback` (protegida por env var `ADMIN_TOKEN`) lista as perguntas mal respondidas
- Ordenadas por frequência — revela os gaps mais críticos da base de conhecimento

**Arquivos:** `server.js` (rota feedback + admin), `public/script.js`, `public/index.html`

**Impacto:** Loop de melhoria contínua — você sabe onde o RAG falha e o que indexar a seguir.

---

### Melhoria 15: Modo de Teste / Validação do RAG

**Problema atual:** Depois de criar um RAG, o usuário não sabe se ficou bom até usar em produção e receber reclamações.

**O que fazer:**
- Botão "Testar RAG" no dashboard de um RAG criado
- UI exibe um conjunto de perguntas de teste sugeridas (geradas pela IA com base nos documentos indexados)
- Opcionalmente, o usuário importa um arquivo CSV com `pergunta,resposta_esperada`
- Sistema roda todas as perguntas, compara respostas com o gabarito (via LLM judge — prompt `"A resposta está correta? sim/não/parcial"`)
- Exibe relatório: % de acerto, perguntas que falharam

**Arquivos:** `server.js` (rota `/rags/:id/test`), `rag_worker.py` (modo `test`), `public/script.js`, `public/index.html`

**Impacto:** Validação antes de publicar o RAG; detecta documentos mal indexados antes que os usuários finais sejam afetados.

---

## Resumo das 15 Melhorias

| # | Melhoria | Grupo | Complexidade | Impacto |
|---|----------|-------|-------------|---------|
| 1 | Chunking semântico por seção | RAG Quality | Média | Alto |
| 2 | Pré-processamento HTML inteligente | RAG Quality | Baixa | Alto |
| 3 | Preview e edição do texto extraído | RAG Quality | Alta | Alto |
| 4 | OCR em PDFs escaneados | RAG Quality | Média | Médio |
| 5 | Suporte a DOCX e PowerPoint | RAG Quality | Baixa | Médio |
| 6 | Citations / fontes nas respostas | UX | Baixa | Alto |
| 7 | Histórico de conversas persistente | UX | Baixa | Alto |
| 8 | Dashboard com metadados de RAGs | UX | Média | Médio |
| 9 | Exportar conversa (PDF/Markdown) | UX | Baixa | Médio |
| 10 | Reindexação incremental | Feature | Alta | Alto |
| 11 | Multi-RAG query | Feature | Alta | Alto |
| 12 | API REST pública | Feature | Alta | Alto |
| 13 | Agendamento de re-scraping | Feature | Alta | Médio |
| 14 | Feedback nas respostas | Feature | Média | Médio |
| 15 | Modo de teste / validação do RAG | Feature | Alta | Alto |

---

## Ordem de Implementação Sugerida

**Sprint 1 — Quick wins de qualidade (baixa complexidade, alto impacto):**
Melhorias 2 → 5 → 6 → 7 → 9

**Sprint 2 — Controle e visibilidade:**
Melhorias 3 → 8 → 14

**Sprint 3 — Qualidade avançada de RAG:**
Melhorias 1 → 4 → 15

**Sprint 4 — Extensibilidade:**
Melhorias 10 → 11 → 12 → 13
