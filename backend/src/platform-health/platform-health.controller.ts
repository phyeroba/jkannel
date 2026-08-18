import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { ServiceHealthService } from './service-health.service';
import { ResourceService } from './resource.service';
import { NOT_MEASURED } from './resource-usage';

/**
 * The services board and the node view (spec §14).
 */
@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class PlatformHealthController {
  constructor(
    private readonly services: ServiceHealthService,
    private readonly resources: ResourceService,
  ) {}

  /** UC-SYS-01: every component, its state, and what explains it. */
  @Get('services')
  @RequirePermissions('system.view')
  board() {
    return this.services.board();
  }

  @Get('services/:name')
  @RequirePermissions('system.view')
  async service(@Param('name') name: string) {
    const found = await this.services.service(String(name ?? '').trim());
    if (!found) throw new NotFoundException(`No component named "${name}" is in the register.`);
    return found;
  }

  /**
   * Resource pressure — deliberately singular.
   *
   * The specification asks for a Nodes table with several hosts. JKANNEL has no
   * node inventory, no host agent and no Docker socket, so every column of that
   * table would be invented. This returns the one node it can actually
   * measure — the container this process runs in — and carries `notMeasured` so
   * the console can render the gap as content rather than as a table that
   * quietly has fewer rows than the operator expects.
   */
  @Get('nodes')
  @RequirePermissions('system.view')
  async nodes() {
    const snapshot = await this.resources.snapshot();
    return {
      items: [
        { name: 'jkannel-backend', role: 'API and console backend', ...snapshot },
      ],
      // Stated at the top level too, so a caller reading only the envelope
      // cannot mistake one row for a complete inventory.
      inventoryComplete: false,
      inventoryLimit:
        'This is the only node JKANNEL can measure. There is no node inventory and no host agent, so other hosts running gateway components are not listed — absent, not healthy.',
      notMeasured: NOT_MEASURED,
      observedAt: snapshot.observedAt,
    };
  }
}
