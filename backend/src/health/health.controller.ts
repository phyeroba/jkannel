import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { HealthService, HealthStatus } from './health.service';

/** Minimal slice of the framework response object this controller needs. */
interface StatusResponse {
  status(code: number): unknown;
}

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Probes every dependency and maps the result onto HTTP so infrastructure can
   * act on it: 200 for `ok` and `degraded` (the instance can still serve), 503
   * for `unhealthy` (load balancers eject it, the watchdog restarts it).
   *
   * `passthrough: true` keeps the global response envelope and exception filter
   * in play — the 503 still carries the full per-dependency body rather than the
   * generic "An internal error occurred" a thrown HttpException would produce.
   */
  @Get()
  async getHealth(@Res({ passthrough: true }) response: StatusResponse): Promise<HealthStatus> {
    const health = await this.healthService.check();
    response.status(health.status === 'unhealthy' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK);
    return health;
  }
}
