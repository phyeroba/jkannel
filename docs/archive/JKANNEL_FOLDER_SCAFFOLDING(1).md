# JKANNEL Folder Scaffolding

This document defines the repository structure Codex must create for the JKANNEL project.

## Root Location

```text
D:\JKANNEL
```

## Phase 0 Rule

Codex must create the foundation files and folders first. It must not build the full backend, frontend, or production SMS platform during Phase 0.

Every Markdown file must contain useful starter content. Do not create empty placeholder files.

## Required Root Files

```text
D:\JKANNEL
├── AGENTS.md
├── README.md
├── PROJECT_MEMORY.md
├── PROJECT_STATE.md
├── ROADMAP.md
├── TASKS.md
├── CHANGELOG.md
├── SYSTEM_ENGINEERING_HANDBOOK.md
├── PROCEDURE.md
├── BUILD_TRACKER.md
├── PENDING-INVENTORY.md
├── CODEX_BUILD_PROMPT.md
├── .gitignore
└── .env.example
```

## Required Root Folders

```text
D:\JKANNEL
├── docs\
├── design\
├── design_spec\
├── decisions\
├── progress\
├── architecture\
├── infrastructure\
├── backend\
├── frontend\
├── scripts\
├── tests\
├── monitoring\
├── deployments\
├── examples\
├── tasks\
├── agents\
└── storage\
```

## Important: `design_spec/`

The `design_spec/` folder already exists on the project owner's laptop and contains an uploaded HTML design from another application.

Codex must include this folder in the repository structure and must treat it as a design reference.

Rules for `design_spec/`:

- Do not delete it.
- Do not overwrite it.
- Do not blindly copy legacy HTML into the JKANNEL frontend.
- Use it to understand layout, styling direction, dashboard ideas, cards, navigation, forms, and admin screen structure.
- Convert useful ideas into JKANNEL-native frontend components later.
- Record any adopted design decisions in `design/design-decisions.md`.

Suggested internal organization if Codex later needs to document it:

```text
design_spec\
├── original-html\
├── screenshots\
├── extracted-assets\
├── style-notes.md
├── component-mapping.md
└── jkannel-ui-adaptation-plan.md
```

## `docs/` Folder

```text
docs\
├── overview.md
├── product-requirements.md
├── user-stories.md
├── terminology.md
├── operating-model.md
├── installation-guide.md
├── administrator-guide.md
└── developer-guide.md
```

## `design/` Folder

```text
design\
├── ui-vision.md
├── dashboard-layout.md
├── navigation-map.md
├── screen-inventory.md
├── admin-template-requirements.md
└── design-decisions.md
```

## `decisions/` Folder

```text
decisions\
├── ADR-0001-project-direction.md
├── ADR-0002-docker-first-kannel.md
├── ADR-0003-configuration-management.md
└── ADR-0004-observability-and-logs.md
```

## `progress/` Folder

```text
progress\
├── session-log.md
├── completed.md
├── pending.md
├── blockers.md
├── bugs.md
└── next-actions.md
```

## `architecture/` Folder

```text
architecture\
├── system-architecture.md
├── docker-architecture.md
├── data-model.md
├── api-design.md
├── security-model.md
├── monitoring-model.md
└── kannel-integration-model.md
```

## `infrastructure/` Folder

```text
infrastructure\
├── docker\
│   └── docker-compose.yml
├── kannel\
│   ├── README.md
│   ├── kannel.conf.example
│   ├── smsbox.conf.example
│   └── smsc-examples.md
├── postgres\
│   └── README.md
└── redis\
    └── README.md
```

## Application Folders

```text
backend\
└── README.md

frontend\
└── README.md

scripts\
└── README.md

tests\
└── README.md
```

## Future Expanded Backend Structure

The following structure is not required in Phase 0, but should guide future implementation:

```text
backend\
├── src\
│   ├── config\
│   ├── modules\
│   │   ├── auth\
│   │   ├── dashboard\
│   │   ├── smsc\
│   │   ├── kannel\
│   │   ├── routing\
│   │   ├── throttling\
│   │   ├── messages\
│   │   ├── dlr\
│   │   ├── queues\
│   │   ├── logs\
│   │   ├── alerts\
│   │   ├── users\
│   │   ├── roles\
│   │   ├── api-keys\
│   │   ├── webhooks\
│   │   ├── reports\
│   │   └── engine-control\
│   ├── adapters\
│   │   └── sms-engine\
│   │       ├── SmsEngineAdapter
│   │       ├── KannelAdapter
│   │       └── KamexAdapter
│   ├── workers\
│   ├── services\
│   ├── middleware\
│   ├── shared\
│   └── types\
└── tests\
```

## Future Expanded Frontend Structure

```text
frontend\
├── src\
│   ├── components\
│   ├── layouts\
│   ├── views\
│   │   ├── dashboard\
│   │   ├── smsc\
│   │   ├── kannel\
│   │   ├── routing\
│   │   ├── throttling\
│   │   ├── messages\
│   │   ├── dlr\
│   │   ├── queues\
│   │   ├── logs\
│   │   ├── alerts\
│   │   ├── settings\
│   │   └── administration\
│   ├── stores\
│   ├── router\
│   ├── services\
│   ├── types\
│   └── styles\
└── tests\
```

## Starter Docker Compose Scope

`infrastructure/docker/docker-compose.yml` should be a starter file only.

It should plan services for:

- kannel
- postgres
- redis

Use comments where implementation details still need confirmation. Do not assume real credentials.

## Required Content Rules

Every Markdown file must include practical starter content.

Examples:

- `AGENTS.md` must include Codex rules, memory behavior, documentation rules, testing expectations, security expectations, Docker expectations, and uncertainty handling.
- `PROJECT_MEMORY.md` must explain the long-term JKANNEL vision.
- `PROJECT_STATE.md` must include current phase, what exists, what does not exist, assumptions, milestone, and open questions.
- `ROADMAP.md` must include Phases 0 through 9.
- `progress/next-actions.md` must always contain recommended next steps.
- ADR files must explain why the decision exists and what is accepted for now.

## End-of-Task Summary Required

After creating the structure, Codex must summarize:

- What was created
- How Codex should use the memory files
- What the next practical task should be
