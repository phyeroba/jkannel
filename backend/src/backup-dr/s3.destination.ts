import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { BackupDestination } from './backup-destination';

/**
 * S3-compatible offsite destination (AWS S3, MinIO, Ceph RGW, Wasabi, R2, ...).
 *
 * G17's remaining gap was that the only "offsite" driver copied the artifact to
 * another path on the same host, which does not survive host loss. This is a
 * real remote destination.
 *
 * WHY NO SDK
 * ----------
 * `@aws-sdk/client-s3` pulls in ~80 transitive packages for what is, for a
 * single PutObject/DeleteObject/HeadObject, three signed HTTPS requests. The
 * whole of AWS Signature Version 4 is four nested HMAC-SHA256 calls plus a
 * canonical-request string, all available from `node:crypto`, and Node ships
 * `fetch`. So the signer lives here, in ~80 lines, with no new dependency and
 * no supply-chain surface.
 *
 * WHAT "SUCCESS" MEANS HERE
 * -------------------------
 * A backup must never report success when the artifact did not reach its
 * destination, so `put()` does not trust a 200. It verifies the stored object:
 *
 *   1. If the response `ETag` is a plain MD5 (the single-part, non-SSE-KMS
 *      case) it is compared against the MD5 of the bytes actually sent.
 *   2. Otherwise (SSE-KMS/SSE-C, or a server that omits the header) it issues a
 *      signed HEAD and compares `Content-Length` against the local size.
 *
 * Any non-2xx, any mismatch, and any transport error throws. There is no path
 * through this class that reports a stored object it did not confirm.
 *
 * MEMORY
 * ------
 * Artifacts are uploaded with a single PutObject and are therefore read into
 * memory (SigV4 requires the payload hash up front, and streaming would mean
 * implementing chunked `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` or multipart).
 * `BackupDrService` already buffers the whole pg_dump to encrypt it, so this
 * adds no new ceiling — but both are why the backend/backup-service containers
 * are given generous memory limits. Objects above `maxObjectBytes` (default
 * 4 GiB, well under the 5 GiB single-PUT hard limit) are rejected loudly rather
 * than half-uploaded.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
/** S3's hard limit for a single PutObject is 5 GiB; stay below it. */
const DEFAULT_MAX_OBJECT_BYTES = 4 * 1024 * 1024 * 1024;

export interface S3DestinationConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Base endpoint, e.g. `https://minio.internal:9000`. */
  endpoint: string;
  /** `bucket/key` in the path vs `bucket.host/key`. MinIO needs path style. */
  forcePathStyle: boolean;
  /** Optional key prefix, e.g. `jkannel/prod`. Never starts or ends with '/'. */
  prefix: string;
  /** STS session token, when credentials are temporary. */
  sessionToken?: string;
  /** Value for `x-amz-server-side-encryption`, e.g. 'AES256' or 'aws:kms'. */
  serverSideEncryption?: string;
  /** KMS key id, only meaningful with serverSideEncryption='aws:kms'. */
  kmsKeyId?: string;
  maxObjectBytes?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

const sha256Hex = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

/**
 * RFC 3986 encoding for a single path segment. S3 canonical requests encode the
 * path exactly once (unlike every other AWS service), and `encodeURIComponent`
 * leaves `!'()*` unescaped, which would produce a signature mismatch on keys
 * containing them.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const encodeKey = (key: string): string => key.split('/').map(encodeSegment).join('/');

/**
 * The SigV4 four-step key derivation. Exported so it can be checked against
 * AWS's published test vector rather than only against itself.
 */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  return hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service),
    'aws4_request',
  );
}

/** `s3://bucket/key` -> its parts, or null when the URI is not an S3 URI. */
export function parseS3Uri(uri: string): { bucket: string; key: string } | null {
  if (!uri.startsWith('s3://')) return null;
  const rest = uri.slice('s3://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}

export class S3Destination implements BackupDestination {
  readonly id = 's3';

  private readonly config: Required<
    Omit<S3DestinationConfig, 'sessionToken' | 'serverSideEncryption' | 'kmsKeyId' | 'fetchImpl'>
  > &
    Pick<S3DestinationConfig, 'sessionToken' | 'serverSideEncryption' | 'kmsKeyId' | 'fetchImpl'>;

  constructor(config: S3DestinationConfig) {
    this.config = {
      ...config,
      prefix: config.prefix.replace(/^\/+|\/+$/g, ''),
      maxObjectBytes: config.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES,
      timeoutMs: config.timeoutMs ?? 120_000,
    };
  }

  describe(): string {
    const target = `s3://${this.config.bucket}${this.config.prefix ? `/${this.config.prefix}` : ''}`;
    return `${target} (${this.config.endpoint})`;
  }

  async put(localPath: string, remoteName: string): Promise<{ uri: string; bytes: number }> {
    const body = await readFile(localPath);
    if (body.length > this.config.maxObjectBytes)
      throw new Error(
        `Artifact is ${body.length} bytes, above the ${this.config.maxObjectBytes}-byte single-PUT ` +
          'limit for this destination. Raise BACKUP_S3_MAX_OBJECT_BYTES only up to 5 GiB; beyond ' +
          'that the object needs multipart upload, which this driver does not implement.',
      );

    const key = this.keyFor(remoteName);
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
    if (this.config.serverSideEncryption) {
      headers['x-amz-server-side-encryption'] = this.config.serverSideEncryption;
      if (this.config.kmsKeyId)
        headers['x-amz-server-side-encryption-aws-kms-key-id'] = this.config.kmsKeyId;
    }

    const response = await this.send('PUT', key, headers, body);
    if (!response.ok)
      throw new Error(
        `PutObject s3://${this.config.bucket}/${key} failed: HTTP ${response.status} ${response.statusText}. ` +
          `${await this.errorBody(response)}`,
      );

    await this.confirmStored(key, body, response.headers.get('etag'));
    return { uri: `s3://${this.config.bucket}/${key}`, bytes: body.length };
  }

  async remove(uri: string): Promise<void> {
    const parsed = parseS3Uri(uri);
    // Retention may hold a URI written by a previously configured destination
    // (e.g. a file:// path from before the switch to S3). Deleting it is not
    // this driver's job and must not fail the retention sweep.
    if (!parsed || parsed.bucket !== this.config.bucket) return;
    const response = await this.send('DELETE', parsed.key, {}, Buffer.alloc(0));
    // 204 is the success case; 404 means the object is already gone, which the
    // interface contract requires us to tolerate.
    if (response.ok || response.status === 404) return;
    throw new Error(
      `DeleteObject ${uri} failed: HTTP ${response.status} ${response.statusText}. ` +
        `${await this.errorBody(response)}`,
    );
  }

  // -- internals ------------------------------------------------------------

  private keyFor(remoteName: string): string {
    const name = basename(remoteName);
    return this.config.prefix ? `${this.config.prefix}/${name}` : name;
  }

  /**
   * Proves the object is really in the bucket with the bytes we sent. A 200
   * from a proxy, a misrouted request, or a bucket-policy quirk that swallows
   * the body would otherwise be recorded as a successful offsite copy.
   */
  private async confirmStored(key: string, body: Buffer, etag: string | null): Promise<void> {
    const tag = (etag ?? '').replace(/"/g, '').trim();
    if (/^[0-9a-f]{32}$/i.test(tag)) {
      const md5 = createHash('md5').update(body).digest('hex');
      if (tag.toLowerCase() !== md5)
        throw new Error(
          `Upload verification failed for s3://${this.config.bucket}/${key}: the destination ` +
            `reported ETag ${tag} but the artifact's MD5 is ${md5}. Treating the copy as NOT stored.`,
        );
      return;
    }

    // No usable ETag (SSE-KMS, SSE-C, or a server that omits it): fall back to
    // a signed HEAD and compare sizes.
    const head = await this.send('HEAD', key, {}, Buffer.alloc(0));
    if (!head.ok)
      throw new Error(
        `Upload verification failed for s3://${this.config.bucket}/${key}: HeadObject returned ` +
          `HTTP ${head.status}. Treating the copy as NOT stored.`,
      );
    const stored = Number(head.headers.get('content-length'));
    if (!Number.isFinite(stored) || stored !== body.length)
      throw new Error(
        `Upload verification failed for s3://${this.config.bucket}/${key}: destination holds ` +
          `${head.headers.get('content-length')} bytes, expected ${body.length}. ` +
          'Treating the copy as NOT stored.',
      );
  }

  private async errorBody(response: { text?: () => Promise<string> }): Promise<string> {
    try {
      const text = (await response.text?.()) ?? '';
      return text.slice(0, 300);
    } catch {
      return '';
    }
  }

  private urlFor(key: string): URL {
    const base = new URL(this.config.endpoint);
    if (this.config.forcePathStyle)
      return new URL(
        `${base.pathname.replace(/\/+$/, '')}/${encodeSegment(this.config.bucket)}/${encodeKey(key)}`,
        base,
      );
    const virtual = new URL(base.toString());
    virtual.host = `${this.config.bucket}.${base.host}`;
    virtual.pathname = `/${encodeKey(key)}`;
    return virtual;
  }

  private async send(
    method: 'PUT' | 'DELETE' | 'HEAD',
    key: string,
    extraHeaders: Record<string, string>,
    body: Buffer,
  ): Promise<Response> {
    const url = this.urlFor(key);
    const headers = this.signedHeaders(method, url, extraHeaders, body);
    const doFetch = this.config.fetchImpl ?? fetch;
    // Cast: the ambient `BodyInit` in this toolchain does not admit a
    // Buffer/Uint8Array, but Node's undici-backed fetch accepts one at runtime
    // (and sending the bytes verbatim is exactly what the SigV4 payload hash
    // was computed over, so it must not be re-encoded).
    const init = {
      method,
      headers,
      signal: AbortSignal.timeout(this.config.timeoutMs),
      ...(method === 'PUT' ? { body } : {}),
    } as unknown as RequestInit;
    try {
      return await doFetch(url.toString(), init);
    } catch (error) {
      throw new Error(
        `${method} ${url.origin}${url.pathname} failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  /**
   * AWS Signature Version 4, the whole of it. See
   * docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
   */
  private signedHeaders(
    method: string,
    url: URL,
    extraHeaders: Record<string, string>,
    body: Buffer,
  ): Record<string, string> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20240102T030405Z
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body);

    const headers: Record<string, string> = {
      ...extraHeaders,
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (this.config.sessionToken) headers['x-amz-security-token'] = this.config.sessionToken;

    const canonicalNames = Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort();
    const lower: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers))
      lower[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');

    const canonicalHeaders = canonicalNames.map((name) => `${name}:${lower[name]}\n`).join('');
    const signedHeaderList = canonicalNames.join(';');

    // Query string is always empty for these three operations; kept explicit so
    // adding a parameterised call later cannot silently break the signature.
    const canonicalRequest = [
      method,
      url.pathname,
      '',
      canonicalHeaders,
      signedHeaderList,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.config.region}/${SERVICE}/aws4_request`;
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

    const signingKey = deriveSigningKey(
      this.config.secretAccessKey,
      dateStamp,
      this.config.region,
      SERVICE,
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    return {
      ...headers,
      authorization:
        `${ALGORITHM} Credential=${this.config.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaderList}, Signature=${signature}`,
    };
  }
}

/**
 * Builds an {@link S3Destination} from environment variables.
 *
 * Throws on ANY missing required setting. An operator who set
 * `BACKUP_DESTINATION=s3` and mistyped the bucket must get a failed backup with
 * the reason, never a silent fallback to a host-local copy with a green tick.
 */
export function s3DestinationFromEnv(env: NodeJS.ProcessEnv): S3Destination {
  const read = (name: string) => (env[name] ?? '').trim();
  const missing: string[] = [];
  const required = (name: string) => {
    const value = read(name);
    if (!value) missing.push(name);
    return value;
  };

  const bucket = required('BACKUP_S3_BUCKET');
  const accessKeyId = required('BACKUP_S3_ACCESS_KEY_ID');
  const secretAccessKey = required('BACKUP_S3_SECRET_ACCESS_KEY');
  const region = read('BACKUP_S3_REGION') || 'us-east-1';
  const endpointSetting = read('BACKUP_S3_ENDPOINT');

  if (missing.length)
    throw new Error(
      `BACKUP_DESTINATION='s3' requires ${missing.join(', ')}. ` +
        'Refusing to start a backup that would report an offsite copy it cannot make.',
    );

  const endpoint = endpointSetting || `https://s3.${region}.amazonaws.com`;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(
      `BACKUP_S3_ENDPOINT='${endpoint}' is not a valid absolute URL (expected e.g. https://minio.internal:9000).`,
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error(`BACKUP_S3_ENDPOINT must be http(s); got '${parsed.protocol}'.`);

  const pathStyleSetting = read('BACKUP_S3_FORCE_PATH_STYLE').toLowerCase();
  const forcePathStyle = pathStyleSetting
    ? ['1', 'true', 'yes', 'on'].includes(pathStyleSetting)
    : // A custom endpoint is almost always MinIO/Ceph, which are path-style;
      // AWS itself is virtual-hosted.
      Boolean(endpointSetting);

  const maxObjectBytes = Number(read('BACKUP_S3_MAX_OBJECT_BYTES')) || undefined;
  const timeoutMs = Number(read('BACKUP_S3_TIMEOUT_MS')) || undefined;

  return new S3Destination({
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    endpoint,
    forcePathStyle,
    prefix: read('BACKUP_S3_PREFIX'),
    sessionToken: read('BACKUP_S3_SESSION_TOKEN') || undefined,
    serverSideEncryption: read('BACKUP_S3_SSE') || undefined,
    kmsKeyId: read('BACKUP_S3_SSE_KMS_KEY_ID') || undefined,
    maxObjectBytes,
    timeoutMs,
  });
}
