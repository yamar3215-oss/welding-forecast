"""FastAPI サーバ: 予測パイプライン実行 + 結果取得 + 静的配信."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

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
DECISIONS_JSON    = OUTPUT_DIR / "decisions.json"              # 溶材会議 最終決定量

# 納品表の探索パス (優先順)
_DELIVERY_CANDIDATES = [
    INPUT_DIR / "uploaded_inventory_plan.xlsx",
    ROOT / "新来島ドック納品表.xlsx",
]

app = FastAPI(title="溶材会議アプリ API")


# ───── 溶材会議 SKU 解決ロジック ─────

def _norm_sku(s: str) -> str:
    """末尾の空セグメント（trailing underscore）を除去して正規化."""
    parts = s.split("_")
    while parts and parts[-1] == "":
        parts.pop()
    return "_".join(parts)


def _match_delivery_sku(delivery_sku: str, forecast_skus: list[str]) -> list[str]:
    """納品表の SKU 1件を forecast_data の SKU リストへ解決する.

    マッチング順序:
      1. 完全一致 / 正規化完全一致 (trailing underscore 除去)
      2. forecast SKU が正規化 delivery SKU で始まる (delivery が prefix)
         例: delivery=TGS309MOL_2.4_ → forecast=TGS309MOL_2.4_5
      3. 正規化 delivery SKU が正規化 forecast SKU で始まる (forecast が prefix)
         例: delivery=FBB3H_600_ → forecast=FBB3H__ (brand-only マッチ)
      4. 板継用/全姿勢用サフィックス variant を展開
         例: delivery=DW309MOL_1.2_12.5 → forecast=DW309MOL_1.2_12.5_板継用 も追加
    """
    USAGE_SFXS = ("_板継用", "_全姿勢用")
    norm_d = _norm_sku(delivery_sku)
    forecast_set = set(forecast_skus)
    base_matches: set[str] = set()

    for fs in forecast_skus:
        norm_f = _norm_sku(fs)
        # Skip usage-suffix variants in base loop — they are expanded separately below
        if any(fs.endswith(sfx) for sfx in USAGE_SFXS):
            continue
        # 1: exact (normalized)
        if delivery_sku == fs or norm_d == norm_f:
            base_matches.add(fs)
        # 2: forecast starts with delivery prefix
        elif norm_f.startswith(norm_d + "_"):
            base_matches.add(fs)
        # 3: delivery starts with forecast prefix
        elif norm_d.startswith(norm_f + "_"):
            base_matches.add(fs)

    # 4: expand each base match with usage-suffix variants if they exist in forecast
    all_matches: set[str] = set(base_matches)
    for bm in base_matches:
        norm_bm = _norm_sku(bm)
        for sfx in USAGE_SFXS:
            if (norm_bm + sfx) in forecast_set:
                all_matches.add(norm_bm + sfx)

    # Also: delivery itself might be a usage-suffix variant (exact match)
    if delivery_sku in forecast_set:
        all_matches.add(delivery_sku)

    return sorted(all_matches)


def _build_meeting_skus_json(plan_path: Path, filename: str | None = None) -> dict | None:
    """納品表 Excel → forecast_data と照合した会議 SKU dict を返す."""
    try:
        from src.io_reader import read_planned_orders
        df = read_planned_orders(str(plan_path))
        if len(df) == 0:
            return None
    except Exception:
        return None

    raw_skus: list[str] = sorted(df["sku_id"].unique().tolist())

    # forecast_data.json の SKU リストを読んで照合
    forecast_skus: list[str] = []
    cache_paths = [CACHE_JSON, OUTPUT_DIR / "forecast_data.json"]
    for cp in cache_paths:
        if cp.exists():
            try:
                data = json.loads(cp.read_text(encoding="utf-8"))
                forecast_skus = [s["sku"] for s in data.get("skus", [])]
                break
            except Exception:
                pass

    resolved: set[str] = set()
    unresolved: list[str] = []
    for raw in raw_skus:
        matched = _match_delivery_sku(raw, forecast_skus) if forecast_skus else []
        if matched:
            resolved.update(matched)
        else:
            unresolved.append(raw)  # forecast にない銘柄はそのまま保持

    skus = sorted(resolved) + sorted(unresolved)
    fname = filename or plan_path.name
    return {"skus": skus, "filename": fname, "count": len(skus),
            "resolved": sorted(resolved), "unresolved": sorted(unresolved)}

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

    # 発注計画書アップロード時: 含まれる SKU リストを即時抽出して forecast と照合して保存
    if file_type == "plan":
        try:
            result = _build_meeting_skus_json(dest, filename)
            if result is not None:
                OUTPUT_DIR.mkdir(exist_ok=True)
                MEETING_SKUS_JSON.write_text(json.dumps(result, ensure_ascii=False))
        except Exception:
            pass

    return {"status": "ok", "filename": filename, "size": len(content), "file_type": file_type}


def _init_meeting_skus() -> None:
    """サーバ起動時に meeting_skus.json を初期化 (Render 再起動対応).

    output/ は Render 無料プランで揮発するため、起動時に候補ファイルから再生成する。
    """
    if MEETING_SKUS_JSON.exists():
        return  # 既存ファイルを優先
    for candidate in _DELIVERY_CANDIDATES:
        if candidate.exists():
            try:
                result = _build_meeting_skus_json(candidate)
                if result:
                    OUTPUT_DIR.mkdir(exist_ok=True)
                    MEETING_SKUS_JSON.write_text(json.dumps(result, ensure_ascii=False))
                    return
            except Exception:
                continue


# 起動時に実行
_init_meeting_skus()


@app.get("/api/meeting-skus")
def meeting_skus() -> dict:
    """溶材会議用 SKU リスト（最後にアップロードされた発注計画書から）."""
    if not MEETING_SKUS_JSON.exists():
        return {"skus": [], "filename": None, "count": 0}
    try:
        return json.loads(MEETING_SKUS_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {"skus": [], "filename": None, "count": 0}


class DecisionIn(BaseModel):
    sku: str
    ym: str    # "2026年8月" など — フロントが送る対象月ラベル
    qty: float


@app.post("/api/decisions")
def save_decision(body: DecisionIn) -> dict:
    """溶材会議で確定した発注量を保存する."""
    from datetime import datetime as _dt
    OUTPUT_DIR.mkdir(exist_ok=True)
    decisions: dict = {}
    if DECISIONS_JSON.exists():
        try:
            decisions = json.loads(DECISIONS_JSON.read_text(encoding="utf-8"))
        except Exception:
            pass
    key = f"{body.sku}__{body.ym}"
    decisions[key] = {
        "sku": body.sku,
        "ym": body.ym,
        "qty": body.qty,
        "saved_at": _dt.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    DECISIONS_JSON.write_text(json.dumps(decisions, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"status": "ok", "key": key}


@app.get("/api/decisions")
def get_decisions() -> dict:
    """保存済み最終決定量を取得する."""
    if not DECISIONS_JSON.exists():
        return {"decisions": {}}
    try:
        return {"decisions": json.loads(DECISIONS_JSON.read_text(encoding="utf-8"))}
    except Exception:
        return {"decisions": {}}


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
