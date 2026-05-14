"""SKU名寄せモジュール: 銘柄表記揺れを統一キー sku_id に正規化."""
import re
import unicodedata


def _format_num_str(s: str) -> str:
    """数値文字列を `:g` 形式に正規化 (`4.0` → `4`, `3.20` → `3.2`).

    空文字 / 数値変換失敗時は空文字を返す。
    """
    if s is None or s == "":
        return ""
    try:
        f = float(s)
    except (TypeError, ValueError):
        return ""
    return f"{f:g}"


def _extract_number_str(raw, is_last: bool = False) -> str:
    """文字列から数値を抽出して `:g` 正規化した文字列で返す。

    is_last=True の場合、複数の数値があれば最後のものを採用。
    """
    if raw is None or str(raw).strip() == "":
        return ""
    s = unicodedata.normalize("NFKC", str(raw))
    nums = re.findall(r"(\d+\.?\d*)", s)
    if not nums:
        return ""
    picked = nums[-1] if is_last else nums[0]
    return _format_num_str(picked)


def normalize_brand(raw: str) -> str:
    """銘柄文字列を正規化: 全角→半角、英数字のみ大文字に."""
    if raw is None:
        return ""
    s = unicodedata.normalize("NFKC", str(raw))
    for prefix in ("ワイヤー", "ワイヤ", "フラックス"):
        s = s.replace(prefix, "")
    s = re.sub(r"[^A-Za-z0-9]", "", s)
    return s.upper()


def normalize_diameter(raw) -> float:
    """径表記から数値を抽出: '1.2φ' → 1.2, '1.2×15' → 1.2."""
    if raw is None or str(raw).strip() == "":
        return 0.0
    s = unicodedata.normalize("NFKC", str(raw))
    nums = re.findall(r"(\d+\.?\d*)", s)
    if not nums:
        return 0.0
    return float(nums[0])


def normalize_unit_weight(raw) -> float:
    """単位重量から数値を抽出: '15kg' → 15.0, '1.2×15' → 15.0."""
    if raw is None or str(raw).strip() == "":
        return 0.0
    s = unicodedata.normalize("NFKC", str(raw))
    is_last = "×" in s or "x" in s.lower()
    nums = re.findall(r"(\d+\.?\d*)", s)
    if not nums:
        return 0.0
    return float(nums[-1] if is_last else nums[0])


def make_sku_id(brand: str, diameter, unit_weight) -> str:
    """3要素を統一キーに結合 (数値は `:g` 正規化)."""
    b = normalize_brand(brand)
    d_str = _extract_number_str(diameter, is_last=False)
    w_str = _extract_number_str(unit_weight, is_last=True)
    sku_id = f"{b}_{d_str}_{w_str}"
    return _SKU_ALIASES.get(sku_id, sku_id)


# 末尾が単一数値 (径) のみのパターン用 (×セパレータ無し)
_TRAILING_DIAMETER_RE = re.compile(r"\s+(\d+\.?\d*)\s*$")

# 既知の誤表記 sku_id → 正規 sku_id マッピング
# ベース sku_id のみ登録。使用区分サフィックス (_板継用 等) は別途付与されるため不要。
_SKU_ALIASES: dict[str, str] = {
    "DW309MOL_1.2_12.6": "DW309MOL_1.2_12.5",  # 全姿勢用スプール誤表記 (12.6→12.5)
}
# × セパレータで径×重量を含むパターン
_SIZE_RE = re.compile(r"(\d+\.?\d*)\s*[×xX]\s*(\d+\.?\d*)")
# 重量のみ: "× weight" (径なし) — _format_size_label が "× w" 形式で書くケース
_WEIGHT_ONLY_RE = re.compile(r"[×xX]\s*(\d+\.?\d*)\s*$")


def parse_inventory_name(raw_name: str):
    """在庫管理表の銘柄表記から sku_id を生成.

    優先パターン:
      1. `銘柄 d×w` (× セパレータあり・両数値) → 径と重量を抽出
      2. `銘柄 ×w` (先頭 × のみ・重量のみ) → 重量のみ抽出、径は空
      3. `銘柄 d` (末尾に単一数値) → 径のみ抽出、重量は空
      4. それ以外 → 銘柄のみ、径と重量は空

    数値は `:g` 形式に正規化 (`4.0` → `4`)。

    Returns: (sku_id, brand_only)
    """
    s = unicodedata.normalize("NFKC", str(raw_name))
    size_match = _SIZE_RE.search(s)
    if size_match:
        d_str = _format_num_str(size_match.group(1))
        w_str = _format_num_str(size_match.group(2))
        brand_part = s[: size_match.start()] + s[size_match.end():]
    else:
        weight_match = _WEIGHT_ONLY_RE.search(s)
        if weight_match:
            w_str = _format_num_str(weight_match.group(1))
            d_str = ""
            brand_part = s[: weight_match.start()]
        else:
            trail_match = _TRAILING_DIAMETER_RE.search(s)
            if trail_match:
                d_str = _format_num_str(trail_match.group(1))
                w_str = ""
                brand_part = s[: trail_match.start()]
            else:
                d_str = ""
                w_str = ""
                brand_part = s
    brand = normalize_brand(brand_part)
    sku_id = f"{brand}_{d_str}_{w_str}"
    return _SKU_ALIASES.get(sku_id, sku_id), brand
