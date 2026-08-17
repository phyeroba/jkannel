import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { GlobalSearchService } from './global-search.service';

/**
 * Estate-wide search (spec §2.1).
 *
 * Guarded by AuthGuard only, with NO `@RequirePermissions`. That is deliberate:
 * the endpoint searches nothing on its own. Every result kind is gated
 * individually inside the service against the permission that guards its own
 * screen, so a caller with only `smsc.view` gets SMSCs and is told, in
 * `skipped`, which kinds were not searched. A blanket permission here would
 * either lock out operators who legitimately hold one of the narrower grants,
 * or hand them all of it.
 */
@Controller('search')
@UseGuards(AuthGuard)
export class GlobalSearchController {
  constructor(private readonly search: GlobalSearchService) {}

  @Get()
  async run(@Req() request: AuthenticatedRequest, @Query('q') q?: string) {
    const principal = request.principal!;
    return this.search.search(
      { tenantId: principal.tenantId },
      typeof q === 'string' ? q : '',
      new Set(principal.permissions),
    );
  }
}
