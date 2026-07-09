# JKANNEL Agent Operating Guide

All automated contributors must read `PROJECT_STATE.md`, `PROJECT_MEMORY.md`, `TASKS.md`, and the relevant canonical specifications before changing the repository.

## Engineering rules

- Follow `docs/handbook/SYSTEM_ENGINEERING_HANDBOOK.md` and the ADRs in `decisions/`.
- Keep engine-specific behavior behind the Engine Adapter abstraction.
- Treat `design/design_spec/` as visual authority, while replacing legacy JVIDEO terminology with JKANNEL domain language.
- Never commit secrets. Add documented placeholders to `.env.example`.
- Add tests and documentation with implementation changes.
- Record meaningful work in `CHANGELOG.md`, `PROJECT_STATE.md`, and `progress/session-log.md`.
- Keep the Docker Compose developer path operational.

## Delivery loop

Plan, implement, test, review architecture/security/performance, update documentation, and record the next action. Do not mark work complete when required validation is failing.

