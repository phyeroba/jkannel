# JKANNEL End-to-End Acceptance Suite

Playwright acceptance tests that drive the JKANNEL operations console (Vue 3 SPA)
against the **live REST API**, covering the critical operational workflows from
the Testing & QA engineering specification.

This project is **self-contained**: it has its own `package.json`,
`playwright.config.ts`, and TypeScript config. It does not touch the root or
`frontend/` package manifests.

## Prerequisites — the stack must already be running

The suite **assumes the stack is up**. It intentionally has **no `webServer`**
that rebuilds or serves the app. Before running:

- Frontend (Vite) reachable at `http://127.0.0.1:5173`
- API reachable at `http://127.0.0.1:3000/api/v1`
- An `operator` user provisioned whose password you pass via
  `E2E_OPERATOR_PASSWORD`.

Typical local bring-up (from the repo root, separate from this project):

```bash
docker compose up -d          # backend + database
cd frontend && npm run dev    # Vite dev server on 127.0.0.1:5173
```

## Install

```bash
cd e2e
npm install
npm run install:browsers      # downloads the Chromium browser Playwright drives
```

## Run

The operator password is required (there is no default):

```bash
# bash / git-bash
cd e2e
E2E_OPERATOR_PASSWORD='local-dev-operator-2026' npm test
```

```powershell
# PowerShell
cd e2e
$env:E2E_OPERATOR_PASSWORD = 'local-dev-operator-2026'
npm test
```

Useful variants:

```bash
npm run list          # discover/print every test without running
npm run typecheck     # tsc --noEmit — proves the specs compile
npm run test:headed   # watch the browser
npm run report        # open the last HTML report
```

## Configuration (env vars)

| Variable                | Default                          | Purpose                              |
| ----------------------- | -------------------------------- | ------------------------------------ |
| `E2E_BASE_URL`          | `http://127.0.0.1:5173`          | SPA base URL                         |
| `E2E_API_BASE_URL`      | `http://127.0.0.1:3000/api/v1`   | REST API base (with version segment) |
| `E2E_OPERATOR_PASSWORD` | _(required)_                     | Operator password                    |
| `E2E_OPERATOR_USERNAME` | `operator`                       | Operator username                    |
| `E2E_OPERATOR_TENANT`   | `default`                        | Tenant id                            |

## How authentication works

`global-setup.ts` runs once before the suite. It logs the operator in through
the REST API (`POST /auth/login`) and writes a Playwright `storageState` file
(`.auth/state.json`) that seeds the SPA's `localStorage` tokens
(`jkannel-access-token`, `jkannel-refresh-token`). The Playwright config points
`use.storageState` at that file, so **every spec boots already authenticated** —
no serial re-login.

The `auth.spec.ts` suite opts back out with
`test.use({ storageState: { cookies: [], origins: [] } })` so it exercises the
real login form (success, wrong-password failure, logout).

Specs that create data also get a worker-scoped, operator-authenticated REST
client (`api` fixture) used as a **cleanup safety net** — if a UI delete step
fails, the entity is still removed via the API.

## Test data & cleanup

Created entities are given unique, obviously-synthetic names
(`<prefix>-e2e-acceptance-<stamp>`) and are deleted at the end of the test that
created them, with an API-level `afterEach`/`finally` fallback. The suite queues
no real messages and sends no bulk campaigns.

Note: the console's "Delete / Archive" for an SMSC is a **soft delete** — the
`DELETE /smscs/:id` call moves the connection to the `archived` lifecycle rather
than removing the row. That is the product's delete semantics, so an archived
`e2e-acceptance` SMSC row may remain after a run; it is inert (disabled) and
clearly tagged.

## Coverage

| Spec                        | Workflow                                                                    |
| --------------------------- | --------------------------------------------------------------------------- |
| `auth.spec.ts`              | Login success, login failure (wrong password), logout                       |
| `navigation.spec.ts`        | Every primary-nav workspace loads its root region (smoke)                   |
| `smsc.spec.ts`              | List, open detail, create → edit → delete a fake SMSC (cleaned up)          |
| `routing.spec.ts`           | Target/Fallback SMSC dropdowns populate                                     |
| `messages.spec.ts`          | Grid loads; a row opens the trace drawer + events                           |
| `reports.spec.ts`           | Analytics panels render; definitions list loads; create → delete definition |
| `bulk-send.spec.ts`         | View loads; SMSC dropdown populates; recipient counter updates live         |
| `configuration.spec.ts`     | Templates panel lists built-ins; drift "Check now" resolves                 |
| `audit-notifications.spec.ts` | Audit grid loads + row detail; notification bell opens + item detail       |

## Design notes / resilience

- Selectors prefer `data-testid`, roles, and text — no brittle `nth-child`.
- Data-dependent steps (empty grids, unavailable backend features) degrade to a
  valid alternate assertion and record a test annotation rather than failing, so
  the suite is meaningful on both seeded and fresh environments.
- `retries=1`, `trace=on-first-retry`, screenshots + video on failure.
