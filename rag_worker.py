#!/usr/bin/env python3
"""
Worker chamado pelo server.js.
Uso:
  python rag_worker.py upload --provider openai|gemini --key KEY --file PATH
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

def upload_openai(api_key: str, file_path: str) -> dict:
    import io
    from openai import OpenAI

    client = OpenAI(api_key=api_key)
    path = Path(file_path)
    content_bytes, upload_name = read_file_as_bytes(path)

    progress("Criando Vector Store...")
    vs = client.vector_stores.create(name=f"kb-{path.stem}")
    progress(f"Vector Store criado: {vs.id}")

    progress(f"Enviando {upload_name} ({len(content_bytes) / 1024:.1f} KB)...")
    client.vector_stores.files.upload_and_poll(
        vector_store_id=vs.id,
        file=(upload_name, io.BytesIO(content_bytes), "text/plain"),
    )

    progress("Indexacao concluida!")
    return {"store_id": vs.id, "store_name": vs.name, "provider": "openai"}


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

def upload_gemini(api_key: str, file_path: str) -> dict:
    from google import genai

    client = genai.Client(api_key=api_key)
    path = Path(file_path)
    content_bytes, upload_name = read_file_as_bytes(path)

    safe_name = _ascii_filename(upload_name)
    tmp_path = path.parent / safe_name
    tmp_path.write_bytes(content_bytes)

    try:
        progress("Criando File Search Store...")
        store = client.file_search_stores.create(
            config={"display_name": _ascii_safe(f"kb-{path.stem}")}
        )
        progress(f"Store criado: {store.name}")

        progress(f"Enviando {upload_name} ({len(content_bytes) / 1024:.1f} KB)...")
        operation = client.file_search_stores.upload_to_file_search_store(
            file=str(tmp_path),
            file_search_store_name=store.name,
            config={"display_name": _ascii_safe(upload_name)},
        )
    finally:
        if tmp_path.exists():
            tmp_path.unlink()

    progress("Indexando (pode levar alguns minutos)...")
    while not operation.done:
        time.sleep(5)
        operation = client.operations.get(operation)
        progress("...aguardando indexacao")

    progress("Indexacao concluida!")
    return {"store_id": store.name, "store_name": store.name, "provider": "gemini"}


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


# ─── Main ─────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd")

    up = sub.add_parser("upload")
    up.add_argument("--provider", required=True, choices=["openai", "gemini"])
    up.add_argument("--key", required=True)
    up.add_argument("--file", required=True)

    qr = sub.add_parser("query")
    qr.add_argument("--provider", required=True, choices=["openai", "gemini"])
    qr.add_argument("--key", required=True)
    qr.add_argument("--store", required=True)
    qr.add_argument("--question", required=True)

    args = parser.parse_args()

    if args.cmd == "upload":
        try:
            if args.provider == "openai":
                data = upload_openai(args.key, args.file)
            else:
                data = upload_gemini(args.key, args.file)
            result(data)
        except Exception as e:
            error(str(e))

    elif args.cmd == "query":
        try:
            if args.provider == "openai":
                answer = query_openai(args.key, args.store, args.question)
            else:
                answer = query_gemini(args.key, args.store, args.question)
            result({"answer": answer})
        except Exception as e:
            error(str(e))

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
