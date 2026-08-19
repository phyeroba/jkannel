/**
 * The scope vocabulary an API key is issued against.
 *
 * Transcribed from `backend/src/api-gateway/gateway-scopes.ts`. It lives in a
 * module rather than inside the picker component for two reasons: `<script
 * setup>` cannot carry module exports, and the create form, the client list and
 * the API reference all need to describe the same four scopes the same way.
 *
 * THESE ARE NOT CONSOLE PERMISSIONS. `messages.view` and `configuration.manage`
 * are role codes for humans; a key's scopes are deliberately a separate
 * vocabulary so an API key can never inherit an operator's console rights.
 * Putting a console permission code in a key's scope list grants nothing, and
 * the old free-text field made that mistake easy to make and impossible to see.
 */
export interface ScopeOption {
  value: string;
  label: string;
  /** What the scope permits, in one sentence. */
  grants: string;
  /** The routes it unlocks, so the choice can be checked against the API docs. */
  routes: string;
  /** Why granting it might be more than intended. */
  caution?: string;
}

export const GATEWAY_SCOPES: ScopeOption[] = [
  {
    value: 'sms.send',
    label: 'Submit messages',
    grants:
      'Submit an MT message for delivery, and spend this customer’s credit and quota doing it.',
    routes: 'POST /gateway/messages',
    caution:
      'The only scope that costs money and the only one that reaches a carrier. Grant it to a client that sends, and to nothing else.',
  },
  {
    value: 'sms.read',
    label: 'Read message history',
    grants: 'List this tenant’s messages and their delivery status.',
    routes: 'GET /gateway/messages',
    caution:
      'Bodies and recipient numbers are returned subject to the tenant’s masking policy. A key with this scope can read traffic it did not send.',
  },
  {
    value: 'routing.read',
    label: 'Read routing decisions',
    grants: 'See which bind a message was routed through, which rule chose it, and why.',
    routes: 'GET /gateway/decisions',
  },
  {
    value: 'audit.read',
    label: 'Read own audit trail',
    grants: 'Read the gateway audit records produced by this key’s own calls.',
    routes: 'GET /gateway/audit',
  },
];

/** True when `scope` is one the gateway actually enforces. */
export function isGatewayScope(scope: string): boolean {
  return GATEWAY_SCOPES.some((option) => option.value === scope);
}
