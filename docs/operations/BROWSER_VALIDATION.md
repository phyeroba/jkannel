# Browser validation

The preferred interactive workflow is Codex App Browser Use (`@Browser`) with the Browser plugin enabled. The VS Code extension may not expose the Node REPL tool required by Browser Use in every thread, so JKANNEL also has a repository-owned Playwright path that runs against installed Google Chrome.

Start the Compose stack, then supply the local validation password only in the process environment:

```powershell
$env:JKANNEL_E2E_PASSWORD='<local operator password>'
cd frontend
npm run test:e2e
```

`npm run test:visual` runs the desktop visual checks. Evidence, traces, screenshots, and videos are written below ignored `artifacts/` directories. Credentials are never stored in the repository.

The suite checks the canonical design tokens, split-screen login, grouped SVG navigation, authenticated dashboard, mobile viewport, and critical navigation. Component tests remain the faster inner loop; Playwright is the rendered-browser acceptance gate.
