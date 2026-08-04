/**
 * API-key scope vocabulary (API_GATEWAY_ENGINEERING_SPECIFICATION §6).
 *
 * `ApiKeyAuthGuard` publishes an authenticated key's `scopes` as the request
 * principal's `permissions`, so the standard {@link PermissionsGuard} enforces
 * them with `@RequirePermissions(...)` and no second mechanism is needed. Until
 * now that bridge was never used: the guard protected exactly one echo endpoint
 * and no scope was checked anywhere in the product.
 *
 * These names are deliberately NOT the console permission codes
 * (`messages.view`, `configuration.manage`, ...). A key's scope set is issued to
 * a machine client and must be independent of the human role catalogue; keeping
 * the vocabularies separate is what stops an API key from inheriting an
 * operator's console rights.
 */
export const GATEWAY_SCOPES = {
  /** Submit messages through the gateway. */
  smsSend: 'sms.send',
  /** Read message history / delivery status. */
  smsRead: 'sms.read',
  /** Read the routing decision behind a message. */
  routingRead: 'routing.read',
  /** Read the caller's own gateway audit trail. */
  auditRead: 'audit.read',
} as const;

export type GatewayScope = (typeof GATEWAY_SCOPES)[keyof typeof GATEWAY_SCOPES];

/** Every scope the gateway understands, for validation and documentation. */
export const ALL_GATEWAY_SCOPES: GatewayScope[] = Object.values(GATEWAY_SCOPES);

/** True when `scope` is a scope this gateway enforces. */
export function isGatewayScope(scope: string): scope is GatewayScope {
  return (ALL_GATEWAY_SCOPES as string[]).includes(scope);
}
