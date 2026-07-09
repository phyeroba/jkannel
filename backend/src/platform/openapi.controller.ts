import { Controller, Get, Res } from '@nestjs/common';

interface RawResponse {
  setHeader(name: string, value: string): void;
  send(body: unknown): void;
}

@Controller()
export class OpenApiController {
  @Get('openapi.json')
  document(@Res() response: RawResponse): void {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.send({
      openapi: '3.1.0',
      info: {
        title: 'JKANNEL API',
        version: '0.1.0',
        description:
          'Operational API for JKANNEL console, Kamex/Kannel adapter management, SQLBox visibility, configuration, monitoring and platform jobs.',
      },
      servers: [{ url: '/api/v1' }],
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
        headers: {
          IdempotencyKey: {
            description: 'Prevents duplicate execution of mutating retryable requests.',
            schema: { type: 'string', minLength: 8, maxLength: 128 },
          },
        },
        parameters: {
          GridSearch: {
            name: 'search',
            in: 'query',
            description: 'Free-text search over the resource-specific whitelisted columns.',
            schema: { type: 'string' },
          },
          GridSort: {
            name: 'sort',
            in: 'query',
            description:
              'Comma-separated whitelisted sort fields; prefix with "-" for descending (e.g. "-createdAt,name").',
            schema: { type: 'string' },
          },
          GridLimit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
          GridOffset: { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
        },
        schemas: {
          Job: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              type: { type: 'string' },
              status: { enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
              progress: { type: 'integer', minimum: 0, maximum: 100 },
              input: { type: 'object' },
              result: { type: 'object' },
              error: { type: ['string', 'null'] },
              created_at: { type: 'string', format: 'date-time' },
            },
          },
          ErrorEnvelope: {
            type: 'object',
            properties: {
              success: { const: false },
              error_code: { type: 'string' },
              message: { type: 'string' },
            },
          },
          GridPage: {
            type: 'object',
            description:
              'Standard grid page. Every list endpoint also accepts filter.<field>=<value> query parameters against a whitelisted field set.',
            properties: {
              items: { type: 'array', items: { type: 'object' } },
              total: { type: 'integer' },
              limit: { type: 'integer' },
              offset: { type: 'integer' },
            },
          },
        },
      },
      paths: {
        '/health': {
          get: {
            summary: 'Backend health check',
            security: [],
            responses: { '200': { description: 'Backend health state' } },
          },
        },
        '/metrics': {
          get: {
            summary: 'Prometheus metrics exposition',
            security: [],
            responses: { '200': { description: 'Prometheus text metrics' } },
          },
        },
        '/jobs': {
          get: {
            summary: 'List long-running platform jobs',
            security: [{ bearerAuth: [] }],
            parameters: [
              { name: 'status', in: 'query', schema: { type: 'string' } },
              { name: 'type', in: 'query', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'Job list' } },
          },
          post: {
            summary: 'Create a long-running platform job placeholder',
            security: [{ bearerAuth: [] }],
            parameters: [
              {
                name: 'Idempotency-Key',
                in: 'header',
                schema: { type: 'string', minLength: 8, maxLength: 128 },
              },
            ],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['type'],
                    properties: { type: { type: 'string' }, input: { type: 'object' } },
                  },
                },
              },
            },
            responses: { '200': { description: 'Queued job' } },
          },
        },
        '/jobs/{id}': {
          get: {
            summary: 'Get platform job status',
            security: [{ bearerAuth: [] }],
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'string', format: 'uuid' },
              },
            ],
            responses: {
              '200': { description: 'Job status' },
              '404': { description: 'Job not found' },
            },
          },
        },
        '/jobs/{id}/cancel': {
          post: {
            summary: 'Cancel a queued or running platform job',
            security: [{ bearerAuth: [] }],
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'string', format: 'uuid' },
              },
              {
                name: 'Idempotency-Key',
                in: 'header',
                schema: { type: 'string', minLength: 8, maxLength: 128 },
              },
            ],
            responses: { '200': { description: 'Cancelled job' } },
          },
        },
        '/smscs/{id}/actions/{operation}': {
          post: {
            summary: 'Execute an idempotent SMSC operation through the engine adapter',
            parameters: [
              {
                name: 'Idempotency-Key',
                in: 'header',
                required: true,
                schema: { type: 'string', minLength: 8, maxLength: 128 },
              },
            ],
            responses: { '200': { description: 'Operation record' } },
          },
        },
        '/configurations/generate': {
          post: {
            summary: 'Generate and natively validate engine configuration',
            responses: {
              '200': { description: 'Rendered configuration and native validation result' },
            },
          },
        },
        ...Object.fromEntries(
          [
            ['/smscs', 'SMSC definitions'],
            ['/routes', 'Routing rules'],
            ['/alerts', 'Alert instances'],
            ['/users', 'Users'],
            ['/configurations', 'Configuration versions'],
            ['/audit-events', 'Audit events (who did what, when)'],
            ['/reports/volume', 'Daily/weekly message-volume report snapshots'],
            ['/notifications', 'Current user notifications'],
          ].flatMap(([path, summary]) => [
            [
              path,
              {
                get: {
                  summary: `List ${summary} (grid: search/sort/filter/pagination)`,
                  parameters: [
                    { $ref: '#/components/parameters/GridSearch' },
                    { $ref: '#/components/parameters/GridSort' },
                    { $ref: '#/components/parameters/GridLimit' },
                    { $ref: '#/components/parameters/GridOffset' },
                  ],
                  responses: {
                    '200': {
                      description: 'Grid page',
                      content: {
                        'application/json': {
                          schema: { $ref: '#/components/schemas/GridPage' },
                        },
                      },
                    },
                  },
                },
              },
            ],
            ...(path === '/notifications'
              ? []
              : [
                  [
                    `${path}/export.csv`,
                    {
                      get: {
                        summary: `Export ${summary} as CSV (bounded, audit-logged)`,
                        responses: { '200': { description: 'CSV attachment' } },
                      },
                    },
                  ],
                  [
                    `${path}/export.pdf`,
                    {
                      get: {
                        summary: `Export ${summary} as PDF (bounded, audit-logged)`,
                        responses: { '200': { description: 'PDF attachment' } },
                      },
                    },
                  ],
                ]),
          ]),
        ),
        '/messages/export.pdf': {
          get: {
            summary: 'Export tenant-scoped SQLBox messages as PDF (bounded, audit-logged)',
            responses: { '200': { description: 'PDF attachment' } },
          },
        },
        '/notifications/unread-count': {
          get: {
            summary: 'Unread notification count for the current user',
            responses: { '200': { description: 'Unread count' } },
          },
        },
        '/notifications/{id}/read': {
          post: {
            summary: 'Mark one notification as read',
            responses: { '200': { description: 'Notification read state' } },
          },
        },
        '/notifications/read-all': {
          post: {
            summary: 'Mark all notifications as read',
            responses: { '200': { description: 'Number marked read' } },
          },
        },
        '/reports/volume/run': {
          post: {
            summary: 'Force scheduled volume-report generation now (system.manage)',
            responses: { '200': { description: 'Run summaries per tenant and period' } },
          },
        },
        '/ai/copilot': {
          post: {
            summary: 'Ask the read-only Ops Copilot (opt-in, permission-scoped, audit-logged)',
            description:
              'Requires monitoring.view and the x-jkannel-ai-opt-in: true header. Answers only from ' +
              'read-only tools the caller is permitted to use; never executes changes or returns PII.',
            parameters: [
              {
                name: 'x-jkannel-ai-opt-in',
                in: 'header',
                required: true,
                schema: { type: 'string', enum: ['true'] },
              },
            ],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['question'],
                    properties: { question: { type: 'string', maxLength: 1000 } },
                  },
                },
              },
            },
            responses: { '200': { description: 'Answer with citations and tools run' } },
          },
        },
        '/ai/copilot/tools': {
          get: {
            summary: 'List the read-only Copilot tools the caller may use',
            responses: { '200': { description: 'Permitted tool list' } },
          },
        },
        '/auth/password-reset/request': {
          post: {
            summary: 'Request a password reset token (no user enumeration)',
            security: [],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['tenant', 'username'],
                    properties: { tenant: { type: 'string' }, username: { type: 'string' } },
                  },
                },
              },
            },
            responses: {
              '200': {
                description:
                  'Always { requested: true }; includes devToken outside production so the flow is testable without an email transport.',
              },
            },
          },
        },
        '/auth/password-reset/confirm': {
          post: {
            summary: 'Complete a password reset with a valid token',
            security: [],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['tenant', 'token', 'newPassword'],
                    properties: {
                      tenant: { type: 'string' },
                      token: { type: 'string' },
                      newPassword: { type: 'string', minLength: 12 },
                    },
                  },
                },
              },
            },
            responses: {
              '200': { description: 'Password reset ({ reset: true })' },
              '400': { description: 'Invalid, expired, or already-used token, or weak password' },
            },
          },
        },
        '/auth/invitations/accept': {
          post: {
            summary: 'Accept a user invitation and provision the account',
            security: [],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['token', 'username', 'password'],
                    properties: {
                      token: { type: 'string' },
                      username: { type: 'string' },
                      password: { type: 'string', minLength: 12 },
                    },
                  },
                },
              },
            },
            responses: {
              '200': { description: 'Invitation accepted ({ accepted: true })' },
              '400': { description: 'Invalid, expired, or already-used invitation' },
              '409': { description: 'Username already taken in the tenant' },
            },
          },
        },
        '/sessions': {
          get: {
            summary: "List the tenant's auth sessions (requires users.sessions)",
            security: [{ bearerAuth: [] }],
            parameters: [
              { name: 'userId', in: 'query', schema: { type: 'string', format: 'uuid' } },
              { name: 'active', in: 'query', schema: { type: 'boolean' } },
              { $ref: '#/components/parameters/GridLimit' },
              { $ref: '#/components/parameters/GridOffset' },
            ],
            responses: {
              '200': {
                description: 'Grid page of sessions',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/GridPage' } },
                },
              },
            },
          },
        },
        '/sessions/{id}/revoke': {
          post: {
            summary: 'Revoke an auth session (requires users.sessions)',
            security: [{ bearerAuth: [] }],
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'string', format: 'uuid' },
              },
            ],
            responses: {
              '200': { description: 'Revoked session' },
              '404': { description: 'Session not found' },
            },
          },
        },
      },
    });
  }
}
