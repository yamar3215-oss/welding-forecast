"""UI連携用ランチャ.

UI からは下記のように呼び出してください:
    python run.py
あるいは venv 同梱なら:
    .venv\\Scripts\\python.exe run.py

入力ファイル名に日本語があるため、 cmd の cp932 と衝突しない
Python ランチャ経由で src.main を呼びます。
"""
from __future__ import annotations
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INPUT = ROOT / "input"
OUTPUT = ROOT / "output"
CONFIG = ROOT / "config"

DATA = INPUT / "data.xlsx"
# Web からアップロードされたファイルを優先; なければデフォルト名を使用
_UPLOADED_INV = INPUT / "uploaded_inventory.xlsx"
INV_ACTUAL = _UPLOADED_INV if _UPLOADED_INV.exists() else INPUT / "溶接棒在庫管理表　在庫評価追加_1.xlsx"
INV_PLAN = INPUT / "溶接棒在庫管理表　在庫評価追加_2.xlsx"


def main() -> int:
    missing = [p.name for p in (DATA, INV_ACTUAL) if not p.exists()]
    if missing:
        sys.stderr.write(
            "[ERROR] 必須入力ファイルがありません:\n"
            + "\n".join(f"  - input\\{m}" for m in missing)
            + "\n"
        )
        return 2

    OUTPUT.mkdir(exist_ok=True)

    cmd = [
        sys.executable, "-m", "src.main",
        "--data", str(DATA),
        "--inventory", str(INV_ACTUAL),
        "--output-dir", str(OUTPUT),
        "--config-dir", str(CONFIG),
    ]
    if INV_PLAN.exists():
        cmd += ["--inventory-validate", str(INV_PLAN)]
    # 追加 CLI 引数 (forecast-months 等) はそのまま forward
    cmd += sys.argv[1:]

    proc = subprocess.run(cmd, cwd=ROOT)
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
