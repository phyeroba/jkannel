import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from './auth.guard';
import { PermissionsGuard, RequirePermissions } from './permissions.guard';
import { LoginHistoryService } from './identity-login-history.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const boundedInt = (value: unknown, name: string, min: number, max: number, fallback: number) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
};

@Controller('auth/login-history')
@UseGuards(AuthGuard, PermissionsGuard)
export class LoginHistoryController {
  constructor(private readonly history: LoginHistoryService) {}

  @Get()
  @RequirePermissions('users.view')
  list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    const userId = query.userId;
    if (userId !== undefined && userId !== '' && !UUID.test(String(userId)))
      throw new BadRequestException('userId must be a UUID');
    return this.history.list(
      { tenantId: request.principal!.tenantId },
      {
        userId: userId ? String(userId) : undefined,
        limit: boundedInt(query.limit, 'limit', 1, 500, 50),
        offset: boundedInt(query.offset, 'offset', 0, 5_000_000, 0),
      },
    );
  }
}
