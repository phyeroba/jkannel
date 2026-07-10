import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { Actor } from './data-model.common';
import { AuditSignatureService } from './audit-signature.service';
import { DataModelRetentionService } from './retention.service';
import { DataModelRecordsService } from './data-model-records.service';

type Request = AuthenticatedRequest;
const actor = (r: Request): Actor => ({
  tenantId: r.principal!.tenantId,
  userId: r.principal!.userId,
});

const asObject = (value: unknown, name: string): Record<string, unknown> => {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException(`${name} must be an object`);
  return value as Record<string, unknown>;
};

/**
 * Data-model operations surface (migration 027). Reads require system.view;
 * mutations / job triggers require system.manage — reusing existing granted
 * permissions rather than inventing new ones.
 *
 *   - GET  /data-model/audit-chain/verify   verify the audit tamper-evidence chain
 *   - GET  /data-model/retention            retention bookkeeping per source table
 *   - POST /data-model/retention/run        run the archive/prune job now
 *   - CRUD /data-model/records              reference table demonstrating the
 *                                           soft-delete + optimistic-lock conventions
 */
@Controller('data-model')
@UseGuards(AuthGuard, PermissionsGuard)
export class DataModelController {
  constructor(
    private readonly signatures: AuditSignatureService,
    private readonly retention: DataModelRetentionService,
    private readonly records: DataModelRecordsService,
  ) {}

  @Get('audit-chain/verify')
  @RequirePermissions('system.view')
  verifyAuditChain(@Req() req: Request) {
    return this.signatures.verifyChain(actor(req));
  }

  @Get('retention')
  @RequirePermissions('system.view')
  retentionStatus(@Req() req: Request) {
    return this.retention.status(actor(req));
  }

  @Post('retention/run')
  @RequirePermissions('system.manage')
  runRetention(@Req() req: Request) {
    return this.retention.runForTenant(actor(req));
  }

  @Get('records')
  @RequirePermissions('system.view')
  listRecords(@Req() req: Request) {
    return this.records.list(actor(req));
  }

  @Get('records/:id')
  @RequirePermissions('system.view')
  getRecord(@Req() req: Request, @Param('id') id: string) {
    return this.records.get(actor(req), id);
  }

  @Post('records')
  @RequirePermissions('system.manage')
  createRecord(@Req() req: Request, @Body() body: { key?: unknown; value?: unknown }) {
    const key = typeof body.key === 'string' ? body.key : '';
    return this.records.create(actor(req), { key, value: asObject(body.value, 'value') });
  }

  @Patch('records/:id')
  @RequirePermissions('system.manage')
  updateRecord(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { expectedVersion?: unknown; value?: unknown },
  ) {
    const expectedVersion = Number(body.expectedVersion);
    if (!Number.isInteger(expectedVersion))
      throw new BadRequestException('expectedVersion is required');
    return this.records.update(actor(req), id, expectedVersion, asObject(body.value, 'value'));
  }

  @Delete('records/:id')
  @RequirePermissions('system.manage')
  removeRecord(@Req() req: Request, @Param('id') id: string) {
    return this.records.remove(actor(req), id).then((removed) => ({ removed }));
  }
}
