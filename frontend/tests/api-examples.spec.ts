import { describe, expect, it } from 'vitest';
import {
  buildExample,
  credentialFor,
  errorExamples,
  examplePath,
  exampleQuery,
  type ExampleEndpoint,
} from '../src/utils/api-examples';

/**
 * These examples are the part of the API reference a reader is most likely to
 * COPY, so the tests are about honesty as much as formatting. Two properties
 * matter more than the rest:
 *
 *   1. The snippet must send the credential the route actually accepts. A
 *      /gateway route authenticated by API key is reflected in the document
 *      WITHOUT a bearer badge, and an example that trusted that flag would show
 *      a bearer token on a route that rejects one.
 *   2. The failure list must not describe failures the operation cannot
 *      produce. A 404 on a route with no identifier teaches a client to handle
 *      something that will never arrive, and hides the ones that will.
 */
const base = (overrides: Partial<ExampleEndpoint> = {}): ExampleEndpoint => ({
  method: 'get',
  path: '/messages',
  serverUrl: '/api/v1',
  secured: true,
  permissions: ['messages.view'],
  parameters: [],
  hasRequestBody: false,
  responseSchemaNames: [],
  ...overrides,
});

describe('example URL construction', () => {
  it('substitutes both Nest and OpenAPI path placeholders', () => {
    expect(examplePath(base({ path: '/smsc/:id/binds' }))).toBe(
      '/smsc/9b1f0f2a-4c7e-4a3d-9f61-2c0a4b8e5d17/binds',
    );
    expect(examplePath(base({ path: '/smsc/{smscId}' }))).toBe('/smsc/mtn-ug-1');
  });

  it('includes required query parameters and the paging pair, nothing else', () => {
    const query = exampleQuery(
      base({
        parameters: [
          { name: 'from', in: 'query', required: true },
          { name: 'limit', in: 'query', required: false },
          { name: 'offset', in: 'query', required: false },
          // Optional and not paging: including it would imply it is expected.
          { name: 'search', in: 'query', required: false },
        ],
      }),
    );
    expect(query).toContain('from=');
    expect(query).toContain('limit=50');
    expect(query).toContain('offset=0');
    expect(query).not.toContain('search=');
  });

  it('emits no query string when there is nothing to send', () => {
    expect(exampleQuery(base())).toBe('');
  });
});

describe('credential selection', () => {
  it('sends an API key on gateway routes even though the document shows no bearer', () => {
    // This is the exact shape the generator produces for a key-guarded route:
    // permissions present, `secured` false, because it detects only the bearer
    // guard by name.
    const gateway = base({
      method: 'post',
      path: '/gateway/messages',
      secured: false,
      permissions: ['sms.send'],
      hasRequestBody: true,
    });
    expect(credentialFor(gateway)).toBe('apikey');
    const example = buildExample(gateway);
    expect(example.snippets.curl).toContain('X-API-Key');
    expect(example.snippets.curl).not.toContain('Bearer');
  });

  it('sends a bearer token on a secured console route', () => {
    const example = buildExample(base());
    expect(example.snippets.curl).toContain('Authorization: Bearer');
    expect(example.snippets.curl).not.toContain('X-API-Key');
  });

  it('sends no credential when none is reflected', () => {
    const example = buildExample(base({ secured: false, permissions: [] }));
    expect(example.snippets.curl).not.toContain('Authorization');
    expect(example.snippets.curl).not.toContain('X-API-Key');
  });
});

describe('request bodies', () => {
  it('uses the curated body for an endpoint read from its controller', () => {
    const example = buildExample(
      base({ method: 'post', path: '/gateway/messages', hasRequestBody: true }),
    );
    expect(example.bodyIsPlaceholder).toBe(false);
    expect(example.snippets.curl).toContain('"receiver": "+256700000000"');
  });

  it('marks an unreflected body as a placeholder rather than inventing fields', () => {
    const example = buildExample(
      base({ method: 'post', path: '/campaigns/:id/launch', hasRequestBody: true }),
    );
    expect(example.bodyIsPlaceholder).toBe(true);
    expect(example.snippets.curl).toContain('not reflected');
  });

  it('shapes a body from the schema when the generator did reflect one', () => {
    const example = buildExample(
      base({
        method: 'post',
        path: '/thing',
        hasRequestBody: true,
        requestBodySchema: {
          type: 'object',
          properties: { name: { type: 'string' }, retries: { type: 'integer' } },
        },
      }),
    );
    expect(example.bodyIsPlaceholder).toBe(false);
    expect(example.snippets.curl).toContain('"retries": 10');
  });

  it('sends no body on a GET', () => {
    const example = buildExample(base());
    expect(example.snippets.curl).not.toContain('-d ');
    expect(example.snippets.node).not.toContain('body:');
  });
});

describe('success envelope', () => {
  it('always wraps the payload in the platform envelope', () => {
    const parsed = JSON.parse(buildExample(base()).successBody);
    expect(parsed).toMatchObject({ success: true, api_version: 'v1' });
    expect(parsed).toHaveProperty('request_id');
    expect(parsed).toHaveProperty('data');
  });

  it('shows the cursor page shape, not the offset one, for a cursor endpoint', () => {
    // These two contracts differ in a way that breaks clients silently: a
    // CursorPage has no `total`, so code written against GridPage reads
    // undefined and paginates wrongly.
    const cursor = JSON.parse(
      buildExample(base({ responseSchemaNames: ['CursorPage'] })).successBody,
    );
    expect(cursor.data).toHaveProperty('nextCursor');
    expect(cursor.data).not.toHaveProperty('total');

    const grid = JSON.parse(buildExample(base({ responseSchemaNames: ['GridPage'] })).successBody);
    expect(grid.data).toHaveProperty('total');
    expect(grid.data).not.toHaveProperty('nextCursor');
  });

  it('reports 201 for a create and 200 otherwise', () => {
    expect(buildExample(base({ method: 'post' })).successStatus).toBe(201);
    expect(buildExample(base({ method: 'get' })).successStatus).toBe(200);
  });
});

describe('failure modes', () => {
  const statuses = (endpoint: ExampleEndpoint) =>
    errorExamples(endpoint).map((failure) => failure.status);

  it('omits 404 when the path carries no identifier', () => {
    expect(statuses(base({ path: '/messages' }))).not.toContain(404);
    expect(statuses(base({ path: '/messages/:id' }))).toContain(404);
  });

  it('omits 403 when the operation requires no permission', () => {
    expect(statuses(base({ permissions: [] }))).not.toContain(403);
    expect(statuses(base({ permissions: ['messages.view'] }))).toContain(403);
  });

  it('omits 401 when no credential is reflected', () => {
    expect(statuses(base({ secured: false, permissions: [] }))).not.toContain(401);
  });

  it('omits 400 on a read that accepts nothing that can be malformed', () => {
    expect(
      statuses(base({ path: '/health', parameters: [], hasRequestBody: false })),
    ).not.toContain(400);
  });

  it('lists 400 when a required path parameter can be malformed', () => {
    // A non-UUID in a `:id` segment is rejected before the handler runs, so this
    // is a real failure the caller has to handle — not a status added for the
    // sake of completeness.
    const statusList = statuses(
      base({ path: '/messages/:id', parameters: [{ name: 'id', in: 'path', required: true }] }),
    );
    expect(statusList).toContain(400);
  });

  it('always lists 500, because any operation can fault', () => {
    expect(statuses(base({ secured: false, permissions: [] }))).toContain(500);
  });

  it('does not leak regex state between calls', () => {
    // The path placeholder matcher is a global regex. Used with .test() and not
    // reset, alternate calls return false and 404 disappears from every other
    // endpoint — a bug that only shows up when the page renders more than one.
    const withId = base({ path: '/messages/:id' });
    expect(statuses(withId)).toContain(404);
    expect(statuses(withId)).toContain(404);
    expect(statuses(withId)).toContain(404);
  });

  it('explains a 401 on a key route in terms of the key, not the token', () => {
    const failures = errorExamples(
      base({ path: '/gateway/messages', method: 'post', secured: false, hasRequestBody: true }),
    );
    const unauthorized = failures.find((failure) => failure.status === 401);
    expect(unauthorized?.when).toContain('API key');
  });

  it('emits a valid error envelope for every listed failure', () => {
    for (const failure of errorExamples(base({ path: '/messages/:id', method: 'delete' }))) {
      const parsed = JSON.parse(failure.body);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe(`HTTP_${failure.status}`);
      expect(parsed.error_category).toBe(failure.status >= 500 ? 'Internal' : 'Request');
    }
  });
});

describe('snippet syntax', () => {
  const endpoint = base({ method: 'post', path: '/gateway/messages', hasRequestBody: true });

  it('produces a cURL command whose only unescaped line break is the last', () => {
    const lines = buildExample(endpoint).snippets.curl.split('\n');
    expect(lines[lines.length - 1].endsWith('\\')).toBe(false);
  });

  it('translates JSON literals into Python literals', () => {
    const python = buildExample(
      base({
        method: 'post',
        path: '/thing',
        hasRequestBody: true,
        requestBodySchema: { type: 'object', properties: { enabled: { type: 'boolean' } } },
      }),
    ).snippets.python;
    expect(python).toContain('True');
    expect(python).not.toContain('true');
  });

  it('checks the envelope before using data in every language', () => {
    const { node, python } = buildExample(endpoint).snippets;
    expect(node).toContain('envelope.success');
    expect(python).toContain('envelope["success"]');
  });
});
