# JKANNEL Codex Foundation Prompt

Use this prompt in Codex for the first implementation step.

```text
You are Codex working inside Visual Studio Code on a Windows machine.

Create a new project called JKANNEL on the D drive at:

D:\JKANNEL

JKANNEL is a GUI and management interface for Kannel SMS Gateway. The goal is to make Kannel easier to deploy, configure, monitor, and operate for technical and semi-technical users.

The application must manage Kannel running in Docker and provide a modern web-based admin interface for:

- SMSC gateway connections
- bearerbox and smsbox configuration
- SMS routes
- throttling rules
- live binds
- bind health
- throughput monitoring
- incoming SMS visibility
- outgoing SMS visibility
- delivery reports
- queues
- logs
- alerts
- system health
- configuration generation
- Docker lifecycle management
- backup and restore of configuration
- role-based administration

First task:

Create the complete project folder structure and memory/context system. Do not build the full app yet. Create the foundation files that will allow Codex to remember the project across VS Code reloads and future sessions.

Create the folder and file structure defined in JKANNEL_FOLDER_SCAFFOLDING.md.

Important memory behavior:

1. AGENTS.md is the master instruction file for Codex.
2. PROJECT_MEMORY.md stores long-term context.
3. PROJECT_STATE.md stores the current state of the project.
4. progress/session-log.md must be updated at the end of every major Codex task.
5. progress/next-actions.md must always contain the recommended next steps.
6. decisions/ must contain architectural decision records.
7. Never make large architectural changes without writing or updating an ADR.
8. Every time you create, change, or remove an important feature, update PROJECT_STATE.md.
9. Every time you complete a task, update progress/completed.md and progress/session-log.md.
10. Every time you discover uncertainty, update progress/blockers.md or progress/pending.md.
11. Treat these Markdown files as the project memory system.

Technology direction for now:

- Kannel runs in Docker.
- The management platform should eventually use a web backend API and modern frontend.
- Preferred backend direction: Laravel, Node.js/NestJS, or Django. Do not decide permanently yet. Document options.
- Preferred database: PostgreSQL.
- Redis may be used later for queues, cache, rate limiting, and live monitoring.
- The frontend should become a clean modern admin dashboard.
- The system must be modular so it can support many SMSC providers, multiple routes, multiple tenants, and future billing features.
- The first phase is not full implementation. The first phase is project foundation, documentation, architecture, and local Docker Kannel baseline.

Write useful starter content into every Markdown file. Do not leave empty placeholder files.

AGENTS.md must include:

- project mission
- Codex working rules
- documentation update rules
- memory update rules
- coding standards
- testing expectations
- security expectations
- Docker expectations
- how to handle uncertainty
- how to report progress at the end of each session

PROJECT_MEMORY.md must explain:

- JKANNEL is a management interface for Kannel SMS Gateway
- the product exists to make Kannel less technical
- the system should expose everything Kannel produces: logs, binds, throughput, routing, delivery, queues, health, and configuration
- Kannel will run inside Docker
- the UI must feel like a modern network/SMS operations dashboard
- the project owner wants Codex to behave like an engineer with persistent project memory

PROJECT_STATE.md must include:

- current phase
- what exists
- what does not exist yet
- technical assumptions
- next milestone
- open questions

ROADMAP.md must include phased development:

Phase 0: Project memory and structure
Phase 1: Dockerized Kannel baseline
Phase 2: Configuration generator
Phase 3: Backend API
Phase 4: Dashboard UI
Phase 5: Logs and observability
Phase 6: SMS traffic visibility
Phase 7: Routing and throttling management
Phase 8: Multi-user security
Phase 9: Production packaging

The Docker files should be starter files only. Do not assume credentials. Use safe defaults and .env.example.

For docker-compose.yml, create a starter compose file with services planned for:

- kannel
- postgres
- redis

Use comments where implementation details still need confirmation.

After creating the files, summarize:

- what was created
- how Codex should use the memory files
- what the next practical task should be

Do not start building the full backend or frontend yet.
```
