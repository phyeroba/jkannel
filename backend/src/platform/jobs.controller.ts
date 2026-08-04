import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
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

  /**
   * Grid read. Supports the shared list contract (search/sort/filter.<f>/limit/
   * offset), opt-in keyset pagination (?cursor / ?paginate=cursor) and
   * ?fields= projection. The legacy ?status / ?type shorthands are mapped onto
   * the grid's filters so existing callers keep working.
   */
  @Get()
  @RequirePermissions('system.view')
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: Record<string, unknown> = {},
    @Query('status') status?: string,
    @Query('type') type?: string,
  ) {
    const merged: Record<string, unknown> = { ...query };
    if (status) merged['filter.status'] = status;
    if (type) merged['filter.type'] = type;
    return this.jobs.list(actor(request), merged);
  }

  /**
   * The types this deployment can actually execute. Declared before ':id' so
   * the literal path matches first. A caller should consult this rather than
   * guessing: POST /jobs rejects any type with no registered executor.
   */
  @Get('types')
  @RequirePermissions('system.view')
  types() {
    return this.jobs.types();
  }

  @Get(':id')
  @RequirePermissions('system.view')
  get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.jobs.get(actor(request), uuid(id));
  }

  /**
   * Submits asynchronous work.
   *
   * This route previously returned 501: `api_jobs` rows were written and read
   * by nothing, so a submitted job reported `queued` forever and a caller
   * polling for completion waited indefinitely. It is honest again because
   * JobWorker now claims, executes, retries and dead-letters these rows, and
   * because JobHandlerRegistry rejects — at submission time, with a 400 naming
   * the supported types — any type that has no executor. There is no longer a
   * path by which an accepted job silently never runs.
   *
   * Responds 202 Accepted with a Location header pointing at the job resource,
   * per the async REST pattern.
   */
  @Post()
  @HttpCode(202)
  @RequirePermissions('system.manage')
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: any,
    @Headers('idempotency-key') key?: string,
    @Res({ passthrough: true }) response?: any,
  ) {
    if (!body || typeof body !== 'object')
      throw new BadRequestException('Request body is required');
    const job = await this.jobs.create(actor(request), {
      type: body.type,
      input: body.input,
      idempotencyKey: body.idempotencyKey ?? key,
    });
    response?.setHeader?.('location', `/jobs/${job.id}`);
    return job;
  }

  @Post(':id/cancel')
  @RequirePermissions('system.manage')
  cancel(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: any) {
    return this.jobs.cancel(actor(request), uuid(id), body?.reason);
  }
}
