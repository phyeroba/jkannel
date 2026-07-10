import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { ReportingAnalyticsService } from './reporting-analytics.service';

@Controller('reports/analytics')
@UseGuards(AuthGuard, PermissionsGuard)
export class ReportingAnalyticsController {
  constructor(private readonly analytics: ReportingAnalyticsService) {}

  private actor(r: AuthenticatedRequest) {
    return { tenantId: r.principal!.tenantId };
  }

  @Get('catalog') @RequirePermissions('reports.view') catalog() {
    return this.analytics.catalog();
  }
  @Get('overview') @RequirePermissions('reports.view') overview(@Req() r: AuthenticatedRequest) {
    return this.analytics.overview(this.actor(r));
  }
  @Get('traffic-trend') @RequirePermissions('reports.view') trend(
    @Req() r: AuthenticatedRequest,
    @Query('days') days?: string,
  ) {
    return this.analytics.trafficTrend(this.actor(r), days ? Number(days) : 30);
  }
  @Get('per-smsc') @RequirePermissions('reports.view') perSmsc(@Req() r: AuthenticatedRequest) {
    return this.analytics.perSmsc(this.actor(r));
  }
  @Get('per-route') @RequirePermissions('reports.view') perRoute(@Req() r: AuthenticatedRequest) {
    return this.analytics.perRoute(this.actor(r));
  }
  @Get('delivery-breakdown') @RequirePermissions('reports.view') breakdown(
    @Req() r: AuthenticatedRequest,
  ) {
    return this.analytics.deliveryBreakdown(this.actor(r));
  }
  @Get('smsc-success') @RequirePermissions('reports.view') smscSuccess(
    @Req() r: AuthenticatedRequest,
  ) {
    return this.analytics.smscSuccess(this.actor(r));
  }
  @Get('route-performance') @RequirePermissions('reports.view') routePerformance(
    @Req() r: AuthenticatedRequest,
  ) {
    return this.analytics.routePerformance(this.actor(r));
  }
  @Get('hourly-heatmap') @RequirePermissions('reports.view') hourlyHeatmap(
    @Req() r: AuthenticatedRequest,
    @Query('days') days?: string,
  ) {
    return this.analytics.hourlyHeatmap(this.actor(r), days ? Number(days) : 7);
  }
  @Get('latency-sla') @RequirePermissions('reports.view') latencySla(
    @Req() r: AuthenticatedRequest,
    @Query('days') days?: string,
  ) {
    return this.analytics.latencySla(this.actor(r), days ? Number(days) : 7);
  }
}
