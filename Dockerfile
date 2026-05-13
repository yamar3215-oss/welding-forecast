FROM python:3.12-slim

WORKDIR /app

# システム依存パッケージ（openpyxl の lxml 用）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxml2 \
    && rm -rf /var/lib/apt/lists/*

# 依存インストール（キャッシュ層を先に作る）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# アプリ本体をコピー（.venv / output は .dockerignore で除外）
COPY src/        ./src/
COPY static/     ./static/
COPY config/     ./config/
COPY input/      ./input/
COPY run.py      .

# 出力ディレクトリを用意（ボリュームマウント時も利用可能）
RUN mkdir -p output

EXPOSE 8000

CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8000"]
