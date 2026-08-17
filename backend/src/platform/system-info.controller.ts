import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../security/auth.guard';
import { SystemInfoService } from './system-info.service';
import { TelemetryFreshnessService } from './telemetry-freshness.service';

/**
 * The two facts the console shell needs on every screen, and had no source for.
 *
 * Spec §2.1 requires a persistent environment indicator and a live-data
 * indicator. Both are read by the shell on every page, so they are one endpoint
 * rather than two — the shell should not need two round trips to draw its
 * chrome.
 *
 * Authenticated but carries NO permission requirement, on purpose. Every
 * signed-in user sees the shell, so gating this would blank the environment chip
 * for exactly the junior operator most likely to mistake DR for production. It
 * exposes no operational data: a version string, a designation, and how old our
 * last engine reading is.
 */
@Controller('system')
@UseGuards(AuthGuard)
export class SystemInfoController {
  constructor(
    private readonly system: SystemInfoService,
    private readonly freshness: TelemetryFreshnessService,
  ) {}

  @Get('info')
  info() {
    return { ...this.system.info(), telemetry: this.freshness.current() };
  }

  /**
   * Freshness on its own, for the shell's polling loop. Separate from `info`
   * because the environment designation cannot change without a redeploy while
   * freshness changes every few seconds, and polling the pair would re-send an
   * immutable payload forever.
   */
  @Get('telemetry')
  telemetry() {
    return this.freshness.current();
  }
}
