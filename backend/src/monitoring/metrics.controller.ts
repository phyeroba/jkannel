import { Controller, Get, Res } from '@nestjs/common';
import { HealthService } from '../health/health.service';
import { MetricsRegistry } from './metrics.registry';

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly health: HealthService,
    private readonly registry?: MetricsRegistry,
  ) {}

  @Get()
  metrics(
    @Res() response: { setHeader(name: string, value: string): void; send(body: string): void },
  ): void {
    const memory = process.memoryUsage();
    const status = this.health.getStatus();
    const lines = [
      '# HELP jkannel_backend_up Backend health status as a boolean gauge.',
      '# TYPE jkannel_backend_up gauge',
      `jkannel_backend_up{service="${status.service}",status="${status.status}"} 1`,
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
    response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    response.send(`${lines.join('\n')}\n`);
  }
}
