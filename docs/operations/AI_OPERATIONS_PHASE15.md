# AI Operations Phase 15 Foundation

JKANNEL's first AI Operations workflow is a deterministic, local explain/assist service. It makes no external AI or network calls, accepts no provider keys, and never performs an operational action.

## Safety contract

- The entire profile is disabled unless deployment configuration sets `AI_OPERATIONS_ENABLED=true` (default: `false`). Every request additionally requires authenticated `monitoring.view` access and `X-JKANNEL-AI-OPT-IN: true`.
- Questions and normalized evidence are redacted before analysis or persistence. Token-like values, phone numbers, credential assignments, and sensitive evidence sources are removed.
- Empty evidence produces `insufficient_data` with zero confidence; the service does not invent observations.
- Recommendations carry evidence, reasoning, confidence, risk, and the fixed model provenance `local-rules/phase15-v1`.
- A recommendation requested with `allowRecommendation: true` is `approval_required`. Only a `system.manage` human can approve or reject it, with a reason. Approval records intent only; it does not execute a change.
- PostgreSQL RLS scopes records to the authenticated tenant. Request and decision events are appended to the immutable audit log with correlation IDs and without raw evidence.

## API

`POST /api/v1/ai/assistance`

```json
{
  "question": "Why is the outbound queue growing?",
  "evidence": [{"source":"queue.depth","observation":"Depth increased for 15 minutes","value":4200,"unit":"messages"}],
  "allowRecommendation": true
}
```

`GET /api/v1/ai/assistance/{id}` retrieves a tenant-owned record.

`POST /api/v1/ai/assistance/{id}/decisions` accepts `{"decision":"approve|reject","reason":"..."}`. A second decision fails closed.

This foundation is intentionally narrow. Telemetry collection, model providers, automated execution, and learning are not implied by these endpoints and require separate reviewed phases.
