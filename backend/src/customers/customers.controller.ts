import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { Actor, CustomerInput, CustomersRepository } from './customers.repository';

type Request = AuthenticatedRequest;
const actor = (r: Request): Actor => ({
  tenantId: r.principal!.tenantId,
  userId: r.principal!.userId,
});
const text = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${name} is required`);
  return value.trim();
};
const uuid = (value: unknown, name: string) => {
  const v = text(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v))
    throw new BadRequestException(`${name} must be a UUID`);
  return v;
};
const CUSTOMER_STATUSES = ['active', 'suspended', 'archived'];

/** Optional non-negative integer field (quota / rate limit). */
const optionalNonNegativeInt = (value: unknown, name: string): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw new BadRequestException(`${name} must be a non-negative integer`);
  return number;
};

const optionalSenderIds = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value))
    throw new BadRequestException('allowedSenderIds must be an array of strings');
  return value.map((entry) => text(entry, 'allowedSenderIds entry'));
};

const optionalStatus = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const status = text(value, 'status');
  if (!CUSTOMER_STATUSES.includes(status))
    throw new BadRequestException(`status must be one of ${CUSTOMER_STATUSES.join(', ')}`);
  return status;
};

const optionalEmail = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const email = text(value, 'contactEmail');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new BadRequestException('contactEmail must be a valid email address');
  return email;
};

const optionalCode = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const code = text(value, 'code');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(code))
    throw new BadRequestException('code must be 1–63 chars (letters, numbers, . _ -)');
  return code;
};

/**
 * Customer directory. A customer is an organization/account that consumes
 * messaging and owns business resources (routes, sender IDs, quotas, limits,
 * reports) — never platform resources. Reads require system.view, mutations
 * require system.manage; every mutation is audited.
 */
@Controller('customers')
@UseGuards(AuthGuard, PermissionsGuard)
export class CustomersController {
  constructor(private readonly repository: CustomersRepository) {}

  @Get() @RequirePermissions('system.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listCustomers(actor(r), q);
  }

  @Post() @RequirePermissions('system.manage') create(@Req() r: Request, @Body() b: any = {}) {
    const value: CustomerInput = {
      name: text(b.name, 'name'),
      code: optionalCode(b.code),
      status: optionalStatus(b.status),
      contactEmail: optionalEmail(b.contactEmail),
      quotaDaily: optionalNonNegativeInt(b.quotaDaily, 'quotaDaily'),
      rateLimitPerMin: optionalNonNegativeInt(b.rateLimitPerMin, 'rateLimitPerMin'),
      allowedSenderIds: optionalSenderIds(b.allowedSenderIds),
      notes: typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim() : undefined,
    };
    return this.repository.createCustomer(actor(r), value);
  }

  @Get(':id') @RequirePermissions('system.view') get(@Req() r: Request, @Param('id') id: string) {
    return this.repository.getCustomer(actor(r), uuid(id, 'id'));
  }

  @Patch(':id') @RequirePermissions('system.manage') update(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    const value: CustomerInput = {
      name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : (undefined as any),
      code: optionalCode(b.code),
      status: optionalStatus(b.status),
      contactEmail: optionalEmail(b.contactEmail),
      quotaDaily: optionalNonNegativeInt(b.quotaDaily, 'quotaDaily'),
      rateLimitPerMin: optionalNonNegativeInt(b.rateLimitPerMin, 'rateLimitPerMin'),
      allowedSenderIds: optionalSenderIds(b.allowedSenderIds),
      notes: typeof b.notes === 'string' ? b.notes.trim() : undefined,
      reason: typeof b.reason === 'string' ? b.reason : undefined,
    };
    return this.repository.updateCustomer(actor(r), uuid(id, 'id'), value);
  }

  @Delete(':id') @RequirePermissions('system.manage') archive(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.archiveCustomer(actor(r), uuid(id, 'id'));
  }
}
