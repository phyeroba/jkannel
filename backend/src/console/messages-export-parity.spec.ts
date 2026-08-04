import { BadRequestException } from '@nestjs/common';
import { ReadModelsController } from './console.controllers';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';

/**
 * THE point of gap G13's export fix: an export must contain the rows the grid is
 * showing. Previously `exportMessages` forwarded only query/smscId/direction, so
 * an operator filtered to "failed" exported everything and had no way to tell.
 *
 * These tests assert the property structurally — the SAME query parameters must
 * produce the SAME repository options for the grid, the CSV and the PDF — which
 * is what makes the guarantee hold for filters that do not exist yet.
 */

const request: any = {
  principal: { tenantId: '7', userId: 'user-1', username: 'op' },
};

function makeController() {
  const listed: any[] = [];
  const exported: any[] = [];
  const sqlbox: any = {
    probe: jest.fn().mockResolvedValue({ available: true }),
    list: jest.fn(async (options: any) => {
      listed.push(options);
      return { items: [{ id: '1', deliveryStatus: 'failed' }], nextCursor: null };
    }),
    exportCsv: jest.fn(async (options: any) => {
      exported.push(options);
      return {
        filename: 'messages.csv',
        rowCount: 1,
        nextCursor: null,
        content: `${KamexSqlboxRepository.EXPORT_COLUMNS.join(',')}\r\n"1"`,
      };
    }),
  };
  const repository: any = {
    listTenantSmscEngineIds: jest.fn().mockResolvedValue(['carrier-a', 'carrier-b']),
  };
  const exporter: any = { toPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')) };
  const controller = new ReadModelsController(sqlbox, undefined, repository, exporter);
  return { controller, sqlbox, repository, exporter, listed, exported };
}

function makeResponse() {
  const response: any = {
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader: jest.fn((key: string, value: string) => {
      response.headers[key] = value;
    }),
    send: jest.fn((body: unknown) => {
      response.body = body;
    }),
  };
  return response;
}

/** Every filter the contract names, in one query. */
const fullQuery = {
  query: '256700',
  smscId: 'carrier-a',
  direction: 'MT',
  status: 'failed',
  from: '2026-08-04T09:00:00Z',
  to: '2026-08-04T10:00:00Z',
  limit: '25',
};

describe('the export honours exactly the filters the grid does', () => {
  it('sends the CSV export the same filter set as the grid, tenant scope included', async () => {
    const { controller, listed, exported } = makeController();

    await controller.messages(request, { ...fullQuery });
    await controller.exportMessages(request, { ...fullQuery }, makeResponse());

    // Everything except the paging limit must be byte-identical.
    const { limit: gridLimit, ...grid } = listed[0];
    const { limit: exportLimit, ...csv } = exported[0];
    expect(csv).toEqual(grid);
    expect(gridLimit).toBe(25);
    expect(exportLimit).toBe(25);
  });

  it('sends the PDF export the same filter set as the grid', async () => {
    const { controller, listed } = makeController();

    await controller.messages(request, { ...fullQuery });
    await controller.exportMessagesPdf(request, { ...fullQuery }, makeResponse());

    expect(listed).toHaveLength(2);
    expect(listed[1]).toEqual(listed[0]);
  });

  it('actually carries the status filter the old export dropped', async () => {
    const { controller, exported } = makeController();
    await controller.exportMessages(request, { status: 'failed' }, makeResponse());
    expect(exported[0].status).toBe('failed');
  });

  it('actually carries the date range', async () => {
    const { controller, exported } = makeController();
    await controller.exportMessages(
      request,
      { from: '2026-08-04T09:00:00Z', to: '2026-08-04T10:00:00Z' },
      makeResponse(),
    );
    expect(exported[0].fromEpoch).toBe(Math.floor(Date.parse('2026-08-04T09:00:00Z') / 1000));
    expect(exported[0].toEpoch).toBe(Math.floor(Date.parse('2026-08-04T10:00:00Z') / 1000));
  });

  it('keeps the tenant SMSC scope on every one of the three reads', async () => {
    const { controller, listed, exported } = makeController();
    await controller.messages(request, {});
    await controller.exportMessages(request, {}, makeResponse());
    await controller.exportMessagesPdf(request, {}, makeResponse());

    for (const options of [...listed, ...exported])
      expect(options.allowedSmscIds).toEqual(['carrier-a', 'carrier-b']);
  });
});

describe('a filter that cannot be honoured FAILS the export, it does not widen it', () => {
  it.each([
    ['an inverted range', { from: '2026-08-04T10:00:00Z', to: '2026-08-04T09:00:00Z' }],
    ['an unparseable date', { from: 'last tuesday' }],
    ['an unknown status', { status: 'faield' }],
    ['an unknown direction', { direction: 'sideways' }],
  ])('rejects %s on the grid, the CSV and the PDF alike', async (_label, query) => {
    const { controller, sqlbox } = makeController();

    await expect(controller.messages(request, query)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.exportMessages(request, query, makeResponse())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controller.exportMessagesPdf(request, query, makeResponse()),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Nothing was read, so no partially filtered file could have been streamed.
    expect(sqlbox.list).not.toHaveBeenCalled();
    expect(sqlbox.exportCsv).not.toHaveBeenCalled();
  });

  it('validates before probing, so a bad range 400s even when SQLBox is down', async () => {
    const { controller, sqlbox } = makeController();
    sqlbox.probe.mockResolvedValue({ available: false, evidence: 'not configured' });

    await expect(
      controller.exportMessages(request, { from: 'nonsense' }, makeResponse()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sqlbox.probe).not.toHaveBeenCalled();
  });
});

describe('the export says what it is', () => {
  it('labels an unavailable source instead of letting an empty file read as "no matches"', async () => {
    const { controller, sqlbox } = makeController();
    sqlbox.probe.mockResolvedValue({ available: false, evidence: 'SQLBox tables absent' });
    const response = makeResponse();

    await controller.exportMessages(request, {}, response);

    expect(response.headers['x-jkannel-source-status']).toBe('unavailable');
    expect(response.headers['x-jkannel-export-row-count']).toBe('0');
    // The header row must be the one a real export would have produced.
    expect(response.body).toBe(KamexSqlboxRepository.exportHeaderRow());
  });

  it('records the applied filter set on the response', async () => {
    const { controller } = makeController();
    const response = makeResponse();
    await controller.exportMessages(request, { ...fullQuery }, response);

    expect(response.headers['x-jkannel-source-status']).toBe('available');
    expect(response.headers['x-jkannel-export-filters']).toContain('status=failed');
    expect(response.headers['x-jkannel-export-filters']).toContain('from=2026-08-04T09:00:00.000Z');
  });

  it('echoes the applied filters on the grid so the two can be compared', async () => {
    const { controller } = makeController();
    const page: any = await controller.messages(request, { ...fullQuery });
    expect(page.filters).toMatchObject({ status: 'failed', direction: 'MT', smscId: 'carrier-a' });
    expect(page.filters.description).toContain('status=failed');
  });
});
