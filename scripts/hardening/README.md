# Phase 16 hardening smoke checks

These non-production checks fail fast and require PowerShell 5.1 or newer and a running Compose stack.

- `security-smoke.ps1` verifies live health, correlation, cache, and defensive HTTP headers. It does not constitute penetration testing or TLS validation.
- `readiness-load-smoke.ps1` sends bounded concurrent health requests and enforces a configurable p95 smoke threshold. It is not a capacity, stress, soak, or HA test.
- `backup-restore-smoke.ps1` creates a PostgreSQL custom dump, computes SHA-256, verifies archive readability, restores into a disposable database, and queries migration metadata. It does not prove encryption, off-site replication, PITR, production RPO/RTO, or whole-platform recovery. The dump remains under `artifacts/backup-smoke` for inspection and must be protected or deleted by the operator.

Examples:

```powershell
pwsh scripts/hardening/security-smoke.ps1
pwsh scripts/hardening/readiness-load-smoke.ps1 -Requests 100 -Concurrency 10
pwsh scripts/hardening/backup-restore-smoke.ps1
```
