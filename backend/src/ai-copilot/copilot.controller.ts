import { Body, Controller, Get, Headers, Post, Req, UseGuards } from '@nestjs/common';
import { ContextRequest } from '../platform/request-context.middleware';
import { AuthGuard, AuthenticatedRequest } from '../security/auth.guard';
import { PermissionsGuard, RequirePermissions } from '../security/permissions.guard';
import { CopilotService } from './copilot.service';
import { CopilotActor, CopilotToolsService } from './copilot-tools.service';

type Request = AuthenticatedRequest & ContextRequest;
const actor = (request: Request): CopilotActor => ({
  tenantId: request.principal!.tenantId,
  userId: request.principal!.userId,
  permissions: request.principal!.permissions,
});

@Controller('ai/copilot')
@UseGuards(AuthGuard, PermissionsGuard)
export class CopilotController {
  constructor(
    private readonly copilot: CopilotService,
    private readonly tools: CopilotToolsService,
  ) {}

  /** Lists the read-only tools the caller is permitted to use. */
  @Get('tools') @RequirePermissions('monitoring.view') listTools(@Req() request: Request) {
    return { tools: this.tools.available(actor(request)) };
  }

  @Post() @RequirePermissions('monitoring.view') ask(
    @Req() request: Request,
    @Headers('x-jkannel-ai-opt-in') optIn: string | undefined,
    @Body() body: { question: string },
  ) {
    return this.copilot.ask(actor(request), body?.question, optIn === 'true');
  }
}
