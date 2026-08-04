import { Controller, Get, Optional, Res } from '@nestjs/common';
import { HealthService } from '../health/health.service';
import { MetricsRegistry } from './metrics.registry';
import { PlatformMetricsService } from '../monitoring-depth/platform-metrics.service';
import { EngineMetricsService } from '../monitoring-depth/engine-metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly health: HealthService,
    @Optional() private readonly registry?: MetricsRegistry,
    // Optional so /metrics keeps working before MonitoringDepthModule is wired.
    // When present, platform/DB/Redis gauges are appended to the scrape output.
    @Optional() private readonly platform?: PlatformMetricsService,
    // SMS/SMSC telemetry, served from the poller's cached snapshot so the
    // scrape never calls the engine synchronously.
    @Optional() private readonly engine?: EngineMetricsService,
  ) {}

  @Get()
  async metrics(
    @Res() response: { setHeader(name: string, value: string): void; send(body: string): void },
  ): Promise<void> {
    const memory = process.memoryUsage();
    // Real probe (bounded by HealthService's per-dependency timeout), so the
    // gauge reports 0 when the process cannot reach a required dependency
    // instead of always claiming 1.
    const status = await this.health.check();
    const lines = [
      '# HELP jkannel_backend_up Backend health status as a boolean gauge.',
      '# TYPE jkannel_backend_up gauge',
      `jkannel_backend_up{service="${status.service}",status="${status.status}"} ${
        status.status === 'unhealthy' ? 0 : 1
      }`,
      '# HELP jkannel_backend_uptime_seconds Node.js process uptime in seconds.',
      '# TYPE jkannel_backend_uptime_seconds gauge',
      `jkannel_backend_uptime_seconds ${process.uptime().toFixed(3)}`,
      '# HELP jkannel_backend_memory_bytes Node.js process memory usage by kind.',
      '# TYPE jkannel_backend_memory_bytes gauge',
      `jkannel_backend_memory_bytes{kind="rss"} ${memory.rss}`,
      `jkannel_backend_memory_bytes{kind="heap_total"} ${memory.heapTotal}`,
      `jkannel_backend_memory_bytes{kind="heap_used"} ${memory.heapUsed}`,
      `jkannel_backend_memory_bytes{kind="external"} ${memory.external}`,
    ];
    if (this.registry) lines.push(this.registry.render());
    // Never let a slow/unreachable dependency fail the scrape; render() itself
    // degrades to *_up 0 gauges. When platform is absent no await runs, so the
    // handler stays synchronous for the base metrics.
    if (this.platform) {
      try {
        lines.push(await this.platform.render());
      } catch {
        /* platform metrics are best-effort */
      }
    }
    if (this.engine) {
      try {
        // Pure in-memory render; kept in a try so a future change here can
        // never take the scrape down.
        lines.push(this.engine.render());
      } catch {
        /* engine metrics are best-effort */
      }
    }
    response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    response.send(`${lines.join('\n')}\n`);
  }
}
