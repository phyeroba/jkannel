import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { PERMISSIONS_KEY } from '../security/permissions.guard';

/**
 * Auto-derives the OpenAPI 3.1 document from the actually registered Nest
 * controllers by reflecting the same decorator metadata Nest uses to build its
 * router: controller/handler PATH_METADATA, handler METHOD_METADATA,
 * GUARDS_METADATA (to tell secured routes from public ones),
 * ROUTE_ARGS_METADATA (to recover named @Query/@Header parameters) and the
 * project's own PERMISSIONS_KEY.
 *
 * What is derived automatically (guaranteed to match the running routes):
 *   - path + HTTP method for every route on every registered controller;
 *   - path parameters (from :param segments);
 *   - named query parameters (@Query('name')) and header parameters
 *     (@Headers('name'));
 *   - whether the route is bearer-secured (AuthGuard present) or public;
 *   - required permissions (@RequirePermissions -> x-required-permissions).
 *
 * Honest limitations (documented, not hidden):
 *   - Request/response *body schemas* cannot be reflected: this codebase parses
 *     bodies as `any` with hand-written validators rather than class-validator
 *     DTOs, so bodies are emitted as generic `object`. A small curated overrides
 *     map enriches a few high-value operations.
 *   - Endpoints that take the whole query object (@Query() with no key, used by
 *     the shared grid helper) expose the shared grid/cursor/field parameters by
 *     reference rather than a reflected per-field list.
 */

const HTTP_METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.OPTIONS]: 'options',
  [RequestMethod.HEAD]: 'head',
};

// RouteParamtypes: QUERY=4, HEADERS=6 (see @nestjs/common route-paramtypes enum).
const QUERY_PARAMTYPE = 4;
const HEADERS_PARAMTYPE = 6;

export interface RouteParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
}

export interface RouteInfo {
  controller: string;
  handler: string;
  method: string;
  /** OpenAPI-style path with {param} placeholders, e.g. /jobs/{id}. */
  path: string;
  secured: boolean;
  permissions: string[];
  parameters: RouteParameter[];
  /** True when the handler accepts the whole query object (grid-style list). */
  wholeQuery: boolean;
  hasBody: boolean;
}

type Ctor = new (...args: unknown[]) => unknown;

function firstPath(value: unknown): string {
  if (Array.isArray(value)) return firstPath(value[0]);
  if (typeof value === 'string') return value;
  return '';
}

function joinPaths(base: string, sub: string): string {
  const segments = [base, sub]
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0);
  const joined = `/${segments.join('/')}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined;
}

function toOpenApiPath(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const converted = path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    params.push(name);
    return `{${name}}`;
  });
  return { path: converted, params };
}

function guardsInclude(target: object, name: string): boolean {
  const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, target);
  if (!Array.isArray(guards)) return false;
  return guards.some((guard) => {
    if (typeof guard === 'function') return guard.name === name;
    const ctor = (guard as { constructor?: { name?: string } })?.constructor;
    return ctor?.name === name;
  });
}

function readPermissions(target: object): string[] {
  const value: unknown = Reflect.getMetadata(PERMISSIONS_KEY, target);
  return Array.isArray(value) ? (value as string[]) : [];
}

function ownMethodNames(cls: Ctor): string[] {
  const names = new Set<string>();
  let proto: object | null = cls.prototype as object;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor') names.add(name);
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return [...names];
}

interface ReflectedArgs {
  query: RouteParameter[];
  headers: RouteParameter[];
  wholeQuery: boolean;
  hasBody: boolean;
}

function reflectArgs(cls: Ctor, handlerName: string): ReflectedArgs {
  const meta =
    (Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, handlerName) as
      Record<string, { data?: unknown }> | undefined) ?? {};
  const query: RouteParameter[] = [];
  const headers: RouteParameter[] = [];
  let wholeQuery = false;
  let hasBody = false;
  for (const [key, entry] of Object.entries(meta)) {
    const paramtype = Number(key.split(':')[0]);
    const data = entry?.data;
    if (paramtype === QUERY_PARAMTYPE) {
      if (typeof data === 'string' && data.length) {
        query.push({ name: data, in: 'query', required: false });
      } else {
        wholeQuery = true;
      }
    } else if (paramtype === HEADERS_PARAMTYPE) {
      if (typeof data === 'string' && data.length) {
        headers.push({ name: data, in: 'header', required: false });
      }
    } else if (paramtype === 3 /* BODY */) {
      hasBody = true;
    }
  }
  return { query, headers, wholeQuery, hasBody };
}

/**
 * Reflects the route table from a set of controller classes. Pure and
 * dependency-free (no Nest runtime), so it is directly unit-testable against
 * plain decorated classes.
 */
export function collectRoutes(controllers: Ctor[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const cls of controllers) {
    if (typeof cls !== 'function') continue;
    const basePath = firstPath(Reflect.getMetadata(PATH_METADATA, cls));
    const classSecured = guardsInclude(cls, 'AuthGuard');
    const classPermissions = readPermissions(cls);
    for (const handlerName of ownMethodNames(cls)) {
      const handler = (cls.prototype as Record<string, unknown>)[handlerName];
      if (typeof handler !== 'function') continue;
      const methodValue: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      if (typeof methodValue !== 'number') continue;
      const httpMethod = HTTP_METHODS[methodValue];
      if (!httpMethod) continue;

      const handlerPath = firstPath(Reflect.getMetadata(PATH_METADATA, handler));
      const { path, params } = toOpenApiPath(joinPaths(basePath, handlerPath));
      const args = reflectArgs(cls, handlerName);
      const parameters: RouteParameter[] = [
        ...params.map((name) => ({ name, in: 'path' as const, required: true })),
        ...args.query,
        ...args.headers,
      ];
      routes.push({
        controller: cls.name,
        handler: handlerName,
        method: httpMethod,
        path,
        secured: classSecured || guardsInclude(handler, 'AuthGuard'),
        permissions: [...new Set([...classPermissions, ...readPermissions(handler)])],
        parameters,
        wholeQuery: args.wholeQuery && httpMethod === 'get',
        hasBody: args.hasBody,
      });
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function humanize(handler: string): string {
  const spaced = handler
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Curated summaries for a handful of important operations (keyed "METHOD path"). */
const SUMMARY_OVERRIDES: Record<string, string> = {
  'get /health': 'Backend health check',
  'get /metrics': 'Prometheus metrics exposition',
  'get /openapi.json': 'Auto-generated OpenAPI 3.1 document for this API',
};

function operationFor(route: RouteInfo): Record<string, unknown> {
  const key = `${route.method} ${route.path}`;
  const parameters: unknown[] = route.parameters.map((param) => ({
    name: param.name,
    in: param.in,
    required: param.required,
    schema: { type: 'string' },
  }));
  if (route.wholeQuery) {
    parameters.push(
      { $ref: '#/components/parameters/GridSearch' },
      { $ref: '#/components/parameters/GridSort' },
      { $ref: '#/components/parameters/GridLimit' },
      { $ref: '#/components/parameters/GridOffset' },
      { $ref: '#/components/parameters/GridCursor' },
      { $ref: '#/components/parameters/GridFields' },
    );
  }
  const operation: Record<string, unknown> = {
    operationId: `${route.controller}_${route.handler}`,
    summary: SUMMARY_OVERRIDES[key] ?? `${humanize(route.handler)}`,
    tags: [route.path.split('/').filter(Boolean)[0] ?? 'root'],
    security: route.secured ? [{ bearerAuth: [] }] : [],
    responses: {
      '200': { description: 'Successful response' },
    },
  };
  if (parameters.length) operation.parameters = parameters;
  if (route.permissions.length) operation['x-required-permissions'] = route.permissions;
  if (route.hasBody && ['post', 'put', 'patch'].includes(route.method)) {
    operation.requestBody = {
      content: { 'application/json': { schema: { type: 'object' } } },
    };
  }
  return operation;
}

export interface OpenApiDocumentOptions {
  title?: string;
  version?: string;
  description?: string;
}

export function buildOpenApiDocument(
  controllers: Ctor[],
  options: OpenApiDocumentOptions = {},
): Record<string, unknown> {
  const routes = collectRoutes(controllers);
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const entry = (paths[route.path] ??= {});
    entry[route.method] = operationFor(route);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: options.title ?? 'JKANNEL API',
      version: options.version ?? '0.1.0',
      description:
        options.description ??
        'Operational API for the JKANNEL console, Kamex/Kannel adapter management, SQLBox ' +
          'visibility, configuration, monitoring and platform jobs. Paths are auto-derived from ' +
          'the registered controllers; see x-generation for coverage notes.',
    },
    'x-generation': {
      strategy: 'reflected-from-controllers',
      routeCount: routes.length,
      derived: [
        'path',
        'method',
        'path-params',
        'named-query-params',
        'header-params',
        'auth',
        'permissions',
      ],
      limitations: [
        'Request/response body schemas are generic objects because bodies are validated imperatively (no DTO classes to reflect).',
        'Grid list endpoints expose shared grid/cursor/field parameters by reference rather than a reflected per-field list.',
      ],
    },
    servers: [{ url: '/api/v1' }],
    security: [{ bearerAuth: [] }],
    components: buildComponents(),
    paths,
  };
}

function buildComponents(): Record<string, unknown> {
  return {
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
      GridCursor: {
        name: 'cursor',
        in: 'query',
        description:
          'Opaque keyset cursor for stable forward pagination. When supplied, the endpoint ' +
          'returns { items, nextCursor, limit } instead of the offset page. Additive and ' +
          'opt-in; the offset contract is unchanged when omitted.',
        schema: { type: 'string' },
      },
      GridFields: {
        name: 'fields',
        in: 'query',
        description:
          'Comma-separated whitelisted field projection; trims each returned object to the ' +
          'requested fields. Unknown fields are rejected. Omit for all fields.',
        schema: { type: 'string' },
      },
    },
    schemas: {
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
          'Standard offset grid page. Every list endpoint also accepts filter.<field>=<value> ' +
          'query parameters against a whitelisted field set.',
        properties: {
          items: { type: 'array', items: { type: 'object' } },
          total: { type: 'integer' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
        },
      },
      CursorPage: {
        type: 'object',
        description:
          'Keyset page returned when ?cursor is used. nextCursor is null on the last page.',
        properties: {
          items: { type: 'array', items: { type: 'object' } },
          nextCursor: { type: ['string', 'null'] },
          limit: { type: 'integer' },
        },
      },
    },
  };
}
