import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { DlrPerformanceService } from './dlr-performance.service';

type Request = AuthenticatedRequest;
const actor = (request: Request) => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});

const MAX_WINDOW_DAYS = 90;

/**
 * DLR performance over an explicit window (spec §8).
 *
 * The window is a REQUIRED pair of instants rather than a `days` count, which
 * is what makes §8's "compare carriers/SMSCs over identical time windows"
 * possible. The existing analytics endpoints read the latest daily snapshot and
 * take no window at all, so two carriers could only be compared over whichever
 * period each happened to have been summarised on.
 */
@Controller('reports/dlr-performance')
@UseGuards(AuthGuard, PermissionsGuard)
export class DlrPerformanceController {
  constructor(private readonly performance: DlrPerformanceService) {}

  @Get()
  @RequirePermissions('reports.view')
  report(@Req() r: Request, @Query('from') from?: string, @Query('to') to?: string) {
    const toMs = parseInstant(to, 'to') ?? Date.now();
    const fromMs = parseInstant(from, 'from') ?? toMs - 24 * 3600_000;
    if (fromMs >= toMs) throw new BadRequestException('from must be earlier than to');
    if (toMs - fromMs > MAX_WINDOW_DAYS * 86_400_000)
      throw new BadRequestException(`window must be at most ${MAX_WINDOW_DAYS} days`);
    return this.performance.report(actor(r), fromMs, toMs);
  }
}

function parseInstant(value: string | undefined, name: string): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new BadRequestException(`${name} must be an ISO 8601 instant`);
  return parsed;
}
