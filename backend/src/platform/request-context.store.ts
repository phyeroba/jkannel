import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Everything a log line should be able to say about the request it belongs to.
 * `principal` is read lazily at log time because AuthGuard populates it *after*
 * RequestContextMiddleware has already opened the async scope.
 */
export interface RequestContext {
  requestId?: string;
  correlationId?: string;
  method?: string;
  route?: string;
  clientIp?: string;
  startedAt?: number;
  /** The live request object, so user/tenant resolve at log time, not entry. */
  principalCarrier?: { principal?: { userId?: string; tenantId?: string; username?: string } };
}

/** Fields attached to every log line emitted inside a request scope. */
export interface RequestLogFields {
  correlationId?: string;
  requestId?: string;
  userId?: string;
  tenantId?: string;
  username?: string;
  method?: string;
  route?: string;
  clientIp?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `work` inside a request-scoped async context.
 *
 * This is the mechanism that lets a log line written deep inside a service know
 * its correlation id without every function signature growing a context
 * parameter. RequestContextMiddleware opens the scope around `next()`, so the
 * whole downstream handler chain — guards, interceptors, controllers,
 * repositories, and any promise they await — sees it.
 */
export function runWithRequestContext<T>(context: RequestContext, work: () => T): T {
  return storage.run(context, work);
}

/** The active request context, or undefined outside a request (jobs, timers). */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Merges values into the active context; a no-op outside a request scope. */
export function updateRequestContext(patch: Partial<RequestContext>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}

/**
 * Flattens the active context into log fields, resolving the authenticated
 * principal at call time. Returns an empty object outside a request so
 * background work logs cleanly rather than with a pile of nulls.
 */
export function requestLogFields(): RequestLogFields {
  const store = storage.getStore();
  if (!store) return {};
  const principal = store.principalCarrier?.principal;
  const fields: RequestLogFields = {};
  if (store.correlationId) fields.correlationId = store.correlationId;
  if (store.requestId) fields.requestId = store.requestId;
  if (principal?.userId) fields.userId = principal.userId;
  if (principal?.tenantId) fields.tenantId = principal.tenantId;
  if (principal?.username) fields.username = principal.username;
  if (store.method) fields.method = store.method;
  if (store.route) fields.route = store.route;
  if (store.clientIp) fields.clientIp = store.clientIp;
  return fields;
}
