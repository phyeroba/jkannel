import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from './auth.guard';
import { PermissionsGuard, RequirePermissions } from './permissions.guard';
import { ApiKeyActor, ApiKeysService } from './api-keys.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const boundedInt = (value: unknown, name: string, min: number, max: number, fallback: number) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
};

@Controller('auth/api-keys')
@UseGuards(AuthGuard, PermissionsGuard)
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  private actor(request: AuthenticatedRequest): ApiKeyActor {
    return { tenantId: request.principal!.tenantId, userId: request.principal!.userId };
  }

  @Post()
  @RequirePermissions('users.manage')
  create(
    @Req() request: AuthenticatedRequest,
    @Body() body: { name?: unknown; scopes?: unknown; expiresAt?: unknown },
  ) {
    return this.apiKeys.create(this.actor(request), body);
  }

  @Get()
  @RequirePermissions('users.manage')
  list(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    return this.apiKeys.list(this.actor(request), {
      limit: boundedInt(query.limit, 'limit', 1, 500, 50),
      offset: boundedInt(query.offset, 'offset', 0, 5_000_000, 0),
    });
  }

  @Delete(':id')
  @RequirePermissions('users.manage')
  disable(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    if (!UUID.test(id)) throw new BadRequestException('id must be a UUID');
    return this.apiKeys.disable(this.actor(request), id);
  }
}
