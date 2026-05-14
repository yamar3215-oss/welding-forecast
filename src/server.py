"""FastAPI サーバ: 予測パイプライン実行 + 結果取得 + 静的配信."""
from __future__ import annotations

import os
import subprocess
import sys
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from src.xlsx_to_json import convert_to_dict


ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = ROOT / "output"
INPUT_DIR = ROOT / "input"
STATIC_DIR = ROOT / "static"

app = FastAPI(title="溶材会議アプリ API")

# パイプライン実行状態
_state: dict = {"running": False, "error": None}
_lock = threading.Lock()


def _run_pipeline_bg() -> None:
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    OUTPUT_DIR.mkdir(exist_ok=True)
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
        with _lock:
            if proc.returncode != 0:
                tail = (proc.stderr or proc.stdout or "")[-800:]
                _state["error"] = f"exit {proc.returncode}: {tail}"
            else:
                _state["error"] = None
    except subprocess.TimeoutExpired:
        with _lock:
            _state["error"] = "パイプライン実行が10分を超えました"
    except Exception as e:
        with _lock:
            _state["error"] = str(e)
    finally:
        with _lock:
            _state["running"] = False


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


@app.get("/api/debug")
def debug() -> dict:
    import os
    try:
        files = list(OUTPUT_DIR.iterdir()) if OUTPUT_DIR.exists() else []
        return {
            "root": str(ROOT),
            "output_dir": str(OUTPUT_DIR),
            "output_exists": OUTPUT_DIR.exists(),
            "files": [{"name": f.name, "size": f.stat().st_size} for f in files],
            "cwd": os.getcwd(),
        }
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/status")
def status() -> dict:
    with _lock:
        return {"running": _state["running"], "error": _state["error"]}


@app.get("/api/latest")
def latest() -> dict:
    res = _latest_res()
    return convert_to_dict(res, _actual_path(), _log_path())


@app.post("/api/run")
def run() -> dict:
    with _lock:
        if _state["running"]:
            return {"status": "already_running"}
        _state["running"] = True
        _state["error"] = None

    t = threading.Thread(target=_run_pipeline_bg, daemon=True)
    t.start()
    return {"status": "started"}


# 静的配信は最後にマウント (API ルートと衝突しないように)
if STATIC_DIR.exists():
    app.mount(
        "/",
        StaticFiles(directory=str(STATIC_DIR), html=True),
        name="static",
    )
