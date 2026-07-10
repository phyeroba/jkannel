import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { Actor } from './customer-accounts.common';
import { CustomerQuotaService, QuotaPeriod } from './customer-quota.service';
import { CustomerCreditService, LedgerDirection } from './customer-credit.service';
import { CustomerSenderIdsService, SenderIdStatus } from './customer-sender-ids.service';
import { CustomerRoutesService } from './customer-routes.service';

type Request = AuthenticatedRequest;
const actor = (r: Request): Actor => ({
  tenantId: r.principal!.tenantId,
  userId: r.principal!.userId,
});

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${name} is required`);
  return value.trim();
};
const uuid = (value: unknown, name: string): string => {
  const v = text(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v))
    throw new BadRequestException(`${name} must be a UUID`);
  return v;
};
const period = (value: unknown): QuotaPeriod => {
  const v = text(value, 'period');
  if (v !== 'daily' && v !== 'monthly')
    throw new BadRequestException('period must be daily or monthly');
  return v;
};
const positiveInt = (value: unknown, name: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new BadRequestException(`${name} must be a positive integer`);
  return n;
};
const optionalReason = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * Customer account depth: quotas, prepaid credit, sender IDs, and route
 * bindings for an existing customer (migration 026). Mounted under
 * /customer-accounts/:id/... so it never collides with the /customers/:id
 * directory routes owned by the customers module. Reads require system.view,
 * mutations require system.manage; every mutation is audited by its service.
 */
@Controller('customer-accounts/:id')
@UseGuards(AuthGuard, PermissionsGuard)
export class CustomerAccountsController {
  constructor(
    private readonly quota: CustomerQuotaService,
    private readonly credit: CustomerCreditService,
    private readonly senderIds: CustomerSenderIdsService,
    private readonly routes: CustomerRoutesService,
  ) {}

  // ---- Quotas ----------------------------------------------------------------

  @Get('quota') @RequirePermissions('system.view') listQuota(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.quota.list(actor(r), uuid(id, 'id'));
  }

  @Put('quota') @RequirePermissions('system.manage') setQuota(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    return this.quota.setQuota(actor(r), uuid(id, 'id'), {
      period: period(b.period),
      limit: (() => {
        const n = Number(b.limit);
        if (!Number.isInteger(n) || n < 0)
          throw new BadRequestException('limit must be a non-negative integer');
        return n;
      })(),
    });
  }

  @Post('quota/consume') @RequirePermissions('system.manage') consumeQuota(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    return this.quota.consume(actor(r), uuid(id, 'id'), positiveInt(b.count ?? 1, 'count'));
  }

  @Delete('quota/:period') @RequirePermissions('system.manage') deleteQuota(
    @Req() r: Request,
    @Param('id') id: string,
    @Param('period') p: string,
  ) {
    return this.quota
      .removeQuota(actor(r), uuid(id, 'id'), period(p))
      .then((deleted) => ({ deleted }));
  }

  // ---- Credit / balance ------------------------------------------------------

  @Get('credit') @RequirePermissions('system.view') getBalance(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.credit.getBalance(actor(r), uuid(id, 'id'));
  }

  @Get('credit/transactions') @RequirePermissions('system.view') listTransactions(
    @Req() r: Request,
    @Param('id') id: string,
    @Query() q: any = {},
  ) {
    return this.credit.listTransactions(actor(r), uuid(id, 'id'), q);
  }

  @Post('credit/transactions') @RequirePermissions('system.manage') postTransaction(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    const direction = text(b.direction, 'direction') as LedgerDirection;
    if (direction !== 'credit' && direction !== 'debit')
      throw new BadRequestException('direction must be credit or debit');
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0)
      throw new BadRequestException('amount must be a positive number');
    return this.credit.postTransaction(actor(r), uuid(id, 'id'), {
      direction,
      amount,
      reason: optionalReason(b.reason),
      reference:
        typeof b.reference === 'string' && b.reference.trim() ? b.reference.trim() : undefined,
    });
  }

  // ---- Sender IDs ------------------------------------------------------------

  @Get('sender-ids') @RequirePermissions('system.view') listSenderIds(
    @Req() r: Request,
    @Param('id') id: string,
    @Query('status') status?: string,
  ) {
    const s = status ? (text(status, 'status') as SenderIdStatus) : undefined;
    if (s && !['pending', 'approved', 'rejected'].includes(s))
      throw new BadRequestException('status must be pending, approved, or rejected');
    return this.senderIds.list(actor(r), uuid(id, 'id'), s);
  }

  @Post('sender-ids') @RequirePermissions('system.manage') requestSenderId(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    return this.senderIds.request(actor(r), uuid(id, 'id'), {
      senderId: text(b.senderId, 'senderId'),
    });
  }

  @Patch('sender-ids/:sid') @RequirePermissions('system.manage') reviewSenderId(
    @Req() r: Request,
    @Param('id') id: string,
    @Param('sid') sid: string,
    @Body() b: any = {},
  ) {
    const status = text(b.status, 'status');
    if (status !== 'approved' && status !== 'rejected')
      throw new BadRequestException('status must be approved or rejected');
    return this.senderIds.review(actor(r), uuid(id, 'id'), uuid(sid, 'sid'), {
      status,
      reason: optionalReason(b.reason),
    });
  }

  @Delete('sender-ids/:sid') @RequirePermissions('system.manage') deleteSenderId(
    @Req() r: Request,
    @Param('id') id: string,
    @Param('sid') sid: string,
  ) {
    return this.senderIds
      .remove(actor(r), uuid(id, 'id'), uuid(sid, 'sid'))
      .then(() => ({ deleted: true }));
  }

  // ---- Route bindings --------------------------------------------------------

  @Get('routes') @RequirePermissions('system.view') listRoutes(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.routes.list(actor(r), uuid(id, 'id'));
  }

  @Post('routes') @RequirePermissions('system.manage') bindRoute(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    return this.routes.bind(actor(r), uuid(id, 'id'), {
      routeId: b.routeId ? uuid(b.routeId, 'routeId') : undefined,
      smscId: b.smscId ? uuid(b.smscId, 'smscId') : undefined,
      priority: b.priority === undefined ? undefined : Number(b.priority),
    });
  }

  @Patch('routes/:bindingId') @RequirePermissions('system.manage') updateRoute(
    @Req() r: Request,
    @Param('id') id: string,
    @Param('bindingId') bindingId: string,
    @Body() b: any = {},
  ) {
    return this.routes.update(actor(r), uuid(id, 'id'), uuid(bindingId, 'bindingId'), {
      priority: b.priority === undefined ? undefined : Number(b.priority),
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
    });
  }

  @Delete('routes/:bindingId') @RequirePermissions('system.manage') unbindRoute(
    @Req() r: Request,
    @Param('id') id: string,
    @Param('bindingId') bindingId: string,
  ) {
    return this.routes
      .remove(actor(r), uuid(id, 'id'), uuid(bindingId, 'bindingId'))
      .then(() => ({ deleted: true }));
  }
}
