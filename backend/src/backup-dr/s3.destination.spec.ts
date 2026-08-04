import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Destination, deriveSigningKey, parseS3Uri } from './s3.destination';

const BODY = Buffer.from('encrypted-pg_dump-bytes');
const MD5 = createHash('md5').update(BODY).digest('hex');

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
}

/**
 * A fetch double. `responses` is consumed in order; each entry is either a
 * response descriptor or an Error to throw (transport failure).
 */
function fetchDouble(responses: Array<Partial<Response> | Error | Record<string, unknown>>) {
  const calls: Call[] = [];
  let index = 0;
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? Buffer.from(init.body as Uint8Array) : undefined,
    });
    const next = responses[index++] ?? { status: 200, headers: {} };
    if (next instanceof Error) throw next;
    const spec = next as {
      status?: number;
      statusText?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    const status = spec.status ?? 200;
    const headers = new Map(
      Object.entries(spec.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: spec.statusText ?? '',
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => spec.body ?? '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function destination(
  overrides: Partial<ConstructorParameters<typeof S3Destination>[0]> = {},
  responses: Array<Partial<Response> | Error | Record<string, unknown>> = [
    { status: 200, headers: { etag: `"${MD5}"` } },
  ],
) {
  const { impl, calls } = fetchDouble(responses);
  const target = new S3Destination({
    bucket: 'jkannel-backups',
    region: 'eu-west-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    endpoint: 'https://minio.internal:9000',
    forcePathStyle: true,
    prefix: 'prod',
    fetchImpl: impl,
    ...overrides,
  });
  return { target, calls };
}

describe('SigV4 signing', () => {
  /**
   * AWS's own published derivation test vector
   * (docs.aws.amazon.com/general/latest/gr/signature-v4-examples.html). This is
   * the one part of the signer that can be checked against an external answer
   * rather than against itself.
   */
  it('derives the signing key exactly as AWS documents it', () => {
    const key = deriveSigningKey(
      'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      '20120215',
      'us-east-1',
      'iam',
    );
    expect(key.toString('hex')).toBe(
      'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d',
    );
  });

  it('sends a well-formed Authorization header with the S3 credential scope', async () => {
    const { target, calls } = destination();
    const file = writeTemp(BODY);
    await target.put(file.path, 'nightly.dump.enc');
    file.cleanup();

    const auth = calls[0].headers.authorization;
    expect(auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-west-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(calls[0].headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it('signs the payload: x-amz-content-sha256 is the SHA-256 of the bytes sent', async () => {
    const { target, calls } = destination();
    const file = writeTemp(BODY);
    await target.put(file.path, 'nightly.dump.enc');
    file.cleanup();

    expect(calls[0].headers['x-amz-content-sha256']).toBe(
      createHash('sha256').update(BODY).digest('hex'),
    );
    expect(calls[0].body!.equals(BODY)).toBe(true);
  });

  /**
   * A signature that does not change with the payload or the object key is not
   * a signature — it is a constant that happens to look like one. These two
   * cases catch the classic canonical-request mistakes.
   */
  it('produces a different signature for different payloads and different keys', async () => {
    const signatureFor = async (bytes: Buffer, name: string) => {
      const { target, calls } = destination();
      const file = writeTemp(bytes);
      await target
        .put(file.path, name)
        .catch(() => undefined); /* verification may fail; only the header matters */
      file.cleanup();
      return /Signature=([0-9a-f]{64})/.exec(calls[0].headers.authorization)![1];
    };

    const base = await signatureFor(BODY, 'a.dump.enc');
    expect(await signatureFor(Buffer.from('different-bytes'), 'a.dump.enc')).not.toBe(base);
    expect(await signatureFor(BODY, 'b.dump.enc')).not.toBe(base);
  });

  it('signs and sends the STS session token when one is configured', async () => {
    const { target, calls } = destination({ sessionToken: 'FQoGZXIvYXdzE' });
    const file = writeTemp(BODY);
    await target.put(file.path, 'nightly.dump.enc');
    file.cleanup();

    expect(calls[0].headers['x-amz-security-token']).toBe('FQoGZXIvYXdzE');
    expect(calls[0].headers.authorization).toContain('x-amz-security-token');
  });
});

describe('S3Destination addressing', () => {
  it('uses path-style addressing for a custom endpoint (MinIO/Ceph)', async () => {
    const { target, calls } = destination();
    const file = writeTemp(BODY);
    await target.put(file.path, 'nightly.dump.enc');
    file.cleanup();
    expect(calls[0].url).toBe('https://minio.internal:9000/jkannel-backups/prod/nightly.dump.enc');
    expect(calls[0].headers.host).toBe('minio.internal:9000');
  });

  it('uses virtual-hosted addressing when path style is off (AWS)', async () => {
    const { target, calls } = destination({
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      forcePathStyle: false,
      prefix: '',
    });
    const file = writeTemp(BODY);
    await target.put(file.path, 'nightly.dump.enc');
    file.cleanup();
    expect(calls[0].url).toBe(
      'https://jkannel-backups.s3.eu-west-1.amazonaws.com/nightly.dump.enc',
    );
    expect(calls[0].headers.host).toBe('jkannel-backups.s3.eu-west-1.amazonaws.com');
  });

  it('never leaks the secret key in describe()', () => {
    const { target } = destination();
    expect(target.describe()).toBe('s3://jkannel-backups/prod (https://minio.internal:9000)');
  });
});

describe('S3Destination.put', () => {
  it('returns the canonical s3:// URI and byte count on a verified upload', async () => {
    const { target } = destination();
    const file = writeTemp(BODY);
    const stored = await target.put(file.path, 'nightly.dump.enc');
    file.cleanup();
    expect(stored).toEqual({
      uri: 's3://jkannel-backups/prod/nightly.dump.enc',
      bytes: BODY.length,
    });
  });

  it('surfaces an HTTP failure instead of reporting a stored copy', async () => {
    const { target } = destination({}, [
      {
        status: 403,
        statusText: 'Forbidden',
        body: '<Error><Code>SignatureDoesNotMatch</Code></Error>',
      },
    ]);
    const file = writeTemp(BODY);
    await expect(target.put(file.path, 'nightly.dump.enc')).rejects.toThrow(
      /PutObject .* failed: HTTP 403 Forbidden.*SignatureDoesNotMatch/s,
    );
    file.cleanup();
  });

  it('surfaces a transport failure instead of reporting a stored copy', async () => {
    const { target } = destination({}, [new Error('ECONNREFUSED')]);
    const file = writeTemp(BODY);
    await expect(target.put(file.path, 'nightly.dump.enc')).rejects.toThrow(/ECONNREFUSED/);
    file.cleanup();
  });

  /**
   * The core non-negotiable: a 200 is not proof. If the object the destination
   * says it holds is not the object we sent, the copy did NOT happen.
   */
  it('rejects a 200 whose ETag does not match the uploaded bytes', async () => {
    const { target } = destination({}, [{ status: 200, headers: { etag: `"${'0'.repeat(32)}"` } }]);
    const file = writeTemp(BODY);
    await expect(target.put(file.path, 'nightly.dump.enc')).rejects.toThrow(
      /Upload verification failed.*Treating the copy as NOT stored/s,
    );
    file.cleanup();
  });

  it('falls back to a HEAD size check when the ETag is not an MD5 (SSE-KMS)', async () => {
    const { target, calls } = destination({ serverSideEncryption: 'aws:kms' }, [
      { status: 200, headers: { etag: '"a1b2c3-3"' } },
      { status: 200, headers: { 'content-length': String(BODY.length) } },
    ]);
    const file = writeTemp(BODY);
    const stored = await target.put(file.path, 'nightly.dump.enc');
    file.cleanup();

    expect(stored.bytes).toBe(BODY.length);
    expect(calls.map((call) => call.method)).toEqual(['PUT', 'HEAD']);
    expect(calls[0].headers['x-amz-server-side-encryption']).toBe('aws:kms');
  });

  it('fails when the HEAD fallback reports a different size', async () => {
    const { target } = destination({}, [
      { status: 200, headers: {} },
      { status: 200, headers: { 'content-length': '5' } },
    ]);
    const file = writeTemp(BODY);
    await expect(target.put(file.path, 'nightly.dump.enc')).rejects.toThrow(
      /destination holds 5 bytes, expected 23/,
    );
    file.cleanup();
  });

  it('refuses an object too large for a single PUT rather than half-uploading it', async () => {
    const { target, calls } = destination({ maxObjectBytes: 4 });
    const file = writeTemp(BODY);
    await expect(target.put(file.path, 'nightly.dump.enc')).rejects.toThrow(
      /above the 4-byte single-PUT limit/,
    );
    file.cleanup();
    expect(calls).toHaveLength(0);
  });
});

describe('S3Destination.remove', () => {
  it('deletes the object', async () => {
    const { target, calls } = destination({}, [{ status: 204 }]);
    await target.remove('s3://jkannel-backups/prod/nightly.dump.enc');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe('https://minio.internal:9000/jkannel-backups/prod/nightly.dump.enc');
  });

  it('tolerates an object that is already gone', async () => {
    const { target } = destination({}, [{ status: 404 }]);
    await expect(
      target.remove('s3://jkannel-backups/prod/nightly.dump.enc'),
    ).resolves.toBeUndefined();
  });

  it('raises a real delete failure', async () => {
    const { target } = destination({}, [{ status: 500, statusText: 'Internal Server Error' }]);
    await expect(target.remove('s3://jkannel-backups/prod/x.enc')).rejects.toThrow(
      /DeleteObject .* failed: HTTP 500/,
    );
  });

  it('ignores a URI written by a previously configured destination', async () => {
    const { target, calls } = destination({}, [{ status: 500 }]);
    await target.remove('file:///mnt/offsite/old.enc');
    await target.remove('s3://some-other-bucket/x.enc');
    expect(calls).toHaveLength(0);
  });
});

describe('parseS3Uri', () => {
  it.each([
    ['s3://bucket/key', { bucket: 'bucket', key: 'key' }],
    ['s3://bucket/a/b/c.enc', { bucket: 'bucket', key: 'a/b/c.enc' }],
  ])('parses %s', (uri, expected) => expect(parseS3Uri(uri)).toEqual(expected));

  it.each(['file:///tmp/x', 's3://bucket', 's3:///key', 's3://bucket/'])('rejects %s', (uri) =>
    expect(parseS3Uri(uri)).toBeNull(),
  );
});

// ---------------------------------------------------------------------------

function writeTemp(bytes: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'jk-s3-'));
  const path = join(dir, 'artifact.bin');
  writeFileSync(path, bytes);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
