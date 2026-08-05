# FRONT RAG

Ferramenta local para criar, testar e gerenciar bases de conhecimento RAG (Retrieval-Augmented Generation) usando **OpenAI** ou **Google Gemini**, com upload de arquivos, scraping de sites, chat, avaliação automática e API pública — tudo por uma interface web simples (sem build step, sem framework de frontend).

## O que o projeto faz

- **Cria RAGs** a partir de arquivos (`.txt`, `.md`, `.pdf`, `.xlsx`, `.xls`, `.csv`, `.docx`, `.pptx`) ou de um site (crawling + scraping de páginas).
- Antes de indexar, mostra um **preview do texto extraído** para revisão/edição manual.
- Para arquivos `.txt`/`.md`, usa a própria LLM (com a API key informada) para **verificar se o texto já está bem dividido em chunks** — se estiver, envia como está; senão, aplica o recorte automático por tamanho de caractere.
- Delega toda a indexação vetorial para os serviços gerenciados dos provedores: **Vector Stores da OpenAI** e **File Search Stores do Gemini** (não há banco vetorial próprio).
- Permite **conversar (chat)** com um RAG específico ou com vários RAGs ao mesmo tempo (multi-RAG), com histórico salvo no navegador, exportação em Markdown/PDF e feedback (👍/👎).
- Painel para **testar um RAG existente por Store ID** manualmente (sem precisar que ele apareça no dashboard local) — útil para RAGs criados em outra máquina/ambiente.
- Permite **adicionar arquivos** a um RAG já existente, **excluir um RAG** (apaga o vector store no provedor) e **substituir todo o conteúdo de um RAG mantendo o mesmo Store ID** (limpa os documentos indexados e permite subir arquivos novos no lugar).
- Painel de teste em lote com **LLM-as-judge** para avaliar a precisão das respostas de um RAG.
- **API pública REST** (`/api/v1/query`) autenticada por `api_key` própria de cada RAG, com rate limit.
- **Re-scraping automático agendado** (diário/semanal) para RAGs criados a partir de URLs.

## Arquitetura

| Camada | Arquivo | Responsabilidade |
|---|---|---|
| Frontend | `public/index.html`, `public/script.js`, `public/style.css` | SPA única, vanilla JS, sem bundler |
| Backend  | `server.js` | Rotas Express, orquestra o worker Python via `child_process.spawn`, persistência (Postgres ou JSON) |
| Worker   | `rag_worker.py` | Extração de texto, chunking, upload/consulta/exclusão nas APIs da OpenAI e do Gemini, scraping, teste LLM-as-judge |

Comunicação Node ↔ Python é via `stdout`, linha a linha, com prefixos `PROGRESS:` / `RESULT:` / `ERROR:`. Progresso de operações longas chega ao navegador via **SSE** (`GET /progress/:jobId`).

Persistência dos metadados de cada RAG (nome, provider, `store_id`, `api_key` pública, etc.):
- Se a env var `DATABASE_URL` estiver definida → **PostgreSQL**.
- Caso contrário → um arquivo `.json` por RAG em `rags/`.

## Requisitos

- **Node.js** 18+
- **Python** 3.10+
- Uma API key da **OpenAI** e/ou do **Google Gemini** (informada pelo usuário na interface, não fica fixa no servidor)

## Instalação

```bash
# dependências Node
npm install

# dependências Python
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt

# só necessário se for usar scraping de sites com renderização JS
playwright install chromium
```

## Como rodar

```bash
npm start
```

O servidor sobe em `http://localhost:3000` (ou na porta definida em `PORT`).

## Variáveis de ambiente (opcionais)

Defina em um arquivo `.env` na raiz do projeto (já existe um com os valores padrão comentados — edite conforme necessário):

| Variável | Efeito se ausente |
|---|---|
| `PORT` | Usa `3000` |
| `DATABASE_URL` | Usa arquivos JSON em `rags/` em vez de PostgreSQL |
| `ADMIN_TOKEN` | Desativa o endpoint `GET /admin/feedback` (sempre retorna 401) |

**Não** coloque API keys da OpenAI/Gemini no `.env` — elas são digitadas na interface, uma por RAG (cada RAG pode usar uma key diferente), e nunca ficam fixas no servidor.

## Estrutura de pastas

```
server.js         → backend Express
rag_worker.py      → worker Python (CLI, chamado como subprocesso)
public/            → frontend (SPA estática)
rags/              → metadados dos RAGs em JSON (modo sem DATABASE_URL) + feedback.json
uploads/           → arquivos temporários de upload/jobs (limpos automaticamente após 2h)
requirements.txt   → dependências Python
package.json       → dependências e script Node
```

## Segurança

Este projeto foi feito para uso local/interno. O dashboard de RAGs não exige autenticação para listar ou operar sobre bases existentes — quem tiver acesso à interface e à API key do provedor consegue consultar, adicionar conteúdo, excluir ou substituir o conteúdo de qualquer RAG listado. Não exponha esta aplicação diretamente à internet sem adicionar uma camada de autenticação.
