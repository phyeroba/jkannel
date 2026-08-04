import { Injectable, Optional } from '@nestjs/common';

/**
 * Raised when a `secret://` reference has no backing environment variable.
 *
 * Deliberately carries only the reference and the environment variable name.
 * The secret VALUE is never read into this error, never stringified into its
 * message and never serialised by {@link toJSON}, so a resolver failure can be
 * logged or returned to an API client without disclosing credential material.
 */
export class MissingSecretError extends Error {
  readonly references: string[];
  readonly envNames: string[];
  constructor(references: string[], envNames: string[]) {
    super(
      `Unresolved secret reference${references.length > 1 ? 's' : ''}: ` +
        references.map((ref, i) => `${ref} (set ${envNames[i]})`).join(', '),
    );
    this.name = 'MissingSecretError';
    this.references = [...references];
    this.envNames = [...envNames];
  }
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      references: this.references,
      envNames: this.envNames,
    };
  }
}

/** Raised when a string is not a well-formed `secret://` reference. */
export class InvalidSecretReferenceError extends Error {
  constructor(readonly reference: string) {
    super(`Not a valid secret reference: ${reference}`);
    this.name = 'InvalidSecretReferenceError';
  }
}

const PREFIX = 'secret://';

/**
 * Resolves the `secret://namespace/name` references stored in the database
 * (`smsc_definitions.credential_secret_ref`, `EngineConfiguration.adminSecretRef`,
 * ...) for the configuration renderer.
 *
 * Two distinct operations, because they have different security properties:
 *
 * - {@link placeholder} maps a reference to the shell-style environment
 *   placeholder (`${KAMEX_ADMIN_PASSWORD}`) that goes into the *rendered file*.
 *   It never touches `process.env`, so a secret value cannot reach a generated,
 *   persisted or committed configuration. This mirrors the placeholders the
 *   working `runtime/kamex/kamex.conf` already uses, which the engine
 *   container's entrypoint substitutes at start-up.
 * - {@link resolve} reads the actual value out of the environment and throws
 *   {@link MissingSecretError} when it is absent or empty. This is the loud
 *   failure mode, used by {@link assertResolvable} for callers that want a
 *   generate/deploy to abort rather than emit a config whose placeholders
 *   nothing will fill in.
 *
 * Rendering does NOT require presence by default: JKANNEL's backend and the
 * engine are separate containers and the carrier password is deliberately only
 * present in the engine's environment. The renderer therefore reports the
 * environment variables it depends on (`requiredSecrets`) instead of guessing,
 * and strict mode (`JKANNEL_SECRETS_STRICT=true`, or an explicit option) turns
 * that report into a hard failure for single-container deployments.
 */
@Injectable()
export class SecretResolver {
  // @Optional so Nest does not attempt to inject the environment map; tests
  // pass an explicit one.
  constructor(@Optional() private readonly env: NodeJS.ProcessEnv = process.env) {}

  isReference(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith(PREFIX) && value.length > PREFIX.length;
  }

  /**
   * `secret://kamex/admin-password` -> `KAMEX_ADMIN_PASSWORD`.
   * Namespace separators and punctuation collapse to single underscores so the
   * mapping is stable, uppercase and a legal shell identifier.
   */
  envName(reference: string): string {
    if (!this.isReference(reference)) throw new InvalidSecretReferenceError(String(reference));
    const name = reference
      .slice(PREFIX.length)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new InvalidSecretReferenceError(reference);
    return name;
  }

  /** The `${ENV_NAME}` token written into rendered configuration. Never reads a value. */
  placeholder(reference: string): string {
    return `\${${this.envName(reference)}}`;
  }

  /** True when the reference has a non-empty backing environment variable. */
  has(reference: string): boolean {
    const value = this.env[this.envName(reference)];
    return typeof value === 'string' && value.length > 0;
  }

  /**
   * The secret value. Throws {@link MissingSecretError} when unset or empty.
   * Callers must never log the return value.
   */
  resolve(reference: string): string {
    const name = this.envName(reference);
    const value = this.env[name];
    if (typeof value !== 'string' || value.length === 0)
      throw new MissingSecretError([reference], [name]);
    return value;
  }

  /**
   * Asserts every reference is backed by an environment variable, reporting all
   * missing ones at once. Reads presence only -- values are never materialised.
   */
  assertResolvable(references: readonly string[]): void {
    const missingRefs: string[] = [];
    const missingNames: string[] = [];
    for (const reference of references) {
      const name = this.envName(reference);
      const value = this.env[name];
      if (typeof value !== 'string' || value.length === 0) {
        missingRefs.push(reference);
        missingNames.push(name);
      }
    }
    if (missingRefs.length) throw new MissingSecretError(missingRefs, missingNames);
  }

  /** Whether generation should hard-fail on an unresolved reference. */
  get strictByDefault(): boolean {
    return this.env.JKANNEL_SECRETS_STRICT === 'true';
  }
}
