import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from './auth.guard';
import { PermissionsGuard, RequirePermissions } from './permissions.guard';
import { SessionActor, SessionAdminRepository } from './session-admin.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const boundedInt = (value: unknown, name: string, min: number, max: number, fallback: number) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
};

@Controller('sessions')
@UseGuards(AuthGuard, PermissionsGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionAdminRepository) {}

  private actor(request: AuthenticatedRequest): SessionActor {
    return { tenantId: request.principal!.tenantId, userId: request.principal!.userId };
  }

  @Get()
  @RequirePermissions('users.sessions')
  list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    const userId = query.userId;
    if (userId !== undefined && userId !== '' && !UUID.test(String(userId)))
      throw new BadRequestException('userId must be a UUID');
    return this.sessions.listSessions(this.actor(request), {
      userId: userId ? String(userId) : undefined,
      active: query.active === 'true' || query.active === true,
      limit: boundedInt(query.limit, 'limit', 1, 500, 50),
      offset: boundedInt(query.offset, 'offset', 0, 5_000_000, 0),
    });
  }

  @Post(':id/revoke')
  @RequirePermissions('users.sessions')
  revoke(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    if (!UUID.test(id)) throw new BadRequestException('id must be a UUID');
    return this.sessions.revokeSession(this.actor(request), id);
  }
}
