import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { GatewayPerformanceService } from './gateway-performance.service';

type Request = AuthenticatedRequest;

const actor = (request: Request) => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});

/**
 * Gateway performance (spec §14, §18).
 *
 * Gated on `smsc.view` rather than a new permission: every figure here is an
 * aggregate of per-SMSC throughput that the holder can already read one
 * connection at a time. A separate grant would only mean an operator who can
 * see each bind cannot see their sum.
 *
 * An out-of-range `minutes` is clamped rather than rejected. This is a chart
 * range on a dashboard, not a command — a 400 on a dropdown the console itself
 * populated would be a defect the operator cannot act on, and the clamped
 * window is echoed in the response so the caller can see what was served.
 */
@Controller('performance')
@UseGuards(AuthGuard, PermissionsGuard)
export class GatewayPerformanceController {
  constructor(private readonly performance: GatewayPerformanceService) {}

  /**
   * `carrierId` narrows every figure to one carrier's connections, which is
   * what Carrier Detail asks for. Same endpoint rather than a second one: the
   * per-poll summing rule is subtle enough that two implementations of it would
   * drift, and the only difference between the two questions is a predicate.
   */
  @Get('throughput')
  @RequirePermissions('smsc.view')
  throughput(
    @Req() r: Request,
    @Query('minutes') minutes?: string,
    @Query('carrierId') carrierId?: string,
  ) {
    return this.performance.throughput(actor(r), minutes, carrierId);
  }
}
