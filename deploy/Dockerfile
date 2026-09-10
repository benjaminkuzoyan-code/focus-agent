# Focus Agent coach bridge — the API engine only (no Claude Code login on a server).
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir anthropic
COPY bridge/coach_server.py bridge/coach_server.py
ENV FA_HOST=0.0.0.0 PORT=8000 PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python3", "bridge/coach_server.py"]
