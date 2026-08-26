# Built with the repo root as build context (uv workspace: services/api depends
# on packages/py-db as a workspace member, and uv needs every member's
# pyproject.toml present to resolve against the shared root uv.lock).
FROM python:3.11-slim

RUN pip install --no-cache-dir uv

WORKDIR /app

COPY . .

RUN uv sync --frozen --package api

EXPOSE 8000

CMD ["uv", "run", "--package", "api", "uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
