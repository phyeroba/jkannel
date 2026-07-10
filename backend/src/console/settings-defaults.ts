export interface SettingDefault {
  key: string;
  group: string;
  value: unknown;
  type: 'string' | 'number' | 'boolean';
  description: string;
  /** false for values the platform manages and the console should not edit. */
  editable: boolean;
}

/**
 * Canonical default system settings, grouped for the console. Seeded per tenant
 * the first time settings are listed; operators can override the editable ones.
 * Derived from the System Data Model (Ch.10) and the retention/security specs.
 */
export const DEFAULT_SETTINGS: SettingDefault[] = [
  // Platform
  {
    key: 'platform.name',
    group: 'Platform',
    value: 'JKANNEL',
    type: 'string',
    description: 'Display name shown across the console.',
    editable: true,
  },
  {
    key: 'platform.default_timezone',
    group: 'Platform',
    value: 'UTC',
    type: 'string',
    description: 'Default timezone for timestamps and scheduled jobs.',
    editable: true,
  },
  {
    key: 'platform.default_language',
    group: 'Platform',
    value: 'en',
    type: 'string',
    description: 'Default interface language.',
    editable: true,
  },
  // API
  {
    key: 'api.default_page_size',
    group: 'API',
    value: 50,
    type: 'number',
    description: 'Default number of rows returned by list endpoints.',
    editable: true,
  },
  {
    key: 'api.max_page_size',
    group: 'API',
    value: 1000,
    type: 'number',
    description: 'Maximum rows a client may request per page.',
    editable: true,
  },
  {
    key: 'api.rate_limit_per_min',
    group: 'API',
    value: 600,
    type: 'number',
    description: 'Default per-client request rate limit per minute.',
    editable: true,
  },
  // Security
  {
    key: 'security.access_token_ttl_seconds',
    group: 'Security',
    value: 900,
    type: 'number',
    description: 'Access token lifetime in seconds.',
    editable: true,
  },
  {
    key: 'security.password_min_length',
    group: 'Security',
    value: 12,
    type: 'number',
    description: 'Minimum password length for new/updated passwords.',
    editable: true,
  },
  {
    key: 'security.failed_login_lockout_threshold',
    group: 'Security',
    value: 5,
    type: 'number',
    description: 'Failed attempts before an account is locked.',
    editable: true,
  },
  {
    key: 'security.lockout_minutes',
    group: 'Security',
    value: 15,
    type: 'number',
    description: 'Lockout duration in minutes after threshold is reached.',
    editable: true,
  },
  {
    key: 'security.require_mfa',
    group: 'Security',
    value: false,
    type: 'boolean',
    description: 'Require multi-factor authentication (roadmap).',
    editable: false,
  },
  // Retention (days; audit/reports are permanent)
  {
    key: 'retention.messages_days',
    group: 'Retention',
    value: 180,
    type: 'number',
    description: 'Days to retain message records before archival.',
    editable: true,
  },
  {
    key: 'retention.message_events_days',
    group: 'Retention',
    value: 365,
    type: 'number',
    description: 'Days to retain message status/event history.',
    editable: true,
  },
  {
    key: 'retention.metrics_days',
    group: 'Retention',
    value: 365,
    type: 'number',
    description: 'Days to retain aggregated metrics.',
    editable: true,
  },
  {
    key: 'retention.audit_policy',
    group: 'Retention',
    value: 'permanent',
    type: 'string',
    description: 'Audit log is immutable and never auto-deleted.',
    editable: false,
  },
  {
    key: 'retention.sqlbox_days',
    group: 'Retention',
    value: 90,
    type: 'number',
    description: 'Default SQLBox message retention window (days).',
    editable: true,
  },
  // Backup / DR
  {
    key: 'backup.rto_minutes',
    group: 'Backup & DR',
    value: 5,
    type: 'number',
    description: 'Recovery Time Objective target (minutes).',
    editable: true,
  },
  {
    key: 'backup.rpo_minutes',
    group: 'Backup & DR',
    value: 1,
    type: 'number',
    description: 'Recovery Point Objective target (minutes).',
    editable: true,
  },
  {
    key: 'backup.encryption',
    group: 'Backup & DR',
    value: 'AES-256',
    type: 'string',
    description: 'Encryption applied to backup archives.',
    editable: false,
  },
  // Notifications
  {
    key: 'notifications.report_channel_categories',
    group: 'Notifications',
    value: 'in-app,email,webhook',
    type: 'string',
    description: 'Enabled delivery channels for scheduled reports.',
    editable: true,
  },
  {
    key: 'notifications.smtp_configured',
    group: 'Notifications',
    value: false,
    type: 'boolean',
    description: 'Whether an SMTP server is configured for email delivery.',
    editable: false,
  },
  // Runtime
  {
    key: 'runtime.container_restart_policy',
    group: 'Runtime',
    value: 'unless-stopped',
    type: 'string',
    description: 'Default Docker restart policy for services.',
    editable: false,
  },
  {
    key: 'ai.operations_enabled',
    group: 'AI Operations',
    value: false,
    type: 'boolean',
    description: 'Whether AI Operations (Copilot/assistance) is enabled for this deployment.',
    editable: false,
  },
];
