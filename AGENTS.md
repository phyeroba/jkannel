# JKANNEL Agent Operating Guide

Repository layout: canonical specifications live under `docs/`; living project documents (state, roadmap, changelog, proposals, handover, memory, catalog) live under `project/`; only this file and `README.md` remain at the repository root.

All automated contributors must read `project/PROJECT_STATE.md`, `project/PROJECT_MEMORY.md`, `project/TASKS.md`, and the relevant canonical specifications under `docs/` before changing the repository.

## Engineering rules

- Follow `docs/handbook/SYSTEM_ENGINEERING_HANDBOOK.md` and the ADRs in `decisions/`.
- Keep engine-specific behavior behind the Engine Adapter abstraction.
- Treat `design/design_spec/` as visual authority, while replacing legacy JVIDEO terminology with JKANNEL domain language.
- Never commit secrets. Add documented placeholders to `.env.example`.
- Add tests and documentation with implementation changes.
- Record meaningful work in `project/CHANGELOG.md`, `project/PROJECT_STATE.md`, and `progress/session-log.md`.
- Keep the Docker Compose developer path operational.

## Delivery loop

Plan, implement, test, review architecture/security/performance, update documentation, and record the next action. Do not mark work complete when required validation is failing.

