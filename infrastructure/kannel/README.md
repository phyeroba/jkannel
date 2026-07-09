# Kannel Infrastructure

Kamex is the first containerized runtime under ADR-0008. Start it with `docker-compose --profile engine-kamex --env-file .env up -d --wait`. Never connect business modules directly to Kamex or Kannel administration endpoints.

`kannel.conf.example` is a non-runnable structural example. Supply secrets and environment-specific SMSC definitions outside source control.

`runtime/kamex/kamex.conf` uses environment-resolved secrets and a fake SMSC strictly for local validation. Production SMSCs and configuration are generated, versioned, validated, atomically written, audited, and gracefully reloaded through the Engine Adapter workflow.

The Kamex core image deliberately does not include SQLBox. JKANNEL therefore builds a small derivative from the official, digest-pinned image and installs the official 1.8.3 SQLBox RPM after SHA-256 verification. SQLBox sits between bearerbox and smsbox and owns `send_sms` (durable outbound queue) and `sent_sms` (MT/MO/DLR event history) in PostgreSQL. JKANNEL reads those native tables through `KamexSqlboxRepository` and inserts outbound submissions into `send_sms`; it does not duplicate Kamex queue semantics in control-plane tables.

Developer startup remains `docker-compose --profile engine-kamex --env-file .env up -d --build --wait`. On its first successful connection SQLBox creates its native PostgreSQL tables. The adapter reports `storage.sqlbox` as supported only after both tables are observable.
