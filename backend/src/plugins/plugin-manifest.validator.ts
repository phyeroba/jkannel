import { createHash, createPublicKey, verify } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ManifestValidationIssue,
  ManifestValidationResult,
  PLUGIN_MANIFEST_SCHEMA,
  PLUGIN_SDK_VERSION,
  PluginCategory,
  PluginManifest,
} from './plugin.contracts';

const fields = [
  'schemaVersion',
  'id',
  'uuid',
  'name',
  'vendor',
  'version',
  'description',
  'category',
  'sdkVersion',
  'jkannelVersion',
  'entrypoint',
  'apiVersion',
  'dependencies',
  'permissions',
  'events',
  'capabilities',
  'migrations',
  'configurationSchema',
  'license',
  'checksum',
  'signature',
  'supportUrl',
  'documentationUrl',
];
const categories = new Set<PluginCategory>([
  'communication',
  'engine',
  'authentication',
  'notification',
  'dashboard',
  'analytics',
  'reporting',
  'import',
  'export',
  'monitoring',
  'security',
  'billing',
  'workflow',
  'automation',
  'integration',
  'ai',
  'developer',
  'theme',
  'ui-component',
]);
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const text = (x: unknown) => typeof x === 'string' && x.trim().length > 0;
const safeRelative = (x: unknown) =>
  text(x) &&
  !String(x).includes('\\') &&
  !String(x).startsWith('/') &&
  !String(x).split('/').includes('..');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== 'signature' && k !== 'checksum')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

@Injectable()
export class PluginManifestValidator {
  validate(
    input: unknown,
    options: { packageBytes?: Buffer; publisherPublicKeyPem?: string; production?: boolean } = {},
  ): ManifestValidationResult {
    const issues: ManifestValidationIssue[] = [];
    const issue = (code: string, path: string, message: string) =>
      issues.push({ code, path, message, severity: 'blocking-error' });
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return {
        valid: false,
        issues: [
          {
            code: 'manifest.type',
            path: '$',
            message: 'Manifest must be an object',
            severity: 'blocking-error',
          },
        ],
      };
    const value = input as Record<string, any>;
    for (const key of Object.keys(value))
      if (!fields.includes(key)) issue('manifest.unknown-field', key, 'Unknown manifest field');
    for (const key of fields.slice(0, 22))
      if (value[key] === undefined) issue('manifest.required', key, 'Field is required');
    if (value.schemaVersion !== PLUGIN_MANIFEST_SCHEMA)
      issue(
        'manifest.schema-version',
        'schemaVersion',
        `Supported schema is ${PLUGIN_MANIFEST_SCHEMA}`,
      );
    if (!text(value.id) || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,}$/.test(value.id))
      issue('manifest.id', 'id', 'Use a lower-case reverse-domain identifier');
    if (
      !text(value.uuid) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.uuid)
    )
      issue('manifest.uuid', 'uuid', 'A valid UUID is required');
    for (const key of ['name', 'vendor', 'description', 'license'])
      if (!text(value[key])) issue('manifest.text', key, 'Non-empty text is required');
    if (!semver.test(value.version ?? ''))
      issue('manifest.version', 'version', 'Semantic version is required');
    if (value.sdkVersion !== `^${PLUGIN_SDK_VERSION}`)
      issue('manifest.sdk-version', 'sdkVersion', `SDK range must be ^${PLUGIN_SDK_VERSION}`);
    if (!categories.has(value.category))
      issue('manifest.category', 'category', 'Unsupported plugin category');
    if (value.apiVersion !== 'v1')
      issue('manifest.api-version', 'apiVersion', 'Unsupported API version');
    if (!safeRelative(value.entrypoint) || !String(value.entrypoint ?? '').endsWith('.js'))
      issue(
        'manifest.entrypoint',
        'entrypoint',
        'Entrypoint must be a relative JavaScript path without traversal',
      );
    if (!safeRelative(value.configurationSchema))
      issue(
        'manifest.configuration-schema',
        'configurationSchema',
        'Configuration schema path is unsafe',
      );
    for (const key of ['permissions', 'capabilities', 'migrations'])
      if (!Array.isArray(value[key]) || !value[key].every(text))
        issue('manifest.array', key, 'Must be an array of non-empty strings');
    if (value.category === 'engine' && !value.capabilities?.includes('engine.adapter.core'))
      issue(
        'manifest.engine-contract',
        'capabilities',
        'Engine plugins must declare engine.adapter.core',
      );
    if (
      value.permissions?.some(
        (p: unknown) => typeof p === 'string' && (p === '*' || p.endsWith('.*')),
      )
    )
      issue('manifest.permission-wildcard', 'permissions', 'Wildcard permissions are prohibited');
    if (
      !value.dependencies ||
      typeof value.dependencies !== 'object' ||
      !value.dependencies.plugins ||
      !Array.isArray(value.dependencies.services)
    )
      issue(
        'manifest.dependencies',
        'dependencies',
        'Plugin and service dependencies are required',
      );
    if (
      !value.events ||
      !Array.isArray(value.events.subscribes) ||
      !Array.isArray(value.events.publishes)
    )
      issue(
        'manifest.events',
        'events',
        'Published and subscribed event declarations are required',
      );
    if (!/^sha256:[0-9a-f]{64}$/i.test(value.checksum ?? ''))
      issue('manifest.checksum-format', 'checksum', 'A SHA-256 package checksum is required');
    if (!text(value.signature))
      issue('manifest.signature-required', 'signature', 'A detached signature is required');
    const bytes = options.packageBytes ?? Buffer.from(canonical(value));
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (options.packageBytes && value.checksum !== digest)
      issue('manifest.checksum', 'checksum', 'Package checksum mismatch');
    if (options.production && !options.publisherPublicKeyPem)
      issue(
        'manifest.publisher',
        'signature',
        'Production validation requires an approved publisher public key',
      );
    if (options.publisherPublicKeyPem) {
      try {
        const ok = verify(
          null,
          Buffer.from(canonical(value)),
          createPublicKey(options.publisherPublicKeyPem),
          Buffer.from(value.signature ?? '', 'base64'),
        );
        if (!ok) issue('manifest.signature', 'signature', 'Detached signature is invalid');
      } catch {
        issue('manifest.signature', 'signature', 'Detached signature could not be verified');
      }
    }
    return {
      valid: issues.length === 0,
      issues,
      ...(issues.length === 0 ? { manifest: value as PluginManifest } : {}),
    };
  }
}
