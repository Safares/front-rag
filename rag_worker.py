#!/usr/bin/env python3
"""
Worker chamado pelo server.js.
Uso:
  python rag_worker.py upload --provider openai|gemini --key KEY --files-file PATH_JSON
  python rag_worker.py query  --provider openai|gemini --key KEY --store STORE_ID --question "..."
"""

import sys
import json
import argparse
import time
import re
import unicodedata
from pathlib import Path


def _emit(prefix: str, payload) -> None:
    line = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    print(f"{prefix}{line}", flush=True)


def progress(msg: str) -> None:
    _emit("PROGRESS:", msg)


def result(data: dict) -> None:
    _emit("RESULT:", data)


def error(msg: str) -> None:
    _emit("ERROR:", msg)
    sys.exit(1)


# ─── Leitura de arquivo ───────────────────────────────────────

def read_file_as_bytes(path: Path) -> tuple[bytes, str]:
    """Retorna (conteudo_bytes, nome_para_upload)."""
    ext = path.suffix.lower()

    if ext in (".txt", ".md"):
        return path.read_bytes(), path.name

    if ext == ".pdf":
        try:
            import pdfplumber
            parts = []
            with pdfplumber.open(path) as pdf:
                for page in pdf.pages:
                    t = page.extract_text()
                    if t:
                        parts.append(t)
            return "\n\n".join(parts).encode("utf-8"), path.stem + ".txt"
        except ImportError:
            pass
        try:
            import pypdf
            reader = pypdf.PdfReader(str(path))
            text = "\n\n".join(p.extract_text() or "" for p in reader.pages)
            return text.encode("utf-8"), path.stem + ".txt"
        except ImportError:
            error("Instale pdfplumber ou pypdf para processar PDFs: pip install pdfplumber")

    if ext in (".xlsx", ".xls"):
        import openpyxl
        wb = openpyxl.load_workbook(str(path), read_only=True, data_only=True)
        lines = []
        for ws in wb.worksheets:
            lines.append(f"[Planilha: {ws.title}]")
            for row in ws.iter_rows(values_only=True):
                cells = [str(c) for c in row if c is not None]
                if cells:
                    lines.append(" | ".join(cells))
        return "\n".join(lines).encode("utf-8"), path.stem + ".txt"

    error(f"Formato nao suportado: {ext}")


# ─── Helpers Gemini ───────────────────────────────────────────

def _ascii_safe(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")


def _ascii_filename(name: str) -> str:
    if "." in name:
        stem, ext = name.rsplit(".", 1)
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", _ascii_safe(stem)).strip("_") or "upload"
        return f"{safe}.{ext}"
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", _ascii_safe(name)).strip("_") or "upload"
    return safe


# ─── OpenAI ───────────────────────────────────────────────────

def upload_openai(api_key: str, file_entries: list) -> dict:
    import io
    from openai import OpenAI

    client = OpenAI(api_key=api_key)
    total      = len(file_entries)
    first_stem = Path(file_entries[0]['name']).stem if file_entries else 'kb'

    progress("Criando Vector Store...")
    vs = client.vector_stores.create(name=f"kb-{first_stem}")
    progress(f"Vector Store criado: {vs.id}")

    uploaded: list[str] = []
    failed:   list[str] = []

    for i, entry in enumerate(file_entries, 1):
        fp   = Path(entry['path'])
        name = entry['name']
        try:
            content_bytes, upload_name = read_file_as_bytes(fp)
            progress(f"[{i}/{total}] Enviando {name} ({len(content_bytes) / 1024:.1f} KB)...")
            client.vector_stores.files.upload_and_poll(
                vector_store_id=vs.id,
                file=(upload_name, io.BytesIO(content_bytes), "text/plain"),
            )
            uploaded.append(name)
            progress(f"[{i}/{total}] {name} indexado.")
        except Exception as e:
            failed.append(name)
            progress(f"[{i}/{total}] ERRO em {name}: {e}")

    if not uploaded:
        error("Nenhum arquivo pôde ser indexado.")

    progress("Indexacao concluida!")
    return {"store_id": vs.id, "store_name": vs.name, "provider": "openai",
            "files_uploaded": uploaded, "files_failed": failed}


def query_openai(api_key: str, store_id: str, question: str) -> str:
    from openai import OpenAI
    client = OpenAI(api_key=api_key)
    response = client.responses.create(
        model="gpt-4o",
        input=question,
        tools=[{"type": "file_search", "vector_store_ids": [store_id]}],
    )
    return response.output_text


# ─── Gemini ───────────────────────────────────────────────────

def upload_gemini(api_key: str, file_entries: list) -> dict:
    import tempfile
    import os
    from google import genai

    client     = genai.Client(api_key=api_key)
    total      = len(file_entries)
    first_stem = Path(file_entries[0]['name']).stem if file_entries else 'kb'

    progress("Criando File Search Store...")
    store = client.file_search_stores.create(
        config={"display_name": _ascii_safe(f"kb-{first_stem}")}
    )
    progress(f"Store criado: {store.name}")

    uploaded: list[str] = []
    failed:   list[str] = []

    for i, entry in enumerate(file_entries, 1):
        fp   = Path(entry['path'])
        name = entry['name']
        try:
            content_bytes, upload_name = read_file_as_bytes(fp)
            safe_name = _ascii_filename(upload_name)
            progress(f"[{i}/{total}] Enviando {name} ({len(content_bytes) / 1024:.1f} KB)...")
            tmp = tempfile.NamedTemporaryFile(suffix=Path(safe_name).suffix, delete=False)
            try:
                tmp.write(content_bytes)
                tmp.close()
                operation = client.file_search_stores.upload_to_file_search_store(
                    file=tmp.name,
                    file_search_store_name=store.name,
                    config={"display_name": _ascii_safe(upload_name)},
                )
            finally:
                os.unlink(tmp.name)
            progress(f"[{i}/{total}] Indexando {name}...")
            while not operation.done:
                time.sleep(5)
                operation = client.operations.get(operation)
                progress(f"[{i}/{total}] ...aguardando {name}")
            uploaded.append(name)
            progress(f"[{i}/{total}] {name} indexado.")
        except Exception as e:
            failed.append(name)
            progress(f"[{i}/{total}] ERRO em {name}: {e}")

    if not uploaded:
        error("Nenhum arquivo pôde ser indexado.")

    progress("Indexacao concluida!")
    return {"store_id": store.name, "store_name": store.name, "provider": "gemini",
            "files_uploaded": uploaded, "files_failed": failed}


def query_gemini(api_key: str, store_name: str, question: str) -> str:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=question,
        config=types.GenerateContentConfig(
            tools=[
                types.Tool(
                    file_search=types.FileSearch(
                        file_search_store_names=[store_name]
                    )
                )
            ]
        ),
    )
    return response.text


# ─── Web crawl ────────────────────────────────────────────────

MAX_PAGES = 300


def _links_from_html(html: str, base_url: str, base_domain: str) -> list[str]:
    from bs4 import BeautifulSoup
    from urllib.parse import urljoin, urlparse, urldefrag
    soup = BeautifulSoup(html, "lxml")
    found = []
    for a in soup.find_all("a", href=True):
        href, _ = urldefrag(urljoin(base_url, a["href"]))
        p = urlparse(href)
        if p.netloc == base_domain and p.scheme in ("http", "https"):
            found.append(href)
    return found


def crawl_site(url: str, depth: int, use_js: bool = False) -> list[dict]:
    """Descobre páginas dentro do mesmo domínio.
    depth=0 significa sem limite (até MAX_PAGES).
    use_js=True usa Playwright para renderizar JavaScript.
    """
    from urllib.parse import urlparse, urldefrag
    visited: set[str] = set()
    pages:   list[dict] = []
    base_domain = urlparse(url).netloc
    effective_depth = depth if depth > 0 else 999

    if use_js:
        _crawl_js(url, effective_depth, visited, pages, base_domain)
    else:
        _crawl_requests(url, effective_depth, 1, visited, pages, base_domain)

    return pages


def _crawl_requests(current: str, depth: int, level: int,
                    visited: set, pages: list, base_domain: str) -> None:
    import requests
    from urllib.parse import urldefrag

    if len(pages) >= MAX_PAGES:
        return
    current, _ = urldefrag(current)
    if current in visited:
        return
    visited.add(current)

    headers = {"User-Agent": "Mozilla/5.0 (RAG-crawler/1.0)"}
    try:
        r = requests.get(current, timeout=12, headers=headers)
        if "text/html" not in r.headers.get("Content-Type", ""):
            return
        from bs4 import BeautifulSoup
        soup  = BeautifulSoup(r.content, "lxml")
        title = (soup.title.string or current).strip()
        pages.append({"title": title, "url": current})
        progress(f"[{len(pages)}] {title}")

        if level < depth:
            for href in _links_from_html(r.text, current, base_domain):
                _crawl_requests(href, depth, level + 1, visited, pages, base_domain)
    except Exception as e:
        progress(f"Ignorado ({current}): {e}")


def _crawl_js(start: str, depth: int,
              visited: set, pages: list, base_domain: str) -> None:
    """Crawl usando Playwright (para SPAs / JavaScript)."""
    from urllib.parse import urldefrag
    from playwright.sync_api import sync_playwright

    queue = [(start, 1)]

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page    = browser.new_page()
        page.set_extra_http_headers({"User-Agent": "Mozilla/5.0 (RAG-crawler/1.0)"})

        while queue and len(pages) < MAX_PAGES:
            current, level = queue.pop(0)
            current, _ = urldefrag(current)
            if current in visited:
                continue
            visited.add(current)

            try:
                page.goto(current, wait_until="networkidle", timeout=25000)
                title = page.title() or current
                html  = page.content()
                pages.append({"title": title.strip(), "url": current})
                progress(f"[{len(pages)}] {title.strip()}")

                if level < depth:
                    for href in _links_from_html(html, current, base_domain):
                        if href not in visited:
                            queue.append((href, level + 1))
            except Exception as e:
                progress(f"Ignorado ({current}): {e}")

        browser.close()


# ─── Scrape URLs → RAG ────────────────────────────────────────

def _extract_text(html: bytes, url: str) -> str:
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
        tag.decompose()
    title = (soup.title.string or url).strip()
    body  = soup.get_text(separator="\n", strip=True)
    return f"## {title}\n\nURL: {url}\n\n{body}"


def scrape_and_upload(api_key: str, provider: str, urls: list[str], name: str) -> dict:
    import io
    import requests

    headers = {"User-Agent": "Mozilla/5.0 (RAG-crawler/1.0)"}
    parts   = []

    for i, url in enumerate(urls, 1):
        try:
            r = requests.get(url, timeout=15, headers=headers)
            parts.append(_extract_text(r.content, url))
            progress(f"[{i}/{len(urls)}] Extraído: {url}")
        except Exception as e:
            progress(f"[{i}/{len(urls)}] Erro em {url}: {e}")

    if not parts:
        error("Nenhuma página pôde ser extraída.")

    combined      = "\n\n---\n\n".join(parts)
    content_bytes = combined.encode("utf-8")
    upload_name   = re.sub(r"[^A-Za-z0-9_-]", "_", name)[:60] + ".txt"

    if provider == "openai":
        from openai import OpenAI
        client = OpenAI(api_key=api_key)

        progress("Criando Vector Store...")
        vs = client.vector_stores.create(name=f"kb-{name[:40]}")
        progress(f"Vector Store criado: {vs.id}")

        progress(f"Enviando {len(content_bytes) / 1024:.1f} KB...")
        client.vector_stores.files.upload_and_poll(
            vector_store_id=vs.id,
            file=(upload_name, io.BytesIO(content_bytes), "text/plain"),
        )
        progress("Indexacao concluida!")
        return {"store_id": vs.id, "store_name": vs.name, "provider": "openai"}

    else:
        from google import genai
        client    = genai.Client(api_key=api_key)
        safe_name = _ascii_filename(upload_name)
        import tempfile, os
        tmp = tempfile.NamedTemporaryFile(suffix=".txt", delete=False)
        try:
            tmp.write(content_bytes)
            tmp.close()

            progress("Criando File Search Store...")
            store = client.file_search_stores.create(
                config={"display_name": _ascii_safe(f"kb-{name[:40]}")}
            )
            progress(f"Store criado: {store.name}")

            progress(f"Enviando {len(content_bytes) / 1024:.1f} KB...")
            operation = client.file_search_stores.upload_to_file_search_store(
                file=tmp.name,
                file_search_store_name=store.name,
                config={"display_name": _ascii_safe(upload_name)},
            )
        finally:
            os.unlink(tmp.name)

        progress("Indexando (pode levar alguns minutos)...")
        while not operation.done:
            time.sleep(5)
            operation = client.operations.get(operation)
            progress("...aguardando indexacao")

        progress("Indexacao concluida!")
        return {"store_id": store.name, "store_name": store.name, "provider": "gemini"}


# ─── Main ─────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd")

    up = sub.add_parser("upload")
    up.add_argument("--provider", required=True, choices=["openai", "gemini"])
    up.add_argument("--key", required=True)
    up.add_argument("--files-file", required=True, dest="files_file")

    qr = sub.add_parser("query")
    qr.add_argument("--provider", required=True, choices=["openai", "gemini"])
    qr.add_argument("--key", required=True)
    qr.add_argument("--store", required=True)
    qr.add_argument("--question", required=True)

    cw = sub.add_parser("crawl")
    cw.add_argument("--url",   required=True)
    cw.add_argument("--depth", type=int, default=2)  # 0 = sem limite
    cw.add_argument("--js",    action="store_true")

    sc = sub.add_parser("scrape")
    sc.add_argument("--provider",   required=True, choices=["openai", "gemini"])
    sc.add_argument("--key",        required=True)
    sc.add_argument("--urls-file",  required=True)
    sc.add_argument("--name",       required=True)

    args = parser.parse_args()

    if args.cmd == "upload":
        try:
            with open(args.files_file) as f:
                file_entries = json.load(f)
            data = upload_openai(args.key, file_entries) if args.provider == "openai" \
                   else upload_gemini(args.key, file_entries)
            result(data)
        except Exception as e:
            error(str(e))

    elif args.cmd == "query":
        try:
            answer = query_openai(args.key, args.store, args.question) \
                     if args.provider == "openai" \
                     else query_gemini(args.key, args.store, args.question)
            result({"answer": answer})
        except Exception as e:
            error(str(e))

    elif args.cmd == "crawl":
        try:
            pages = crawl_site(args.url, args.depth, use_js=args.js)
            result({"pages": pages})
        except Exception as e:
            error(str(e))

    elif args.cmd == "scrape":
        try:
            with open(args.urls_file) as f:
                urls = json.load(f)
            data = scrape_and_upload(args.key, args.provider, urls, args.name)
            result(data)
        except Exception as e:
            error(str(e))

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
