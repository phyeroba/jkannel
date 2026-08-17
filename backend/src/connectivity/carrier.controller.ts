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

// Same alias the console controllers use: the guard replaces the raw express
// request with one carrying a resolved principal.
type Request = AuthenticatedRequest;
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { CarrierService } from './carrier.service';

const actor = (request: Request) => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});

const uuid = (value: unknown, name: string): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text))
    throw new BadRequestException(`${name} must be a UUID`);
  return text;
};

/**
 * Carriers — the operational aggregation above the SMSC (spec §4.1).
 *
 * Reads are gated on `smsc.view` and writes on `smsc.manage` rather than
 * introducing a new permission pair. A carrier is an organisational label over
 * SMSCs and carries no data an operator could not already reach through them;
 * a separate grant would mean an existing SMSC administrator silently losing
 * the ability to file their own binds until someone updated their role.
 */
@Controller('carriers')
@UseGuards(AuthGuard, PermissionsGuard)
export class CarrierController {
  constructor(private readonly carriers: CarrierService) {}

  @Get() @RequirePermissions('smsc.view') list(@Req() r: Request) {
    return this.carriers.list(actor(r));
  }

  /**
   * SMSCs with no carrier. A first-class endpoint rather than a filter on the
   * register, because unassigned binds are the expected state immediately after
   * migration 048 — nothing was backfilled, deliberately — and they need to be
   * findable rather than merely absent from every carrier.
   */
  @Get('unassigned-smscs') @RequirePermissions('smsc.view') unassigned(@Req() r: Request) {
    return this.carriers.unassignedSmscs(actor(r));
  }

  @Get(':id') @RequirePermissions('smsc.view') get(@Req() r: Request, @Param('id') id: string) {
    return this.carriers.get(actor(r), uuid(id, 'id'));
  }

  @Post() @RequirePermissions('smsc.manage') create(@Req() r: Request, @Body() body: any = {}) {
    return this.carriers.create(actor(r), {
      name: typeof body.name === 'string' ? body.name : '',
      countryCode: body.countryCode ?? null,
      networkCode: body.networkCode ?? null,
      status: body.status,
      notes: body.notes ?? null,
    });
  }

  @Patch(':id') @RequirePermissions('smsc.manage') update(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() body: any = {},
  ) {
    return this.carriers.update(actor(r), uuid(id, 'id'), body);
  }

  @Delete(':id') @RequirePermissions('smsc.manage') remove(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.carriers.remove(actor(r), uuid(id, 'id'));
  }

  /**
   * Attach or detach one SMSC. `carrierId: null` detaches, which is how an
   * operator corrects a mis-filing without deleting anything.
   */
  @Post(':id/smscs') @RequirePermissions('smsc.manage') assign(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() body: any = {},
  ) {
    return this.carriers.assignSmsc(actor(r), uuid(body.smscId, 'smscId'), uuid(id, 'id'));
  }

  @Delete(':id/smscs/:smscId') @RequirePermissions('smsc.manage') detach(
    @Req() r: Request,
    @Param('smscId') smscId: string,
  ) {
    return this.carriers.assignSmsc(actor(r), uuid(smscId, 'smscId'), null);
  }
}
