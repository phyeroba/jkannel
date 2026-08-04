# Nginx reverse proxy

JKANNEL ships **two** reverse-proxy topologies. They are separate compose
services with separate config directories, and only one runs at a time.

| Topology | Service | Config dir | Profile | HTTPS terminated by |
| -------- | ------- | ---------- | ------- | ------------------- |
| **TLS terminated upstream** (default) | `reverse-proxy` | `conf.d/` | _(none — always on)_ | something in front of JKANNEL |
| **TLS terminated by JKANNEL** | `reverse-proxy-tls` | `tls/` | `tls` | this container |

Both run `nginxinc/nginx-unprivileged` (master + workers as the non-root uid
101) with a read-only root filesystem and all Linux capabilities dropped, and
both route identically:

| Path       | Upstream        | Notes                                  |
| ---------- | --------------- | -------------------------------------- |
| `/api/`    | `backend:3000`  | `/api` prefix preserved (`/api/v1/*`). |
| `/`        | `frontend:5173` | Vite dev server incl. HMR websocket.   |
| `/healthz` | nginx           | Liveness endpoint for the healthcheck. |

Because nginx runs unprivileged it cannot bind ports below 1024, so **inside**
the container it always listens on `8080` (HTTP) and `8443` (HTTPS). The host
mapping is what makes those 80/443.

---

## Topology 1 — TLS terminated upstream (today's deployment)

```
internet ──TLS──▶ system nginx / cloud LB ──HTTP──▶ reverse-proxy:8080 ──▶ backend, frontend
                  (holds the certificate)           (${PROXY_HTTP_PORT})
```

Nothing to enable; this is what `docker compose up -d` starts. The
`reverse-proxy` service is HTTP-only **by design** and its `ports:` list must
stay HTTP-only — a live deployment depends on that exact list.

The upstream terminator must send the standard forwarding headers. The backend
derives `request.clientIp` from the right-most hop it did not add itself, so
also set `TRUSTED_PROXY_COUNT` / `TRUSTED_PROXIES` to match the number of hops
(see `.env.example`). A minimal system-nginx server block:

```nginx
server {
    listen 443 ssl;
    server_name jkannel.example.com;
    ssl_certificate     /etc/letsencrypt/live/jkannel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/jkannel.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;   # must say https
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

`X-Forwarded-Proto: https` matters: it is what tells the app the session really
arrived over TLS.

---

## Topology 2 — TLS terminated by JKANNEL (opt-in)

```
internet ──TLS──▶ reverse-proxy-tls:8443 ──▶ backend, frontend
          HTTP ─▶ reverse-proxy-tls:8080 ──301──▶ https://…
```

A separate, profile-gated service so that enabling it cannot disturb the
running HTTP-only proxy. Config lives in `tls/`, split so the include order is
obvious:

| File                    | Contents                                                     |
| ----------------------- | ------------------------------------------------------------ |
| `00-shared.conf`        | upstreams, websocket map, gzip, TLS protocol/cipher policy     |
| `10-http-redirect.conf` | `:8080` → 301 to HTTPS, plus `/healthz` and the ACME webroot   |
| `20-https.conf`         | `:8443 ssl http2`, HSTS, security headers, proxy routes        |

### Enable it

1. **Get a certificate.** Two named files are expected in the mounted cert
   directory:

   | File          | Contents                                             |
   | ------------- | ---------------------------------------------------- |
   | `jkannel.crt` | full chain — leaf first, then intermediates, no root  |
   | `jkannel.key` | private key, mode `0600`, readable by uid 101         |

   *Development:*

   ```bash
   bash infrastructure/nginx/generate-dev-certs.sh
   ```

   *Production, Let's Encrypt (`fullchain.pem` → `jkannel.crt`,
   `privkey.pem` → `jkannel.key`):* point `TLS_CERT_DIR` straight at the live
   directory and use the `http-01` webroot that `10-http-redirect.conf` already
   serves — the redirect deliberately does not apply to
   `/.well-known/acme-challenge/`:

   ```bash
   certbot certonly --webroot \
     --webroot-path "$PWD/infrastructure/nginx/acme" \
     -d jkannel.example.com
   ```

   Renewal only rewrites the files, so a `docker compose kill -s HUP
   reverse-proxy-tls` in the deploy hook is enough — no restart.

2. **Configure `.env`:**

   ```bash
   TLS_CERT_DIR=/etc/letsencrypt/live/jkannel.example.com
   PROXY_TLS_BIND_ADDRESS=0.0.0.0     # default 127.0.0.1 — see the warning below
   PROXY_TLS_HTTP_PORT=80
   PROXY_HTTPS_PORT=443
   FRONTEND_ORIGIN=https://jkannel.example.com
   VITE_API_BASE_URL=https://jkannel.example.com/api
   VITE_ALLOWED_HOSTS=jkannel.example.com
   ```

3. **Start it:**

   ```bash
   docker compose --profile tls up -d reverse-proxy-tls
   ```

> **The bind address defaults to `127.0.0.1` on purpose.** On a shared host,
> merely enabling a profile must never publish a new listener to the internet.
> Setting `PROXY_TLS_BIND_ADDRESS=0.0.0.0` is the deliberate step that makes
> this proxy public — and it is also the point at which you must confirm ports
> 80/443 are not already taken by a co-hosted stack.

### TLS policy in `00-shared.conf`

- **Protocols:** TLS 1.2 + 1.3 only. 1.0/1.1 are not offered.
- **Ciphers:** the Mozilla *intermediate* suite — ECDHE/DHE with AES-GCM and
  ChaCha20-Poly1305; no CBC, no RSA key exchange, so every suite has forward
  secrecy. `ssl_prefer_server_ciphers off` lets modern clients pick the suite
  their hardware handles best.
- **Curves:** X25519 first.
- **Session resumption:** 10 MB shared cache, 1 day; **tickets off** (without
  key rotation they weaken forward secrecy).
- **OCSP stapling:** off by default, with the three lines to uncomment once you
  have a real CA chain (a self-signed cert has no responder).

### HSTS — read before you deploy

`20-https.conf` sends `Strict-Transport-Security: max-age=31536000;
includeSubDomains`. Once a browser has seen that header, it refuses plain HTTP
to that host for a year and a bad certificate becomes an error page users
cannot click through. Start with `max-age=300` while validating the chain, then
raise it. `preload` is deliberately **not** set: it is effectively irreversible
and must be an explicit decision.

---

## Certificates directory

`certs/` is the default mount (`TLS_CERT_DIR`) and is gitignored
(`*.crt`, `*.key`, `*.pem`) so private keys are never committed. `acme/` is the
http-01 webroot; it is mounted read-only into the container because only the
ACME client on the host writes there.
