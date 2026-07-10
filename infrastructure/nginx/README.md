# Nginx reverse proxy

The `reverse-proxy` service is the single HTTP entrypoint in front of the SPA
and the REST API. It runs `nginxinc/nginx-unprivileged` (master + workers run
as the non-root uid 101) with a read-only root filesystem and all Linux
capabilities dropped.

## Routing

| Path      | Upstream            | Notes                                   |
| --------- | ------------------- | --------------------------------------- |
| `/api/`   | `backend:3000`      | `/api` prefix preserved (`/api/v1/*`).  |
| `/`       | `frontend:5173`     | Vite dev server incl. HMR websocket.    |
| `/healthz`| nginx               | Liveness endpoint for the healthcheck.  |

Config lives in `conf.d/jkannel.conf` (mounted read-only). It sets sane proxy
timeouts, gzip for text/JSON, a 25 MB body limit for bulk imports, and baseline
security headers.

## Ports

nginx listens on `8080` (HTTP) and optionally `8443` (HTTPS) inside the
container. The host mapping is `${PROXY_HTTP_PORT:-8080}:8080`. The existing
direct ports (`5173` frontend, `3000` backend) remain published, so the proxy
is purely additive — nothing that worked before changes.

To make the SPA route its API calls through the proxy (rather than the direct
backend port), set in `.env`:

```
VITE_API_BASE_URL=http://localhost:8080/api
FRONTEND_ORIGIN=...,http://localhost:8080,http://127.0.0.1:8080
```

## TLS (optional)

1. Generate a self-signed dev certificate:
   ```
   bash infrastructure/nginx/generate-dev-certs.sh
   ```
2. Enable the HTTPS server block:
   ```
   cp infrastructure/nginx/conf.d/tls.conf.example infrastructure/nginx/conf.d/tls.conf
   ```
3. Publish the HTTPS port by uncommenting `${PROXY_HTTPS_PORT}:8443` on the
   `reverse-proxy` service in `docker-compose.yml`.
4. `docker compose up -d reverse-proxy`

Certificates live in `certs/` and are gitignored. For production, drop your CA
cert/key in as `jkannel.crt` / `jkannel.key` or mount them from a secret store.
