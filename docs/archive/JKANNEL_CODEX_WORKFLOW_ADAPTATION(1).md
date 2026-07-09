# JKANNEL Codex Workflow Adaptation

This document adapts the strongest workflow ideas from the owner's previous Claude-based project process into JKANNEL.

The goal is to make Codex behave like a disciplined software engineer with persistent project memory.

## Core Operating Principle

Codex must not treat each VS Code session as a fresh project.

Codex must read project memory, understand current state, check blockers, make a plan, then make controlled changes.

## Files Codex Must Read at the Start of Every Session

At the start of each session, Codex must read:

1. `AGENTS.md`
2. `PROJECT_MEMORY.md`
3. `PROJECT_STATE.md`
4. `TASKS.md`
5. `ROADMAP.md`
6. `progress/next-actions.md`
7. `progress/blockers.md`
8. `progress/pending.md`
9. Relevant files in `decisions/`

If working on a specific phase or task, Codex must also read the matching file in `tasks/` if one exists.

## Required Session Start Ritual

Codex must begin every work session by answering internally:

- What phase is active?
- What task is next?
- What files define the requirements?
- Are there blockers?
- Is there an ADR that controls this work?
- Is the requested change safe to make now?

Codex should then produce a short plan before changing files.

## Approval Gates

For controlled development, Codex must follow these gates:

### Pre-Code Gate

Before writing code or making large file changes, Codex must present:

- What it will implement
- Which files it will create or modify
- What assumptions it is making
- Which requirement, task, or ADR justifies the change

### Pre-Commit Gate

Before committing, Codex must summarize:

- Files changed
- What changed in each file
- Tests/checks performed
- Documentation updated

### Pre-Push Gate

Codex must never push without explicit approval.

### Destructive Change Gate

Codex must never perform destructive actions without explicit approval.

Examples:

- Dropping tables
- Deleting directories
- Overwriting `design_spec/`
- Replacing architecture decisions
- Removing Docker services
- Removing documentation history

## Documentation Update Rules

Codex must update documentation when it changes:

- Architecture
- Folder structure
- Docker behavior
- Configuration behavior
- API behavior
- Database design
- Security model
- User roles
- SMS gateway integration behavior
- Operational assumptions

## Memory Update Rules

After meaningful work:

- Update `PROJECT_STATE.md`
- Update `progress/session-log.md`
- Update `progress/completed.md`
- Update `progress/next-actions.md`
- Update `progress/pending.md` if something is deferred
- Update `progress/blockers.md` if something prevents progress
- Update `CHANGELOG.md` when user-visible or architectural changes occur

## ADR Rules

Codex must create or update an ADR before making major architecture decisions.

ADR examples:

- Backend framework selection
- Engine adapter design
- Docker deployment strategy
- Configuration generation model
- Observability and logs model
- API authentication model
- Multi-tenant model
- Database schema strategy

Never make a large architectural decision only in code.

## Uncertainty Handling

If Codex is unsure, it must not invent facts.

It should record uncertainty in one of:

- `progress/pending.md`
- `progress/blockers.md`
- `PENDING-INVENTORY.md`
- an ADR as an open question

Examples of uncertainty:

- Kannel vs Kamex default engine
- Backend stack selection
- Final frontend framework
- Exact Kannel admin/status endpoint behavior
- SMSC provider credentials
- Production deployment topology

## Testing Expectations

Every implementation phase must define relevant checks.

Likely checks:

- Lint
- Typecheck
- Unit tests
- API tests
- Docker Compose startup test
- Configuration generation validation
- Kannel config syntax validation
- Health endpoint checks

Do not mark a phase complete if the required checks are failing.

## Security Expectations

Codex must never hardcode real secrets.

Use `.env.example` with safe placeholders.

Sensitive values include:

- Kannel admin password
- SMSC passwords
- API keys
- JWT secrets
- Database passwords
- Redis passwords
- Webhook secrets

Secrets must be referenced by environment variable name only.

## Docker Expectations

Docker is a first-class requirement.

Kannel/Kamex must run in Docker.

The backend, frontend, database, Redis, and monitoring stack should be container-friendly.

Starter Docker files are allowed in Phase 0, but production assumptions must be clearly documented before implementation.

## `design_spec/` Handling

The `design_spec/` folder exists on the owner's laptop and contains an HTML design from another app.

Codex must:

- Preserve the folder
- Review it when working on UI
- Extract useful ideas
- Rebuild the UI using JKANNEL's chosen frontend stack
- Document adapted ideas in `design/design-decisions.md`

Codex must not:

- Delete the folder
- Overwrite the folder
- Treat the legacy HTML as final JKANNEL frontend code

## Recommended End-of-Session Report

At the end of each session, Codex should report:

```text
Session Summary
- Completed:
- Files created/changed:
- Tests/checks run:
- Documentation updated:
- Decisions made:
- Pending items:
- Blockers:
- Recommended next task:
```

## First Practical Codex Task

The first practical Codex task should be:

Create the complete `D:\JKANNEL` folder structure, memory files, documentation files, ADRs, progress files, starter infrastructure files, and safe Docker baseline files.

Do not build the full backend or frontend yet.
