/**
 * Worked examples for every operation in the API reference.
 *
 * WHY THIS IS GENERATED AND NOT WRITTEN OUT BY HAND
 * ---------------------------------------------------------------------------
 * The reference itself is derived at request time from the routes actually
 * registered in the running backend, so it cannot drift. A hand-maintained set
 * of examples beside it would drift immediately — a renamed path or a removed
 * endpoint would leave a confidently-wrong snippet behind, and a wrong example
 * is worse than no example because a reader will copy it.
 *
 * So the snippets are built from the same OpenAPI operation the page is already
 * rendering: the method, the reflected parameters, the declared security and
 * the response schema. Rename a route and the example renames with it.
 *
 * WHERE HONESTY BEATS COMPLETENESS
 * ---------------------------------------------------------------------------
 * The generator openly cannot reflect request-body fields — bodies in this
 * codebase are validated imperatively rather than through DTO classes, so there
 * is no class for it to read. That leaves two options for a body example:
 * invent plausible fields, or say the field list is not reflected. Inventing
 * them would quietly turn "we don't know" into "here is the contract", which is
 * exactly the failure mode the surrounding page exists to prevent.
 *
 * The middle path taken here: a small CURATED table of bodies for the handful
 * of endpoints whose contract was read directly out of the controller (and is
 * cited in the comment above each entry), and an explicit placeholder for
 * everything else. A reader can always tell which they are looking at.
 *
 * The envelopes are exact. They are transcribed from
 * `backend/src/platform/response-envelope.interceptor.ts` and
 * `backend/src/platform/http-exception.filter.ts`, which wrap every response
 * this API emits, so the shape around `data` is never a guess.
 */

export type ExampleLanguage = 'curl' | 'php' | 'python' | 'node' | 'java' | 'go';

export interface ExampleSchema {
  type?: string | string[];
  properties?: Record<string, ExampleSchema>;
  items?: ExampleSchema;
  $ref?: string;
}

export interface ExampleParameter {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: ExampleSchema;
}

/** The subset of an endpoint the examples need. Mirrors the reference's row. */
export interface ExampleEndpoint {
  method: string;
  path: string;
  /** Server base path, e.g. `/api/v1`. */
  serverUrl: string;
  secured: boolean;
  permissions: string[];
  parameters: ExampleParameter[];
  hasRequestBody: boolean;
  requestBodySchema?: ExampleSchema;
  responseSchemaNames: string[];
}

export interface ErrorExample {
  status: number;
  title: string;
  /** The condition that produces it — the part a reader actually needs. */
  when: string;
  body: string;
}

export interface EndpointExample {
  /** Fully-substituted URL including the example query string. */
  url: string;
  /** True when the body shown is a placeholder rather than a real contract. */
  bodyIsPlaceholder: boolean;
  snippets: Record<ExampleLanguage, string>;
  successStatus: number;
  successBody: string;
  errors: ErrorExample[];
}

const SAMPLE_UUID = '9b1f0f2a-4c7e-4a3d-9f61-2c0a4b8e5d17';
const SAMPLE_REQUEST_ID = 'req_01J8Z6H2QF7K4N';
const SAMPLE_TIME = '2026-08-19T09:14:02.318Z';

/** Path placeholders in either Nest (`:id`) or OpenAPI (`{id}`) form. */
const PATH_PARAM = /:([A-Za-z0-9_]+)|\{([A-Za-z0-9_]+)\}/g;

// --- Sample values ---------------------------------------------------------
// Named parameters get a value that looks like the real thing, because a reader
// scanning an example learns the format from it. Anything unrecognised falls
// back to its declared type rather than to a made-up name-specific value.
const NAMED_SAMPLES: Record<string, string> = {
  id: SAMPLE_UUID,
  tenantId: SAMPLE_UUID,
  userId: SAMPLE_UUID,
  customerId: SAMPLE_UUID,
  messageId: SAMPLE_UUID,
  smscId: 'mtn-ug-1',
  engineId: 'mtn-ug-1',
  search: 'MTN',
  sort: '-createdAt',
  limit: '50',
  offset: '0',
  cursor: 'eyJpZCI6IjEyMzQifQ',
  fields: 'id,status,createdAt',
  from: '2026-08-12T00:00:00Z',
  to: '2026-08-19T00:00:00Z',
  status: 'delivered',
  range: '24h',
};

function sampleFor(name: string, schema?: ExampleSchema): string {
  const named = NAMED_SAMPLES[name];
  if (named !== undefined) return named;
  const type = Array.isArray(schema?.type) ? schema?.type[0] : schema?.type;
  if (type === 'integer' || type === 'number') return '10';
  if (type === 'boolean') return 'true';
  if (name.toLowerCase().endsWith('id')) return SAMPLE_UUID;
  return 'example';
}

/** Substitutes `:id` / `{id}` with a sample, so the URL is one you can paste. */
export function examplePath(endpoint: ExampleEndpoint): string {
  return endpoint.path.replace(PATH_PARAM, (_match, colon?: string, braced?: string) => {
    const name = colon ?? braced ?? 'id';
    const declared = endpoint.parameters.find((param) => param.name === name);
    return sampleFor(name, declared?.schema);
  });
}

/**
 * Query string for the example.
 *
 * Required parameters are always included — omitting one would make the example
 * fail. Optional ones are not, with a deliberate exception for the grid paging
 * pair: a list endpoint called with no paging is the single most common way to
 * pull far more data than intended, so the example demonstrates the bounded
 * form rather than the unbounded one.
 */
export function exampleQuery(endpoint: ExampleEndpoint): string {
  const pairs: string[] = [];
  const seen = new Set<string>();
  for (const param of endpoint.parameters) {
    if (param.in !== 'query' || !param.name || seen.has(param.name)) continue;
    const isPaging = param.name === 'limit' || param.name === 'offset';
    if (!param.required && !isPaging) continue;
    seen.add(param.name);
    pairs.push(
      `${encodeURIComponent(param.name)}=${encodeURIComponent(sampleFor(param.name, param.schema))}`,
    );
  }
  return pairs.length ? `?${pairs.join('&')}` : '';
}

/** Header parameters the operation reflects, beyond auth and content type. */
function extraHeaders(endpoint: ExampleEndpoint): { name: string; value: string }[] {
  return endpoint.parameters
    .filter((param) => param.in === 'header' && param.name)
    .map((param) => ({
      name: param.name as string,
      value:
        param.name?.toLowerCase() === 'idempotency-key'
          ? 'a7f3c1e0-batch-2026-08-19'
          : sampleFor(param.name as string, param.schema),
    }));
}

// --- Request bodies --------------------------------------------------------
/**
 * Bodies read directly out of the controller signature. Each key is
 * `METHOD /path` exactly as the route table publishes it, and each entry cites
 * the file it was read from so the next person can re-check it rather than
 * trusting it.
 */
const CURATED_BODIES: Record<string, string> = {
  // backend/src/security/auth.controller.ts — login(@Body() { tenant, username,
  // password, totp?, recoveryCode? })
  'POST /auth/login': JSON.stringify(
    { tenant: 'acme', username: 'operator', password: '••••••••', totp: '493021' },
    null,
    2,
  ),
  // Same file — refresh(@Body() { refreshToken })
  'POST /auth/refresh': JSON.stringify({ refreshToken: 'eyJhbGciOiJIUzI1NiIs…' }, null, 2),
  'POST /auth/logout': JSON.stringify({ refreshToken: 'eyJhbGciOiJIUzI1NiIs…' }, null, 2),
  // backend/src/api-gateway/gateway-messaging.controller.ts — submit(). `sender`,
  // `receiver` and `text` are required; the rest are optional and shown because
  // they are the ones with non-obvious semantics.
  'POST /gateway/messages': JSON.stringify(
    {
      sender: 'ACME',
      receiver: '+256700000000',
      text: 'Your one-time code is 4930. It expires in 5 minutes.',
      dlrUrl: 'https://hooks.acme.example/dlr',
      dlrMask: 31,
      foreignId: 'order-88213',
      priority: 1,
    },
    null,
    2,
  ),
};

const BODY_PLACEHOLDER = '{\n  "…": "see the caveat above — fields are not reflected"\n}';

export function exampleBody(endpoint: ExampleEndpoint): { body: string; placeholder: boolean } {
  const key = `${endpoint.method.toUpperCase()} ${endpoint.path}`;
  const curated = CURATED_BODIES[key];
  if (curated) return { body: curated, placeholder: false };
  const properties = endpoint.requestBodySchema?.properties;
  if (properties && Object.keys(properties).length) {
    const shaped: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(properties)) {
      const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
      shaped[name] =
        type === 'integer' || type === 'number'
          ? Number(sampleFor(name, schema))
          : type === 'boolean'
            ? true
            : sampleFor(name, schema);
    }
    return { body: JSON.stringify(shaped, null, 2), placeholder: false };
  }
  return { body: BODY_PLACEHOLDER, placeholder: true };
}

// --- Auth ------------------------------------------------------------------
/**
 * Which credential the example should send.
 *
 * `/gateway` routes are API-key authenticated. The generator cannot see that —
 * it detects the bearer guard by name only — so an example that trusted
 * `secured` alone would show a bearer token on a route where a bearer token is
 * parsed as a JWT and rejected. The path prefix is the reliable signal, and it
 * is the same rule the surrounding page already states in prose.
 */
export function credentialFor(endpoint: ExampleEndpoint): 'bearer' | 'apikey' | 'none' {
  if (endpoint.path.startsWith('/gateway')) return 'apikey';
  if (endpoint.secured) return 'bearer';
  return 'none';
}

function authHeader(
  kind: ReturnType<typeof credentialFor>,
): { name: string; value: string } | null {
  if (kind === 'bearer') return { name: 'Authorization', value: 'Bearer $JKANNEL_ACCESS_TOKEN' };
  if (kind === 'apikey') return { name: 'X-API-Key', value: '$JKANNEL_API_KEY' };
  return null;
}

// --- Snippets --------------------------------------------------------------
function curlSnippet(endpoint: ExampleEndpoint, url: string, body: string | null): string {
  const lines = [`curl -X ${endpoint.method.toUpperCase()} "${url}" \\`];
  const auth = authHeader(credentialFor(endpoint));
  if (auth) lines.push(`  -H "${auth.name}: ${auth.value}" \\`);
  for (const header of extraHeaders(endpoint))
    lines.push(`  -H "${header.name}: ${header.value}" \\`);
  if (body) {
    lines.push('  -H "Content-Type: application/json" \\');
    // Single-quoted so the JSON's own double quotes survive the shell.
    lines.push(`  -d '${body.replace(/\n/g, '\n  ')}'`);
  }
  // Only the last line may lack a trailing backslash.
  return lines.join('\n').replace(/ \\\n?$/, '');
}

function nodeSnippet(endpoint: ExampleEndpoint, url: string, body: string | null): string {
  const auth = authHeader(credentialFor(endpoint));
  return [
    `const response = await fetch('${url}', {`,
    `  method: '${endpoint.method.toUpperCase()}',`,
    '  headers: {',
    ...(auth
      ? [
          auth.name === 'Authorization'
            ? '    Authorization: `Bearer ${process.env.JKANNEL_ACCESS_TOKEN}`,'
            : "    'X-API-Key': process.env.JKANNEL_API_KEY,",
        ]
      : []),
    ...extraHeaders(endpoint).map((header) => `    '${header.name}': '${header.value}',`),
    ...(body ? ["    'Content-Type': 'application/json',"] : []),
    '  },',
    ...(body ? [`  body: JSON.stringify(${body.replace(/\n/g, '\n  ')}),`] : []),
    '});',
    '',
    'const envelope = await response.json();',
    'if (!envelope.success) {',
    '  // Every failure carries request_id. Quote it in a support ticket —',
    '  // it is the key the platform logs are indexed by.',
    '  throw new Error(`${envelope.error_code}: ${envelope.message} (${envelope.request_id})`);',
    '}',
    'console.log(envelope.data);',
  ].join('\n');
}

function pythonSnippet(endpoint: ExampleEndpoint, url: string, body: string | null): string {
  const auth = authHeader(credentialFor(endpoint));
  const headerLines: string[] = [];
  if (auth?.name === 'Authorization')
    headerLines.push('    "Authorization": f"Bearer {os.environ[\'JKANNEL_ACCESS_TOKEN\']}",');
  else if (auth?.name === 'X-API-Key')
    headerLines.push('    "X-API-Key": os.environ["JKANNEL_API_KEY"],');
  for (const header of extraHeaders(endpoint))
    headerLines.push(`    "${header.name}": "${header.value}",`);

  return [
    'import os',
    'import requests',
    '',
    `response = requests.${endpoint.method.toLowerCase()}(`,
    `    "${url}",`,
    ...(headerLines.length
      ? ['    headers={', ...headerLines.map((l) => `    ${l}`), '    },']
      : []),
    ...(body
      ? [
          `    json=${body
            .replace(/\n/g, '\n    ')
            .replace(/\btrue\b/g, 'True')
            .replace(/\bfalse\b/g, 'False')
            .replace(/\bnull\b/g, 'None')},`,
        ]
      : []),
    '    timeout=15,',
    ')',
    '',
    'envelope = response.json()',
    'if not envelope["success"]:',
    '    # request_id is the key the platform logs are indexed by.',
    '    raise RuntimeError(f\'{envelope["error_code"]}: {envelope["message"]} ({envelope["request_id"]})\')',
    '',
    'print(envelope["data"])',
  ].join('\n');
}

/**
 * PHP with cURL rather than Guzzle: it runs on a stock PHP install with no
 * Composer step, which is what a reader pasting an example into an existing
 * codebase actually needs.
 */
function phpSnippet(endpoint: ExampleEndpoint, url: string, body: string | null): string {
  const auth = authHeader(credentialFor(endpoint));
  const headers: string[] = [];
  if (auth?.name === 'Authorization')
    headers.push(`    'Authorization: Bearer ' . getenv('JKANNEL_ACCESS_TOKEN'),`);
  else if (auth?.name === 'X-API-Key')
    headers.push(`    'X-API-Key: ' . getenv('JKANNEL_API_KEY'),`);
  for (const header of extraHeaders(endpoint))
    headers.push(`    '${header.name}: ${header.value}',`);
  if (body) headers.push("    'Content-Type: application/json',");

  return [
    '<?php',
    '',
    `$ch = curl_init('${url}');`,
    'curl_setopt_array($ch, [',
    '    CURLOPT_RETURNTRANSFER => true,',
    `    CURLOPT_CUSTOMREQUEST  => '${endpoint.method.toUpperCase()}',`,
    ...(headers.length
      ? ['    CURLOPT_HTTPHEADER     => [', ...headers.map((l) => `    ${l}`), '    ],']
      : []),
    ...(body ? [`    CURLOPT_POSTFIELDS     => json_encode(${phpArray(body)}),`] : []),
    '    CURLOPT_TIMEOUT        => 15,',
    ']);',
    '',
    '$response = curl_exec($ch);',
    'curl_close($ch);',
    '$envelope = json_decode($response, true);',
    '',
    "if (!$envelope['success']) {",
    '    // request_id is the key the platform logs are indexed by. Quote it in',
    '    // a support ticket rather than pasting the whole response.',
    "    throw new RuntimeException(\"{$envelope['error_code']}: {$envelope['message']} ({$envelope['request_id']})\");",
    '}',
    '',
    "print_r($envelope['data']);",
  ].join('\n');
}

/** Rewrites a JSON object literal as a PHP associative array. */
function phpArray(json: string): string {
  return json
    .replace(/^\{/, '[')
    .replace(/\}$/, ']')
    .replace(/^(\s*)"([^"]+)":/gm, "$1'$2' =>")
    .replace(/\btrue\b/g, 'true')
    .replace(/\bnull\b/g, 'null')
    .replace(/\n/g, '\n    ');
}

/** Java 11+ java.net.http — in the JDK, so no dependency to justify. */
function javaSnippet(endpoint: ExampleEndpoint, url: string, body: string | null): string {
  const auth = authHeader(credentialFor(endpoint));
  const headerCalls: string[] = [];
  if (auth?.name === 'Authorization')
    headerCalls.push(
      '    .header("Authorization", "Bearer " + System.getenv("JKANNEL_ACCESS_TOKEN"))',
    );
  else if (auth?.name === 'X-API-Key')
    headerCalls.push('    .header("X-API-Key", System.getenv("JKANNEL_API_KEY"))');
  for (const header of extraHeaders(endpoint))
    headerCalls.push(`    .header("${header.name}", "${header.value}")`);
  if (body) headerCalls.push('    .header("Content-Type", "application/json")');

  const method = endpoint.method.toUpperCase();
  const publisher = body
    ? `HttpRequest.BodyPublishers.ofString(BODY)`
    : 'HttpRequest.BodyPublishers.noBody()';

  return [
    'import java.net.URI;',
    'import java.net.http.*;',
    '',
    ...(body ? [`static final String BODY = """`, body, '""";', ''] : []),
    'HttpRequest request = HttpRequest.newBuilder()',
    `    .uri(URI.create("${url}"))`,
    ...headerCalls,
    `    .method("${method}", ${publisher})`,
    '    .build();',
    '',
    'HttpResponse<String> response = HttpClient.newHttpClient()',
    '    .send(request, HttpResponse.BodyHandlers.ofString());',
    '',
    '// Check envelope.success before reading data: a 200 with success=false is',
    '// still a failure, and the body carries the request_id you need to report.',
    'System.out.println(response.body());',
  ].join('\n');
}

/** Go with the standard library only. */
function goSnippet(endpoint: ExampleEndpoint, url: string, body: string | null): string {
  const auth = authHeader(credentialFor(endpoint));
  const headerCalls: string[] = [];
  if (auth?.name === 'Authorization')
    headerCalls.push(
      'req.Header.Set("Authorization", "Bearer "+os.Getenv("JKANNEL_ACCESS_TOKEN"))',
    );
  else if (auth?.name === 'X-API-Key')
    headerCalls.push('req.Header.Set("X-API-Key", os.Getenv("JKANNEL_API_KEY"))');
  for (const header of extraHeaders(endpoint))
    headerCalls.push(`req.Header.Set("${header.name}", "${header.value}")`);
  if (body) headerCalls.push('req.Header.Set("Content-Type", "application/json")');

  return [
    'package main',
    '',
    'import (',
    '\t"bytes"',
    '\t"encoding/json"',
    '\t"fmt"',
    '\t"net/http"',
    '\t"os"',
    ')',
    '',
    'func main() {',
    ...(body
      ? [
          `\tbody := []byte(\`${body}\`)`,
          '',
          `\treq, _ := http.NewRequest("${endpoint.method.toUpperCase()}", "${url}", bytes.NewReader(body))`,
        ]
      : [`\treq, _ := http.NewRequest("${endpoint.method.toUpperCase()}", "${url}", nil)`]),
    ...headerCalls.map((line) => `\t${line}`),
    '',
    '\tres, err := http.DefaultClient.Do(req)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tdefer res.Body.Close()',
    '',
    '\tvar envelope struct {',
    '\t\tSuccess   bool            `json:"success"`',
    '\t\tRequestID string          `json:"request_id"`',
    '\t\tErrorCode string          `json:"error_code"`',
    '\t\tMessage   string          `json:"message"`',
    '\t\tData      json.RawMessage `json:"data"`',
    '\t}',
    '\tjson.NewDecoder(res.Body).Decode(&envelope)',
    '',
    '\tif !envelope.Success {',
    '\t\t// request_id is the key the platform logs are indexed by.',
    '\t\tpanic(fmt.Sprintf("%s: %s (%s)", envelope.ErrorCode, envelope.Message, envelope.RequestID))',
    '\t}',
    '\tfmt.Println(string(envelope.Data))',
    '}',
  ].join('\n');
}

// --- Envelopes -------------------------------------------------------------
/**
 * The success envelope, exactly as ResponseEnvelopeInterceptor emits it.
 *
 * `data` is filled from the declared response schema where there is one. This
 * is where the two paging contracts become visible: an endpoint that declares
 * `CursorPage` returns `{ items, nextCursor, limit }` and has no `total`, so a
 * client written against `GridPage` silently sees `undefined` and paginates
 * wrongly. Showing the right one per endpoint is the point.
 */
function dataFor(endpoint: ExampleEndpoint): unknown {
  const names = endpoint.responseSchemaNames;
  if (names.includes('CursorPage'))
    return { items: [{ id: SAMPLE_UUID }], nextCursor: 'eyJpZCI6IjEyMzQifQ', limit: 50 };
  if (names.includes('GridPage'))
    return { items: [{ id: SAMPLE_UUID }], total: 412, limit: 50, offset: 0 };
  if (endpoint.method.toLowerCase() === 'delete') return { deleted: true };
  return { id: SAMPLE_UUID };
}

function successEnvelope(endpoint: ExampleEndpoint): string {
  return JSON.stringify(
    {
      success: true,
      request_id: SAMPLE_REQUEST_ID,
      correlation_id: SAMPLE_REQUEST_ID,
      timestamp: SAMPLE_TIME,
      api_version: 'v1',
      execution_time_ms: 34,
      data: dataFor(endpoint),
      meta: {},
      links: {},
      errors: [],
      warnings: [],
    },
    null,
    2,
  );
}

function errorEnvelope(status: number, name: string, message: string): string {
  return JSON.stringify(
    {
      success: false,
      request_id: SAMPLE_REQUEST_ID,
      correlation_id: SAMPLE_REQUEST_ID,
      timestamp: SAMPLE_TIME,
      api_version: 'v1',
      error_code: `HTTP_${status}`,
      error_name: name,
      error_category: status >= 500 ? 'Internal' : 'Request',
      message,
      errors: [],
    },
    null,
    2,
  );
}

/**
 * The failures this specific operation can actually produce.
 *
 * Deliberately not a fixed list of every HTTP status. A 404 on an endpoint with
 * no path parameter, or a 403 on one that requires no permission, teaches the
 * reader to handle something that will never arrive and hides the ones that
 * will. Each entry below is gated on a property of the operation.
 */
export function errorExamples(endpoint: ExampleEndpoint): ErrorExample[] {
  const errors: ErrorExample[] = [];
  const credential = credentialFor(endpoint);
  const method = endpoint.method.toLowerCase();
  const hasPathParam = PATH_PARAM.test(endpoint.path);
  PATH_PARAM.lastIndex = 0; // the regex is global; reset or the next test lies

  if (endpoint.hasRequestBody || endpoint.parameters.some((param) => param.required)) {
    errors.push({
      status: 400,
      title: 'Bad Request',
      when: 'A required field is missing, or a value fails validation — an out-of-range limit, a malformed UUID, a non-ISO timestamp.',
      body: errorEnvelope(400, 'BAD_REQUEST', 'receiver is required'),
    });
  }
  if (credential !== 'none') {
    errors.push({
      status: 401,
      title: 'Unauthorized',
      when:
        credential === 'apikey'
          ? 'The API key is missing, revoked, expired, or the caller is outside the key’s IP allowlist. Sending the key as a bearer token also lands here — it is parsed as a JWT and rejected.'
          : 'The access token is missing, malformed or expired. Exchange the refresh token at POST /auth/refresh rather than signing in again.',
      body: errorEnvelope(401, 'UNAUTHORIZED', 'Unauthorized'),
    });
  }
  if (endpoint.permissions.length) {
    errors.push({
      status: 403,
      title: 'Forbidden',
      when: `The credential is valid but lacks ${endpoint.permissions.map((permission) => `\`${permission}\``).join(' and ')}. A 403 is never a token problem — do not retry with a fresh token.`,
      body: errorEnvelope(403, 'FORBIDDEN', 'Missing required permission'),
    });
  }
  if (hasPathParam) {
    errors.push({
      status: 404,
      title: 'Not Found',
      when: 'No record with that identifier exists **for your tenant**. Row-level security scopes every read, so another tenant’s existing record is a 404 here, not a 403.',
      body: errorEnvelope(404, 'NOT_FOUND', 'Not found'),
    });
  }
  if (credential === 'apikey' || ['post', 'put', 'patch', 'delete'].includes(method)) {
    errors.push({
      status: 429,
      title: 'Too Many Requests',
      when: 'The per-key or per-policy rate limit was exceeded. Back off exponentially; retrying immediately extends the window rather than clearing it.',
      body: errorEnvelope(429, 'TOO_MANY_REQUESTS', 'Rate limit exceeded'),
    });
  }
  errors.push({
    status: 500,
    title: 'Internal Server Error',
    when: 'An unhandled fault. The message is deliberately generic — details are in the platform log, indexed by the request_id in this body.',
    body: errorEnvelope(500, 'INTERNAL_SERVER_ERROR', 'An internal error occurred'),
  });
  return errors;
}

/** 201 for a create, 200 otherwise — matching Nest's own default. */
function successStatus(endpoint: ExampleEndpoint): number {
  return endpoint.method.toLowerCase() === 'post' ? 201 : 200;
}

export function buildExample(endpoint: ExampleEndpoint): EndpointExample {
  const url = `${endpoint.serverUrl}${examplePath(endpoint)}${exampleQuery(endpoint)}`;
  const sendsBody =
    endpoint.hasRequestBody || ['post', 'put', 'patch'].includes(endpoint.method.toLowerCase());
  const { body, placeholder } = sendsBody
    ? exampleBody(endpoint)
    : { body: '', placeholder: false };
  const payload = sendsBody ? body : null;

  return {
    url,
    bodyIsPlaceholder: sendsBody && placeholder,
    snippets: {
      curl: curlSnippet(endpoint, url, payload),
      php: phpSnippet(endpoint, url, payload),
      python: pythonSnippet(endpoint, url, payload),
      node: nodeSnippet(endpoint, url, payload),
      java: javaSnippet(endpoint, url, payload),
      go: goSnippet(endpoint, url, payload),
    },
    successStatus: successStatus(endpoint),
    successBody: successEnvelope(endpoint),
    errors: errorExamples(endpoint),
  };
}

/**
 * Order matters: this is the tab order in the reference, and it is deliberately
 * cURL, PHP, Python first. cURL is the one every reader can paste into a
 * terminal to confirm the endpoint works before writing any code, and PHP and
 * Python are what integrators actually reach for against an SMS gateway.
 */
export const LANGUAGE_LABELS: Record<ExampleLanguage, string> = {
  curl: 'cURL',
  php: 'PHP',
  python: 'Python',
  node: 'Node.js',
  java: 'Java',
  go: 'Go',
};
