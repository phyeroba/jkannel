import { BadRequestException } from '@nestjs/common';
import { ReadModelsController } from './console.controllers';
import { SEGMENT_LIMITS } from '../engine/message-segments';

const request: any = { principal: { tenantId: '7', userId: 'user-1', username: 'ops' } };

function makeController(overrides: { list?: any; exportCsv?: any } = {}) {
  const sqlbox: any = {
    probe: jest.fn().mockResolvedValue({ available: true }),
    list: overrides.list ?? jest.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 }),
    exportCsv:
      overrides.exportCsv ??
      jest.fn().mockResolvedValue({
        filename: 'reports.csv',
        rowCount: 0,
        nextCursor: null,
        content: 'id\r\n',
      }),
  };
  const repository: any = {
    listTenantSmscEngineIds: jest.fn().mockResolvedValue(['carrier-a', 'carrier-b']),
  };
  return {
    sqlbox,
    repository,
    controller: new ReadModelsController(sqlbox, undefined, repository),
  };
}

function makeResponse() {
  const response: any = {
    headers: {} as Record<string, string>,
    setHeader: jest.fn((key: string, value: string) => {
      response.headers[key] = value;
    }),
    send: jest.fn(),
  };
  return response;
}

// ===========================================================================
// Segment preview
// ===========================================================================
describe('segment preview endpoint', () => {
  const { controller } = makeController();

  it('reports one segment at the GSM-7 boundary and two just past it', () => {
    expect(controller.previewMessage({ text: 'a'.repeat(160) })).toMatchObject({
      alphabet: 'gsm7',
      segments: 1,
      characters: 160,
      perSegment: 160,
      remaining: 0,
    });
    expect(controller.previewMessage({ text: 'a'.repeat(161) })).toMatchObject({
      segments: 2,
      perSegment: 153,
      // 161 septets across two 153-septet parts: 153 + 8, so 145 free in part 2.
      remaining: 145,
    });
  });

  it('reports the 153-septet concatenated boundary', () => {
    expect(controller.previewMessage({ text: 'a'.repeat(306) }).segments).toBe(2);
    expect(controller.previewMessage({ text: 'a'.repeat(307) }).segments).toBe(3);
  });

  it('reports one segment at the UCS-2 boundary and two just past it', () => {
    expect(controller.previewMessage({ text: 'あ'.repeat(70) })).toMatchObject({
      alphabet: 'ucs2',
      segments: 1,
      perSegment: 70,
      remaining: 0,
    });
    expect(controller.previewMessage({ text: 'あ'.repeat(71) })).toMatchObject({
      segments: 2,
      perSegment: 67,
      remaining: 63,
    });
  });

  it('reports the 67-unit concatenated UCS-2 boundary', () => {
    expect(controller.previewMessage({ text: 'あ'.repeat(134) }).segments).toBe(2);
    expect(controller.previewMessage({ text: 'あ'.repeat(135) }).segments).toBe(3);
  });

  it('charges a GSM-7 extension character two septets', () => {
    // 159 plain + one '€' (ESC + code) = 161 septets, so it splits.
    expect(controller.previewMessage({ text: `${'a'.repeat(159)}€` })).toMatchObject({
      alphabet: 'gsm7',
      length: 161,
      segments: 2,
    });
  });

  it('counts an astral character as one character but two UCS-2 units', () => {
    const preview = controller.previewMessage({ text: '🙂' });
    expect(preview.characters).toBe(1);
    expect(preview.length).toBe(2);
    expect(preview.alphabet).toBe('ucs2');
  });

  it('takes a stored UDH off every segment’s payload', () => {
    // UDHL=5, IEI=00 (8-bit concat), len=03, ref=aa, total=03, seq=01.
    const preview = controller.previewMessage({
      text: 'part one',
      coding: 0,
      udhData: '050003aa0301',
    });
    expect(preview.udhOctets).toBe(6);
    expect(preview.singleCapacity).toBe(153);
    // The UDH DECLARED three parts; that is authoritative, not re-derived.
    expect(preview).toMatchObject({ segments: 3, declaredByUdh: true });
  });

  it('answers on the GET form as well, and publishes the boundary table', () => {
    const preview = controller.segmentsForQuery({ text: 'hello' });
    expect(preview).toMatchObject({ segments: 1, characters: 5, remaining: 155 });
    // Returned so the client-side mirror bootstraps its boundaries from the
    // server instead of hard-coding a second copy of them.
    expect(preview.limits).toEqual(SEGMENT_LIMITS);
    expect(preview.limits.gsm7).toEqual({ single: 160, multipart: 153 });
    expect(preview.limits.ucs2).toEqual({ single: 70, multipart: 67 });
    // Aliased under the console mirror's own field names too, so a component
    // can swap between the local computation and this response.
    expect(preview.currentCapacity).toBe(preview.perSegment);
    expect(preview.remainingInSegment).toBe(preview.remaining);
  });

  it('treats an absent body as an empty message rather than an error', () => {
    expect(controller.segmentsForQuery({})).toMatchObject({
      characters: 0,
      segments: 1,
      remaining: 160,
    });
  });

  it('rejects a non-string body and an absurdly long one', () => {
    expect(() => controller.previewMessage({ text: 42 })).toThrow(BadRequestException);
    expect(() => controller.previewMessage({ text: 'a'.repeat(5001) })).toThrow(
      BadRequestException,
    );
  });
});

// ===========================================================================
// Delivery reports
// ===========================================================================
describe('delivery report grid', () => {
  it('asks the repository for decoded receipt statuses, pinned to DLR rows', async () => {
    const { controller, sqlbox } = makeController();
    await controller.reports(request, { status: 'failed' });
    expect(sqlbox.list).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryReport: true,
        direction: 'DLR',
        status: 'failed',
        allowedSmscIds: ['carrier-a', 'carrier-b'],
      }),
    );
  });

  it('accepts the whole messages-grid filter vocabulary, groups included', async () => {
    const { controller, sqlbox } = makeController();
    await controller.reports(request, {
      deliveryStatus: 'resendable',
      smscId: 'carrier-a',
      query: '2567',
      from: '2026-08-01',
      to: '2026-08-05T23:59:59Z',
      sort: '-time',
      limit: '25',
      offset: '50',
    });
    expect(sqlbox.list).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryStatus: 'resendable',
        smscId: 'carrier-a',
        query: '2567',
        fromEpoch: Math.floor(Date.parse('2026-08-01T00:00:00Z') / 1000),
        toEpoch: Math.floor(Date.parse('2026-08-05T23:59:59Z') / 1000),
        sort: '-time',
        limit: 25,
        offset: 50,
      }),
    );
  });

  it('rejects an unknown status and an unknown sort field with a 400', async () => {
    const { controller } = makeController();
    await expect(controller.reports(request, { status: 'faield' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.reports(request, { sort: 'msgdata' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('validates the filters before probing, so a bad filter is a 400 either way', async () => {
    const { controller, sqlbox } = makeController();
    sqlbox.probe = jest.fn().mockResolvedValue({ available: false, evidence: 'not configured' });
    await expect(controller.reports(request, { from: 'yesterday' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('states an unavailable SQLBox rather than presenting an empty report as real', async () => {
    const { controller, sqlbox } = makeController();
    sqlbox.probe = jest.fn().mockResolvedValue({ available: false, evidence: 'not configured' });
    const result: any = await controller.reports(request, {});
    expect(result.source).toMatchObject({ status: 'unavailable', code: 'SQLBOX_NOT_AVAILABLE' });
    expect(sqlbox.list).not.toHaveBeenCalled();
  });
});

describe('delivery report export parity', () => {
  /**
   * The defect this pins: an operator filters the grid to "failed", clicks
   * Export, and gets a file containing everything. Both routes are made to
   * build their options through ONE method, so the only way they can diverge is
   * if someone deletes that method — which this test would catch.
   */
  it('exports EXACTLY the option set the grid was asked for', async () => {
    const { controller, sqlbox } = makeController();
    const query = {
      deliveryStatus: 'failed,rejected',
      smscId: 'carrier-a',
      query: 'ref-4',
      from: '2026-08-01T00:00:00Z',
      to: '2026-08-04T00:00:00Z',
      direction: 'MT',
      sort: '-time',
      // Explicit so both routes resolve the same limit; the grid and the export
      // differ only in what they DEFAULT to when the caller names no limit.
      limit: '25',
      offset: '10',
    };

    await controller.reports(request, { ...query });
    await controller.deliveryExport(request, { ...query }, makeResponse());

    expect(sqlbox.list).toHaveBeenCalledTimes(1);
    expect(sqlbox.exportCsv).toHaveBeenCalledTimes(1);
    // `reveal` is the privacy decision, not a filter, so it is compared on its
    // own terms below rather than folded into the filter-parity contract.
    const { reveal, ...exportOptions } = sqlbox.exportCsv.mock.calls[0][0];
    expect(exportOptions).toEqual(sqlbox.list.mock.calls[0][0]);
    // The export must never be less masked than the screen it came from.
    expect(reveal).toBe(false);
    // And the pinned values really are pinned, not merely equal-and-wrong.
    expect(sqlbox.exportCsv.mock.calls[0][0]).toMatchObject({
      deliveryReport: true,
      direction: 'DLR',
      deliveryStatus: 'failed,rejected',
      sort: '-time',
      offset: 10,
    });
  });

  it('refuses an unhonourable filter on the export too, instead of widening it', async () => {
    const { controller, sqlbox } = makeController();
    await expect(
      controller.deliveryExport(request, { status: 'faield' }, makeResponse()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sqlbox.exportCsv).not.toHaveBeenCalled();
  });

  it('emits the applied filter set as a header so the file can be traced back', async () => {
    const { controller } = makeController();
    const response = makeResponse();
    await controller.deliveryExport(
      request,
      { status: 'delivered', smscId: 'carrier-a' },
      response,
    );
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['x-jkannel-export-filters']).toContain('status=delivered');
    expect(response.headers['x-jkannel-export-filters']).toContain('smscId=carrier-a');
  });

  it('says so in the headers when SQLBox is unavailable, with a real header row', async () => {
    const { controller, sqlbox } = makeController();
    sqlbox.probe = jest.fn().mockResolvedValue({ available: false, evidence: 'not configured' });
    const response = makeResponse();
    await controller.deliveryExport(request, {}, response);
    // An empty file would read as "no matching receipts", which is a different
    // and materially misleading statement.
    expect(response.headers['x-jkannel-source-status']).toBe('unavailable');
    expect(response.headers['x-jkannel-export-row-count']).toBe('0');
  });
});

// ===========================================================================
// Scheduled single send
// ===========================================================================
describe('POST /messages scheduling', () => {
  /**
   * `POST /messages` now goes through ScheduledSendService, which decides
   * between sending immediately and holding until `scheduledAt`. The controller
   * still owns parsing and validation, so that is what this block asserts; the
   * hold-vs-send decision itself is covered in scheduled-send.service.spec.ts.
   */
  function makeSubmitController() {
    const scheduling: any = { submitMessage: jest.fn().mockResolvedValue({ sqlId: '1' }) };
    const repository: any = { listTenantSmscEngineIds: jest.fn().mockResolvedValue(['carrier-a']) };
    return {
      send: scheduling,
      controller: new ReadModelsController(
        {} as any,
        undefined,
        repository,
        undefined,
        undefined,
        scheduling,
      ),
    };
  }
  const body = { sender: 'ACME', receiver: '+256700000000', text: 'hello' };

  it('passes a validated schedule down to the send path', async () => {
    const { controller, send } = makeSubmitController();
    // Whole seconds: the schedule is resolved to a minute offset on the engine
    // row, so sub-second precision is deliberately not carried.
    const scheduledAt = new Date(Math.ceil((Date.now() + 3_600_000) / 1000) * 1000).toISOString();
    await controller.submit(request, { ...body, scheduledAt, validityMinutes: 120 });
    expect(send.submitMessage).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'user-1' },
      expect.objectContaining({
        schedule: { scheduledAtMs: Date.parse(scheduledAt), validityMinutes: 120 },
      }),
    );
  });

  it('rejects a past scheduledAt before anything is submitted', async () => {
    const { controller, send } = makeSubmitController();
    await expect(
      controller.submit(request, { ...body, scheduledAt: '2020-01-01T00:00:00Z' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(send.submitMessage).not.toHaveBeenCalled();
  });

  it('rejects a validity that expires before the scheduled time', async () => {
    const { controller, send } = makeSubmitController();
    await expect(
      controller.submit(request, {
        ...body,
        scheduledAt: new Date(Date.now() + 7_200_000).toISOString(),
        validityMinutes: 30,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(send.submitMessage).not.toHaveBeenCalled();
  });

  it('sends immediately, with an empty schedule, when none is given', async () => {
    const { controller, send } = makeSubmitController();
    await controller.submit(request, body);
    expect(send.submitMessage.mock.calls[0][1].schedule).toEqual({
      scheduledAtMs: null,
      validityMinutes: null,
    });
  });
});
