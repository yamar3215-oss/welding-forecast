"""Supabase REST API クライアント（標準ライブラリのみ使用・追加依存なし）.

環境変数 SUPABASE_URL / SUPABASE_KEY が未設定の場合、全操作は安全に無視される。

Supabase 側で事前に実行する CREATE TABLE SQL:

    -- 予測結果蓄積テーブル
    CREATE TABLE forecast_predictions (
        id           BIGSERIAL PRIMARY KEY,
        run_at       TIMESTAMPTZ NOT NULL,
        train_end    TEXT        NOT NULL,
        sku_id       TEXT        NOT NULL,
        year_month   TEXT        NOT NULL,
        predicted_kg REAL        NOT NULL,
        mape_pct     REAL,
        UNIQUE (run_at, sku_id, year_month)
    );

    -- MAPE 履歴テーブル（精度補正の土台）
    CREATE TABLE mape_history (
        id           BIGSERIAL PRIMARY KEY,
        run_at       TIMESTAMPTZ NOT NULL,
        train_end    TEXT        NOT NULL,
        sku_id       TEXT        NOT NULL,
        mape_pct     REAL        NOT NULL,
        overall_mape REAL,
        UNIQUE (run_at, sku_id)
    );
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

import pandas as pd

_BATCH_SIZE = 500  # PostgREST 推奨バッチサイズ


class SupabaseClient:
    """Supabase REST API への書き込みクライアント.

    SUPABASE_URL / SUPABASE_KEY が未設定なら enabled=False になり、
    save_* メソッドはすべて False を返して何もしない（パイプラインを止めない）。
    """

    def __init__(self) -> None:
        self._url = os.getenv("SUPABASE_URL", "").rstrip("/")
        self._key = os.getenv("SUPABASE_KEY", "")

    @property
    def enabled(self) -> bool:
        return bool(self._url and self._key)

    def _post(self, table: str, records: list[dict]) -> bool:
        """1 バッチ分のレコードを Upsert（UNIQUE 制約を使った merge-duplicates）."""
        if not self.enabled or not records:
            return False
        endpoint = f"{self._url}/rest/v1/{table}"
        payload = json.dumps(records, ensure_ascii=False, default=str).encode("utf-8")
        req = urllib.request.Request(
            endpoint,
            data=payload,
            headers={
                "apikey": self._key,
                "Authorization": f"Bearer {self._key}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status < 300
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:400]
            print(f"[Supabase] {table} HTTP {e.code}: {body}")
            return False
        except Exception as e:
            print(f"[Supabase] {table} failed: {e}")
            return False

    def save_forecast(
        self,
        run_at: str,
        train_end: str,
        forecast_df: pd.DataFrame,
        per_sku_mape: dict[str, float],
    ) -> bool:
        """予測結果を forecast_predictions テーブルに Upsert.

        Args:
            run_at:       ISO 8601 タイムスタンプ文字列（実行日時）
            train_end:    学習期間終端 (YYYY-MM)
            forecast_df:  columns: year_month, sku_id, 予測使用量
            per_sku_mape: {sku_id: mape_%}
        """
        records = [
            {
                "run_at": run_at,
                "train_end": train_end,
                "sku_id": str(row["sku_id"]),
                "year_month": str(row["year_month"]),
                "predicted_kg": float(row["予測使用量"]),
                "mape_pct": per_sku_mape.get(str(row["sku_id"])),
            }
            for _, row in forecast_df.iterrows()
        ]
        success = True
        for i in range(0, len(records), _BATCH_SIZE):
            if not self._post("forecast_predictions", records[i : i + _BATCH_SIZE]):
                success = False
        return success

    def save_mape(
        self,
        run_at: str,
        train_end: str,
        overall_mape: float,
        per_sku_mape: dict[str, float],
    ) -> bool:
        """MAPE 履歴を mape_history テーブルに Upsert.

        Args:
            run_at:       ISO 8601 タイムスタンプ文字列
            train_end:    学習期間終端 (YYYY-MM)
            overall_mape: 全銘柄平均 MAPE (%)
            per_sku_mape: {sku_id: mape_%}
        """
        records = [
            {
                "run_at": run_at,
                "train_end": train_end,
                "sku_id": sku_id,
                "mape_pct": float(mape_pct),
                "overall_mape": overall_mape,
            }
            for sku_id, mape_pct in per_sku_mape.items()
        ]
        return self._post("mape_history", records)
