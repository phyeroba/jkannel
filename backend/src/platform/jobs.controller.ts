import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { JobsService } from './jobs.service';

const actor = (request: AuthenticatedRequest) => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});
const uuid = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new BadRequestException('id must be a UUID');
  return value;
};

@Controller('jobs')
@UseGuards(AuthGuard, PermissionsGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  @RequirePermissions('system.view')
  list(
    @Req() request: AuthenticatedRequest,
    @Query('status') status?: string,
    @Query('type') type?: string,
  ) {
    return this.jobs.list(actor(request), status, type);
  }

  @Get(':id')
  @RequirePermissions('system.view')
  get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.jobs.get(actor(request), uuid(id));
  }

  @Post()
  @RequirePermissions('system.manage')
  create(
    @Req() request: AuthenticatedRequest,
    @Body() body: any,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body || typeof body !== 'object')
      throw new BadRequestException('Request body is required');
    return this.jobs.create(actor(request), {
      type: String(body.type ?? ''),
      input: body.input ?? {},
      idempotencyKey: key?.trim(),
    });
  }

  @Post(':id/cancel')
  @RequirePermissions('system.manage')
  cancel(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: any) {
    return this.jobs.cancel(actor(request), uuid(id), body?.reason);
  }
}
