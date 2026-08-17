import { BadRequestException, Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { MessageTraceService } from './message-trace.service';
import { decodeSmppStatus, knownSmppStatuses } from './smpp-status';

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
  constructor(private readonly traces: MessageTraceService) {}

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
  lifecycle(@Req() r: Request, @Param('id') id: string) {
    const clean = String(id ?? '').trim();
    if (!clean || clean.length > 128) throw new BadRequestException('id is required');
    return this.traces.trace(actor(r), clean);
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
