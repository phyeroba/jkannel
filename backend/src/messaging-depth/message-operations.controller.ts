import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  Get,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { Actor, MessageOperationsService, MessageOverrides } from './message-operations.service';

type Request = AuthenticatedRequest;
const actor = (request: Request): Actor => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
});

/**
 * A SQLBox message id is an opaque numeric string (sql_id) or a foreign_id, so
 * it is validated as a non-empty, reasonably bounded token rather than a UUID.
 */
const messageId = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException('id is required');
  const id = value.trim();
  if (id.length > 128) throw new BadRequestException('id is too long');
  return id;
};

const optionalText = (value: unknown, name: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${name} must be a non-empty string when provided`);
  return value.trim();
};

function parseOverrides(body: any): MessageOverrides {
  const o = body?.overrides ?? body ?? {};
  return {
    receiver: optionalText(o.receiver, 'receiver'),
    sender: optionalText(o.sender, 'sender'),
    text: optionalText(o.text, 'text'),
  };
}

/**
 * Message operations (replay / clone / requeue). Mounted at a distinct base path
 * (`message-ops`) so it never collides with the ReadModelsController `messages`
 * routes. The resend actions mutate engine state, so they require the same
 * permission the existing POST /messages submit uses (configuration.manage);
 * the read preview requires messages.view.
 */
@Controller('message-ops')
@UseGuards(AuthGuard, PermissionsGuard)
export class MessageOperationsController {
  constructor(private readonly operations: MessageOperationsService) {}

  /** Preview the message that a replay/clone/requeue would resubmit. */
  @Get(':id') @RequirePermissions('messages.view') source(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.operations.resolve(actor(r), messageId(id));
  }

  @Post(':id/replay') @RequirePermissions('configuration.manage') replay(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.operations.replay(actor(r), messageId(id));
  }

  @Post(':id/clone') @RequirePermissions('configuration.manage') clone(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    return this.operations.clone(actor(r), messageId(id), parseOverrides(b));
  }

  @Post(':id/requeue') @RequirePermissions('configuration.manage') requeue(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.operations.requeue(actor(r), messageId(id));
  }
}
