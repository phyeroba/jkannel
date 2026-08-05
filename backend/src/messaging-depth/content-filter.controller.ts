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
import { ContentFilterService } from './content-filter.service';
import { Actor } from './message-send.service';

type Request = AuthenticatedRequest;
const actor = (r: Request): Actor => ({
  tenantId: r.principal!.tenantId,
  userId: r.principal!.userId,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const uuid = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !UUID.test(value.trim()))
    throw new BadRequestException(`${name} must be a UUID`);
  return value.trim();
};

const optionalBoolean = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new BadRequestException(`${name} must be a boolean`);
};

const optionalDate = (value: unknown, name: string): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime()))
    throw new BadRequestException(`${name} must be an ISO 8601 timestamp`);
  return parsed;
};

const optionalText = (value: unknown, name: string, max = 2000): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new BadRequestException(`${name} must be a string`);
  if (value.length > max)
    throw new BadRequestException(`${name} must be at most ${max} characters`);
  return value;
};

/**
 * Content filter administration.
 *
 * Reading requires `messages.view`; every mutation requires `messages.send` —
 * the same pair the recipient blocklist uses, and the right pair here too: these
 * rules decide whether traffic goes out, so the permission to change them is the
 * permission to send. No new permission code was invented, because a code
 * nothing seeds is a code that grants nothing (see rbac-catalogue.spec.ts).
 *
 * Every mutation is audited by the service inside the same transaction as the
 * write, so an audit row cannot exist for a change that rolled back, nor a
 * change without an audit row.
 */
@Controller('messaging/content-rules')
@UseGuards(AuthGuard, PermissionsGuard)
export class ContentFilterController {
  constructor(private readonly rules: ContentFilterService) {}

  /**
   * Grid over the rule set, in EVALUATION ORDER by default. Accepts the shared
   * vocabulary: `search`, `sort` (`priority`, `-updatedAt`, `matchCount`, ...),
   * `filter.action` / `filter.enabled` / `filter.matchType` / `filter.smscId`,
   * `limit`/`offset`, `?fields=`, and keyset pagination via `?cursor=`.
   */
  @Get() @RequirePermissions('messages.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.rules.list(actor(r), q);
  }

  /** Precedence, limits and cache window, so a console need not hard-code them. */
  @Get('policy') @RequirePermissions('messages.view') policy() {
    return this.rules.policy();
  }

  /**
   * TEST A RULE BEFORE IT DROPS TRAFFIC.
   *
   * Given a candidate sender / recipient / body (and optionally the carrier and
   * customer), returns the outcome, the deciding rule and EVERY other rule that
   * matched — flagged `shadowed` when a higher-precedence rule got there first.
   * POST rather than GET because a message body is not a query string.
   */
  @Post('preview') @RequirePermissions('messages.view') preview(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    if (typeof b?.text !== 'string' && typeof b?.body !== 'string')
      throw new BadRequestException('text is required (the candidate message body)');
    return this.rules.preview(actor(r), {
      sender: typeof b.sender === 'string' ? b.sender : '',
      recipient: typeof b.recipient === 'string' ? b.recipient : '',
      text: typeof b.text === 'string' ? b.text : b.body,
      smscId: typeof b.smscId === 'string' && b.smscId.trim() ? b.smscId.trim() : null,
      customerId: b.customerId ? uuid(b.customerId, 'customerId') : null,
    });
  }

  @Get(':id') @RequirePermissions('messages.view') get(@Req() r: Request, @Param('id') id: string) {
    return this.rules.get(actor(r), uuid(id, 'id'));
  }

  @Post() @RequirePermissions('messages.send') create(@Req() r: Request, @Body() b: any = {}) {
    return this.rules.create(actor(r), {
      name: typeof b.name === 'string' ? b.name : '',
      description: optionalText(b.description, 'description') ?? null,
      matchField: b.matchField,
      matchType: b.matchType,
      pattern: b.pattern,
      caseSensitive: optionalBoolean(b.caseSensitive, 'caseSensitive') ?? false,
      action: b.action,
      smscId: b.smscId ?? null,
      customerId: b.customerId ?? null,
      enabled: optionalBoolean(b.enabled, 'enabled') ?? true,
      priority: b.priority,
      expiresAt: optionalDate(b.expiresAt, 'expiresAt') ?? null,
      reason: optionalText(b.reason, 'reason') ?? null,
    });
  }

  /** Partial update: only the supplied fields change. */
  @Patch(':id') @RequirePermissions('messages.send') update(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    return this.rules.update(actor(r), uuid(id, 'id'), {
      ...(b.name !== undefined ? { name: String(b.name) } : {}),
      ...(b.description !== undefined
        ? { description: optionalText(b.description, 'description') ?? null }
        : {}),
      ...(b.matchField !== undefined ? { matchField: b.matchField } : {}),
      ...(b.matchType !== undefined ? { matchType: b.matchType } : {}),
      ...(b.pattern !== undefined ? { pattern: b.pattern } : {}),
      ...(b.caseSensitive !== undefined
        ? { caseSensitive: optionalBoolean(b.caseSensitive, 'caseSensitive') }
        : {}),
      ...(b.action !== undefined ? { action: b.action } : {}),
      ...(b.smscId !== undefined ? { smscId: b.smscId ?? null } : {}),
      ...(b.customerId !== undefined ? { customerId: b.customerId ?? null } : {}),
      ...(b.enabled !== undefined ? { enabled: optionalBoolean(b.enabled, 'enabled') } : {}),
      ...(b.priority !== undefined ? { priority: b.priority } : {}),
      ...(b.expiresAt !== undefined
        ? { expiresAt: optionalDate(b.expiresAt, 'expiresAt') ?? null }
        : {}),
      ...(b.reason !== undefined ? { reason: optionalText(b.reason, 'reason') ?? null } : {}),
    });
  }

  @Delete(':id') @RequirePermissions('messages.send') async remove(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    await this.rules.remove(actor(r), uuid(id, 'id'));
    return { removed: true, id };
  }
}
