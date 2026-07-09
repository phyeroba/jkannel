# Database migrations

Migrations are deterministic PostgreSQL SQL pairs and run in lexical order. Each `*.up.sql` has a matching `*.down.sql`. Production automation must record the filename and SHA-256 in `schema_migrations` and refuse a changed checksum.

For the local Compose database:

```powershell
Get-Content database/migrations/001_foundation.up.sql | docker compose exec -T postgres psql -U jkannel -d jkannel -v ON_ERROR_STOP=1
Get-Content database/migrations/002_engine_observability.up.sql | docker compose exec -T postgres psql -U jkannel -d jkannel -v ON_ERROR_STOP=1
Get-Content database/tests/phase3.sql | docker compose exec -T postgres psql -U jkannel -d jkannel -v ON_ERROR_STOP=1
```

Rollback applies down migrations in reverse order. Never edit an applied migration; add a new pair. Application transactions must set `SET LOCAL app.tenant_id = '<internal tenant id>'` before accessing an RLS-protected engine table. Runtime credentials are secret-manager references only.
