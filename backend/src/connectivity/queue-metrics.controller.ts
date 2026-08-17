import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { QueueMetricsService } from './queue-metrics.service';

type Request = AuthenticatedRequest;
const actor = (request: Request) => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});

/**
 * Queue rates per destination (spec §7).
 *
 * Separate from the existing `GET /queues`, which lists the individual spooled
 * MESSAGES. This answers the different question §7 asks — how fast is each
 * queue filling and emptying, and when will it clear — and deliberately carries
 * its own honesty notes about which tier of queue is being described.
 */
@Controller('queue-metrics')
@UseGuards(AuthGuard, PermissionsGuard)
export class QueueMetricsController {
  constructor(private readonly metrics: QueueMetricsService) {}

  @Get()
  @RequirePermissions('messages.view')
  overview(@Req() r: Request, @Query('windowMinutes') windowMinutes?: string) {
    let window: number | undefined;
    if (windowMinutes !== undefined && windowMinutes !== '') {
      window = Number(windowMinutes);
      if (!Number.isInteger(window) || window < 1 || window > 1440)
        throw new BadRequestException('windowMinutes must be an integer between 1 and 1440');
    }
    return this.metrics.overview(actor(r), window);
  }
}
