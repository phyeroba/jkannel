import path from 'node:path';

/**
 * Central configuration for the acceptance suite. Everything is overridable via
 * environment variables so the same specs run against local, CI, or staging
 * stacks without edits.
 *
 * IMPORTANT: this suite assumes the JKANNEL stack is ALREADY RUNNING. It does
 * not build or start the frontend/backend. See README.md.
 */

/** SPA base URL (Vite dev server / served build). */
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';

/**
 * REST API base, including the version segment. The SPA itself defaults to
 * `http://127.0.0.1:3000/api/v1` (see frontend/src/api.ts).
 */
export const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://127.0.0.1:3000/api/v1';

/** Operator credentials used to authenticate the suite. */
export const OPERATOR = {
  tenant: process.env.E2E_OPERATOR_TENANT ?? 'default',
  username: process.env.E2E_OPERATOR_USERNAME ?? 'operator',
  password: process.env.E2E_OPERATOR_PASSWORD ?? '',
};

/** Where the pre-authenticated browser storage state is written by global-setup. */
export const STORAGE_STATE = path.join(__dirname, '..', '.auth', 'state.json');

/** localStorage keys the SPA uses to persist its session (see frontend/src/api.ts). */
export const TOKEN_KEYS = {
  access: 'jkannel-access-token',
  refresh: 'jkannel-refresh-token',
} as const;

/** A short, obviously-synthetic tag applied to every entity the suite creates. */
export const E2E_TAG = 'e2e-acceptance';

/** Unique, identifiable name for created test data so cleanup is unambiguous. */
export function uniqueName(prefix: string): string {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return `${prefix}-${E2E_TAG}-${stamp}`;
}
