FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY gw2lb ./gw2lb
ENV GW2_DB=/data/leaderboard.db
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"
# One worker: SQLite in WAL mode handles this load, and one process keeps writes simple.
# Forwarded headers are trusted from any address: only ever reach this container through your reverse proxy.
CMD ["uvicorn", "gw2lb.app:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
