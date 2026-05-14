"""FastAPI サーバ: 予測パイプライン実行 + 結果取得 + 静的配信."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles

from src.xlsx_to_json import convert_to_dict


ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = ROOT / "output"
INPUT_DIR = ROOT / "input"
STATIC_DIR = ROOT / "static"
CACHE_JSON = ROOT / "forecast_data.json"  # プロジェクトルートに置く（Renderがoutput/を空で上書きするため）
UPLOAD_INVENTORY  = INPUT_DIR / "uploaded_inventory.xlsx"       # Web アップロード先 (_1.xlsx)
UPLOAD_DATA       = INPUT_DIR / "uploaded_data.xlsx"           # Web アップロード先 (data.xlsx)
UPLOAD_PLAN       = INPUT_DIR / "uploaded_inventory_plan.xlsx" # Web アップロード先 (_2.xlsx)
MEETING_SKUS_JSON = OUTPUT_DIR / "meeting_skus.json"           # 溶材会議 SKU リスト

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
                # パイプライン成功後、JSONキャッシュを更新
                _refresh_cache()
    except subprocess.TimeoutExpired:
        with _lock:
            _state["error"] = "パイプライン実行が10分を超えました"
    except Exception as e:
        with _lock:
            _state["error"] = str(e)
    finally:
        with _lock:
            _state["running"] = False


def _refresh_cache() -> None:
    """RES.xlsx → forecast_data.json を再生成して保存."""
    xlsx_files = sorted(OUTPUT_DIR.glob("*_RES.xlsx"))
    if not xlsx_files:
        return
    actual = next(iter(INPUT_DIR.glob("*在庫評価追加_1.xlsx")), None)
    log_p = OUTPUT_DIR / "実行ログ.txt"
    try:
        data = convert_to_dict(xlsx_files[-1], actual, log_p if log_p.exists() else None)
        CACHE_JSON.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def _load_cache() -> dict | None:
    """forecast_data.json を読み込む。存在しなければ None。"""
    if not CACHE_JSON.exists():
        return None
    try:
        return json.loads(CACHE_JSON.read_text(encoding="utf-8"))
    except Exception:
        return None


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/debug")
def debug() -> dict:
    try:
        files = list(OUTPUT_DIR.iterdir()) if OUTPUT_DIR.exists() else []
        return {
            "root": str(ROOT),
            "output_dir": str(OUTPUT_DIR),
            "output_exists": OUTPUT_DIR.exists(),
            "cache_json_exists": CACHE_JSON.exists(),
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
    # 1. JSONキャッシュがあれば即返す（Render再起動後も高速）
    data = _load_cache()
    if data is not None:
        return data
    # 2. なければ RES.xlsx から変換（ローカル初回・パイプライン直後）
    xlsx_files = sorted(OUTPUT_DIR.glob("*_RES.xlsx"))
    if not xlsx_files:
        raise HTTPException(
            status_code=404,
            detail="予測データがありません。先に予測を実行してください。",
        )
    actual = next(iter(INPUT_DIR.glob("*在庫評価追加_1.xlsx")), None)
    log_p = OUTPUT_DIR / "実行ログ.txt"
    data = convert_to_dict(xlsx_files[-1], actual, log_p if log_p.exists() else None)
    # 次回以降のためにキャッシュ保存
    try:
        CACHE_JSON.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
    return data


@app.post("/api/upload")
async def upload_file(
    file: UploadFile = File(...),
    file_type: str = "inventory",
) -> dict:
    """Excel ファイルをアップロードして次回パイプライン実行で使用する.

    file_type: "inventory" (_1.xlsx) | "data" (data.xlsx) | "plan" (_2.xlsx)
    """
    filename = file.filename or ""
    if not filename.lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="xlsx ファイルのみ対応しています")
    content = await file.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="ファイルサイズ上限 50MB を超えています")
    if len(content) < 4:
        raise HTTPException(status_code=400, detail="ファイルが空または破損しています")
    INPUT_DIR.mkdir(exist_ok=True)
    dest = {
        "data":      UPLOAD_DATA,
        "plan":      UPLOAD_PLAN,
    }.get(file_type, UPLOAD_INVENTORY)
    dest.write_bytes(content)

    # 発注計画書アップロード時: 含まれる SKU リストを即時抽出して保存
    if file_type == "plan":
        try:
            from src.io_reader import read_planned_orders
            df = read_planned_orders(str(dest))
            if len(df) > 0:
                skus = sorted(df["sku_id"].unique().tolist())
                OUTPUT_DIR.mkdir(exist_ok=True)
                MEETING_SKUS_JSON.write_text(
                    json.dumps(
                        {"skus": skus, "filename": filename, "count": len(skus)},
                        ensure_ascii=False,
                    )
                )
        except Exception:
            pass

    return {"status": "ok", "filename": filename, "size": len(content), "file_type": file_type}


@app.get("/api/meeting-skus")
def meeting_skus() -> dict:
    """溶材会議用 SKU リスト（最後にアップロードされた発注計画書から）."""
    if not MEETING_SKUS_JSON.exists():
        return {"skus": [], "filename": None, "count": 0}
    try:
        return json.loads(MEETING_SKUS_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {"skus": [], "filename": None, "count": 0}


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
