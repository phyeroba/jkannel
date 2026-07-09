import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ContextRequest } from '../platform/request-context.middleware';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { AiOperationsService } from './ai-operations.service';
import { AssistanceActor, AssistanceRequest } from './ai-operations.types';
type Request = AuthenticatedRequest & ContextRequest;
const actor = (request: Request): AssistanceActor => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
  correlationId: request.correlationId,
});
const identifier = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new BadRequestException('id must be a UUID');
  return value;
};
@Controller('ai/assistance')
@UseGuards(AuthGuard, PermissionsGuard)
export class AiOperationsController {
  constructor(private readonly service: AiOperationsService) {}
  @Post() @RequirePermissions('monitoring.view') assist(
    @Req() request: Request,
    @Headers('x-jkannel-ai-opt-in') optIn: string | undefined,
    @Body() body: AssistanceRequest,
  ) {
    return this.service.assist(actor(request), body, optIn === 'true');
  }
  @Get(':id') @RequirePermissions('monitoring.view') get(
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    return this.service.get(actor(request), identifier(id));
  }
  @Post(':id/decisions') @RequirePermissions('system.manage') decide(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { decision: 'approve' | 'reject'; reason: string },
  ) {
    return this.service.decide(actor(request), identifier(id), body.decision, body.reason);
  }
}
