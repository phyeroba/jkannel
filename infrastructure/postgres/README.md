# PostgreSQL

PostgreSQL is JKANNEL's system of record. Canonical ordered migrations and their validation contract live in `database/`; this infrastructure folder contains deployment notes only. Application identities must not own schema objects, and credentials come from the untracked `.env` file.
