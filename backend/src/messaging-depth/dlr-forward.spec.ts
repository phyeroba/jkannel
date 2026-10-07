import { DlrForwardService } from './dlr-forward.service';

/**
 * The allowlist is the part of this component that must not be wrong.
 *
 * `dlr_url` is attacker-controllable: anyone who can submit a message can put
 * any URL in it. A worker that fetches whatever it finds in that column, from
 * inside the private network, is a server-side request forgery engine with a
 * job queue in front of it. These tests are the guard on that.
 */
describe('DLR forwarding — the allowlist', () => {
  const service = new DlrForwardService({} as never, {} as never, {} as never);
  const withHosts = (value: string | undefined, run: () => void) => {
    const previous = process.env.DLR_FORWARD_ALLOWED_HOSTS;
    if (value === undefined) delete process.env.DLR_FORWARD_ALLOWED_HOSTS;
    else process.env.DLR_FORWARD_ALLOWED_HOSTS = value;
    try {
      run();
    } finally {
      if (previous === undefined) delete process.env.DLR_FORWARD_ALLOWED_HOSTS;
      else process.env.DLR_FORWARD_ALLOWED_HOSTS = previous;
    }
  };

  it('fails CLOSED when the allowlist is unset', () => {
    withHosts(undefined, () => {
      expect(service.isAllowed('https://app.speedamobile.com/x').allowed).toBe(false);
    });
  });

  it('fails closed when the allowlist is empty', () => {
    withHosts('   ', () => {
      expect(service.isAllowed('https://app.speedamobile.com/x').allowed).toBe(false);
    });
  });

  it('allows an exact host that is listed', () => {
    withHosts('app.speedamobile.com', () => {
      expect(service.isAllowed('https://app.speedamobile.com/msg/v1/x?dlr=%d').allowed).toBe(true);
    });
  });

  it('does not accept a host that merely ends with a listed one', () => {
    // The whole point: `endsWith` would let this through.
    withHosts('speedamobile.com', () => {
      const verdict = service.isAllowed('https://speedamobile.com.attacker.test/x');
      expect(verdict.allowed).toBe(false);
    });
  });

  it('refuses the private network even when something is listed', () => {
    withHosts('app.speedamobile.com', () => {
      for (const url of [
        'http://169.254.169.254/latest/meta-data/',
        'http://postgres:5432/',
        'https://10.0.0.5/internal',
        'http://localhost/admin',
      ])
        expect(service.isAllowed(url).allowed).toBe(false);
    });
  });

  it('refuses plain http even for a listed host, because the URL carries a token', () => {
    withHosts('app.speedamobile.com', () => {
      const verdict = service.isAllowed('http://app.speedamobile.com/x?t=secret');
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain('https only');
    });
  });

  it('refuses a value that is not a URL at all', () => {
    withHosts('app.speedamobile.com', () => {
      expect(service.isAllowed('not a url').allowed).toBe(false);
    });
  });
});

describe('DLR forwarding — the substitution', () => {
  const service = new DlrForwardService({} as never, {} as never, {} as never);

  it('replaces %d with the receipt type and touches nothing else', () => {
    const url =
      'https://app.speedamobile.com/msg/v1/webhooks/dlr/jkannel/msg_01ABC?dlr=%d&t=7beb13c0';
    expect(service.substituteMask(url, 8)).toBe(
      'https://app.speedamobile.com/msg/v1/webhooks/dlr/jkannel/msg_01ABC?dlr=8&t=7beb13c0',
    );
  });

  it('leaves the token byte-for-byte, because it is an HMAC over the URL', () => {
    const token = 'A%2Bb-c_d.e~f';
    const out = service.substituteMask(`https://h/x?dlr=%d&t=${token}`, 1);
    // Re-encoding `%2B` to `%252B` or decoding it to `+` would break every
    // signature check at the far end.
    expect(out).toContain(`t=${token}`);
  });

  it('writes a 0 rather than leaving %d literal when the mask is missing', () => {
    expect(service.substituteMask('https://h/x?dlr=%d', null)).toBe('https://h/x?dlr=0');
  });
});

describe('DLR forwarding — what reaches the log', () => {
  it('masks the token', () => {
    const url = 'https://app.speedamobile.com/x?dlr=8&t=7beb13c09534a2960ef4f2924b95d50b';
    const redacted = DlrForwardService.redact(url);
    expect(redacted).toContain('t=***');
    expect(redacted).not.toContain('7beb13c0');
    // Everything that is not the credential stays readable.
    expect(redacted).toContain('dlr=8');
  });
});

/**
 * The poll chain. MO lost its chain once by not excluding the running job
 * from its own in-flight check; this is the same trap and the same guard.
 */
describe('DLR forwarding — the poll chain', () => {
  const makeService = (inFlightRows: unknown[]) => {
    const created: unknown[] = [];
    const client = {
      query: jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: inFlightRows })),
    };
    const database = {
      tenantTransaction: async (_tenant: string, run: (c: unknown) => unknown) => run(client),
    };
    const jobs = { createOn: jest.fn(async (_c, _a, value) => created.push(value)) };
    return {
      service: new DlrForwardService(database as never, {} as never, jobs as never),
      client,
      jobs,
      created,
    };
  };

  it('excludes the running job from its own in-flight check', async () => {
    const { service, client, jobs } = makeService([]);
    await service.ensurePollScheduled(client as never, { tenantId: '1', userId: 'u' }, 30, 'job-1');
    // Without the exclusion the sweep sees ITSELF as in-flight (the worker
    // marks it running before calling the handler) and schedules nothing.
    expect(client.query.mock.calls[0][1]).toEqual(['dlr.forward.poll', 'job-1']);
    expect(jobs.createOn).toHaveBeenCalled();
  });

  it('does not start a second chain when one is already queued', async () => {
    const { service, jobs, client } = makeService([{ '?column?': 1 }]);
    const scheduled = await service.ensurePollScheduled(
      client as never,
      { tenantId: '1', userId: 'u' },
      30,
      null,
    );
    expect(scheduled).toBe(false);
    expect(jobs.createOn).not.toHaveBeenCalled();
  });

  it('does not sweep at all while nothing is allowlisted', async () => {
    const previous = process.env.DLR_FORWARD_ALLOWED_HOSTS;
    delete process.env.DLR_FORWARD_ALLOWED_HOSTS;
    try {
      const { service, jobs } = makeService([]);
      const outcome = await service.runScheduledSweep({ tenantId: '1', userId: 'u' }, 'job-1');
      // A poll every thirty seconds that can only ever refuse is noise.
      expect(outcome).toEqual({
        skipped: true,
        reason: 'DLR_FORWARD_ALLOWED_HOSTS is empty',
      });
      expect(jobs.createOn).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) process.env.DLR_FORWARD_ALLOWED_HOSTS = previous;
    }
  });
});
