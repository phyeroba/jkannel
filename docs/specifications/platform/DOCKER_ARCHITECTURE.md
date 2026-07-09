# JKANNEL Docker Architecture

## Containers

-   frontend
-   backend
-   engine (Kannel/Kamex)
-   postgres
-   redis
-   nginx
-   prometheus
-   grafana

## Design Goals

-   Independent upgrades
-   Health checks
-   Persistent volumes
-   Network isolation
-   Environment-driven configuration

## Networking

Internal Docker network for service communication.

Only Nginx exposes public ports.

## Persistence

Persistent volumes for:

-   PostgreSQL
-   Redis (optional)
-   Engine configuration
-   Logs
-   Backups
