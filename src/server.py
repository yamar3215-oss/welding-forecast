"""FastAPI サーバ: 予測パイプライン実行 + 結果取得 + 静的配信."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from src.xlsx_to_json import convert_to_dict


ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = ROOT / "output"
INPUT_DIR = ROOT / "input"
STATIC_DIR = ROOT / "static"


app = FastAPI(title="溶材会議アプリ API")


def _latest_res() -> Path:
    files = sorted(OUTPUT_DIR.glob("*_RES.xlsx"))
    if not files:
        raise HTTPException(
            status_code=404,
            detail="RES.xlsx が見つかりません。先に /api/run を実行してください。",
        )
    return files[-1]


def _actual_path() -> Path | None:
    candidates = list(INPUT_DIR.glob("*在庫評価追加_1.xlsx"))
    return candidates[0] if candidates else None


def _log_path() -> Path | None:
    p = OUTPUT_DIR / "実行ログ.txt"
    return p if p.exists() else None


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/latest")
def latest() -> dict:
    res = _latest_res()
    return convert_to_dict(res, _actual_path(), _log_path())


@app.post("/api/run")
def run() -> dict:
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    try:
        proc = subprocess.run(
            [sys.executable, str(ROOT / "run.py")],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
            env=env,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "パイプライン実行が10分を超えました")

    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "")[-800:]
        raise HTTPException(
            500,
            f"パイプライン失敗 (exit {proc.returncode}): {tail}",
        )

    res = _latest_res()
    return convert_to_dict(res, _actual_path(), _log_path())


# 静的配信は最後にマウント (API ルートと衝突しないように)
if STATIC_DIR.exists():
    app.mount(
        "/",
        StaticFiles(directory=str(STATIC_DIR), html=True),
        name="static",
    )
