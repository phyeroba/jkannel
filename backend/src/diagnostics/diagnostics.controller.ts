import { BadRequestException, Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { MessageTraceService } from './message-trace.service';
import { OperationalEventsService } from './operational-events.service';
import { TestToolsService } from './test-tools.service';
import { decodeSmppStatus, knownSmppStatuses } from './smpp-status';
import { MASKING_NOTICE, maskRows } from '../privacy/masking';
import { PiiRevealService } from '../privacy/pii-reveal.service';

type Request = AuthenticatedRequest;
const actor = (request: Request) => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});

/**
 * Diagnostics: message lifecycle and SMPP status decoding (spec §10, §11).
 */
@Controller('diagnostics')
@UseGuards(AuthGuard, PermissionsGuard)
export class DiagnosticsController {
  constructor(
    private readonly traces: MessageTraceService,
    private readonly events: OperationalEventsService,
    private readonly tools: TestToolsService,
    // Optional so the existing controller tests can construct it with three
    // collaborators. Absent means masked — see `reveal`.
    private readonly privacy?: PiiRevealService,
  ) {}

  /**
   * Number and prefix lookup (§15). Non-transmitting, like the route simulator.
   *
   * The response carries its own limits: there is no prefix-to-operator
   * database in this product, so the mobile network behind a number is NOT
   * identified. Guessing one from a prefix would be a fabricated fact an
   * operator would act on.
   */
  @Get('number-lookup')
  @RequirePermissions('routes.view')
  numberLookup(@Req() r: Request, @Query('msisdn') msisdn?: string) {
    if (!msisdn) throw new BadRequestException('msisdn is required');
    return this.tools.lookupNumber(actor(r), msisdn);
  }

  @Get('test-sends')
  @RequirePermissions('messages.view')
  testSends(@Req() r: Request, @Query('limit') limit?: string) {
    return this.tools.listTestSends(actor(r), limit ? Number(limit) : undefined);
  }

  /**
   * The operational event stream (§12.1) — what the SYSTEM observed, as opposed
   * to `audit-events`, which records what a person did.
   */
  @Get('events')
  @RequirePermissions('monitoring.view')
  listEvents(@Req() r: Request, @Query() query: Record<string, string> = {}) {
    // `Number('abc')` is NaN, and Math.min/max propagate it, so a junk value
    // reached PostgreSQL as `LIMIT NaN` — a 500 where a 400 belongs.
    let limit: number | undefined;
    if (query.limit !== undefined && query.limit !== '') {
      limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new BadRequestException('limit must be an integer between 1 and 500');
    }
    return this.events.list(actor(r), {
      limit,
      kindPrefix: query.kind,
      severity: query.severity,
      subjectType: query.subjectType,
      subjectId: query.subjectId,
      correlationId: query.correlationId,
      since: query.since,
    });
  }

  /**
   * Everything recorded for one incident — events, alerts and audit entries in
   * one response. Previously an operator could go audit to logs and had no path
   * from an alert to anything at all.
   */
  @Get('correlations/:correlationId')
  @RequirePermissions('monitoring.view')
  correlated(@Req() r: Request, @Param('correlationId') correlationId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(correlationId))
      throw new BadRequestException('correlationId must be a UUID');
    return this.events.correlated(actor(r), correlationId);
  }

  /**
   * The full lifecycle for one message, joining the engine's rows to the
   * routing decision and the retry chain.
   *
   * Deliberately a NEW path rather than a change to `GET /messages/:id/trace`.
   * That endpoint's contract is the raw engine event list and other things read
   * it; this one answers §10's question and returns the assembled stages, with
   * the raw events still included so the evidence is not hidden behind an
   * interpretation.
   */
  @Get('messages/:id/lifecycle')
  @RequirePermissions('messages.view')
  async lifecycle(@Req() r: Request, @Param('id') id: string, @Query() q: any = {}) {
    const clean = String(id ?? '').trim();
    if (!clean || clean.length > 128) throw new BadRequestException('id is required');
    const trace: any = await this.traces.trace(actor(r), clean);
    // `lifecycle.stages` are derived and carry no subscriber data, but `events`
    // is the raw engine rows — sender, receiver and body — and the console
    // renders them verbatim in its evidence panel. They mask like everything
    // else, scoped to this one message so a grant taken out to investigate one
    // complaint does not also unmask the grid.
    const permitted = await this.reveal(r, q, clean);
    return {
      ...trace,
      events: permitted ? trace.events : maskRows(trace.events ?? []),
      privacy: { masked: !permitted, notice: permitted ? null : MASKING_NOTICE },
    };
  }

  private async reveal(r: Request, q: any, messageRef: string): Promise<boolean> {
    // Absent service means masked. A privacy control must fail closed.
    if (!this.privacy) return false;
    const wants = q?.reveal === 'true' || q?.reveal === true;
    const result = await this.privacy.resolve(
      actor(r),
      new Set(r.principal!.permissions ?? []),
      wants,
      messageRef,
    );
    if (result.permitted && result.grant)
      await this.privacy.recordUse(actor(r), result.grant.id, 1, 'diagnostics.lifecycle');
    return result.permitted;
  }

  /**
   * The decoder table, so the console can render a reference and so an operator
   * can look up a code without leaving the product.
   */
  @Get('smpp-statuses')
  @RequirePermissions('smsc.view')
  statuses() {
    return {
      statuses: knownSmppStatuses(),
      note:
        'Guidance is a suggested check, not a diagnosis. A command status says what the carrier ' +
        'refused, never why. Codes in 0x400-0x4FF are vendor-specific and only the carrier can ' +
        'define them.',
    };
  }

  @Get('smpp-statuses/:code')
  @RequirePermissions('smsc.view')
  status(@Param('code') code: string) {
    // Accepts decimal or 0x-prefixed hex, because a carrier's documentation
    // and its logs rarely agree on which.
    const parsed = /^0x/i.test(code) ? Number.parseInt(code, 16) : Number(code);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff)
      throw new BadRequestException('code must be a 32-bit integer, decimal or 0x-prefixed hex');
    return decodeSmppStatus(parsed);
  }
}
