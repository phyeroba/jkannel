# Two-stage: build the SPA, then serve it as static files.
#
# WHY NOT THE DEV SERVER
# -----------------------------------------------------------------------------
# This image previously ran `npm run dev`, i.e. the Vite development server, in
# front of a public hostname. That is wrong for three reasons: Vite's host check
# returns `403 Blocked request` for any hostname not listed in
# VITE_ALLOWED_HOSTS (so every new domain broke the console until someone
# remembered), it ships an HMR websocket and unminified sources, and it is not
# built for production traffic.
#
# THE BUILD ARG IS NOT OPTIONAL, AND IT CANNOT BE A RUNTIME VARIABLE
# -----------------------------------------------------------------------------
# Vite inlines every VITE_* value into the bundle AT BUILD TIME. A runtime
# `environment:` entry in docker-compose never reaches the JavaScript — the
# bundle was already written. So the value has to arrive as a build ARG, and
# changing it requires rebuilding the image, not restarting the container.
#
# The default is a RELATIVE `/api`, which is what makes the same image work
# under any hostname: the browser resolves it against whatever origin served the
# page, so there is no hardcoded host and no CORS.

FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first: this layer is cached unless the lockfile changes, so an
# ordinary source edit does not re-run npm ci.
COPY package*.json ./
RUN npm ci

COPY tsconfig*.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src

ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build


# nginx-unprivileged, not the stock nginx image: it runs as a non-root user out
# of the box, so a container escape does not start from uid 0.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# Replace the default site rather than adding alongside it — the stock config
# listens on 8080 and would otherwise still be served.
COPY --chown=nginx:nginx nginx-spa.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html

EXPOSE 5173

HEALTHCHECK --interval=10s --timeout=5s --retries=10 \
  CMD ["/bin/sh", "-c", "wget --quiet --tries=1 --spider http://127.0.0.1:5173/healthz || exit 1"]
