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
import { SUPPORTED_ENGINES } from '../configuration/configuration-generator.service';
import {
  Actor,
  ConfigTemplateInput,
  ConfigTemplatesRepository,
} from './config-templates.repository';

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
const optionalEngine = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const engine = text(value, 'engine');
  if (!SUPPORTED_ENGINES.includes(engine as (typeof SUPPORTED_ENGINES)[number]))
    throw new BadRequestException(`engine must be one of ${SUPPORTED_ENGINES.join(', ')}`);
  return engine;
};
const contentObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('content object is required');
  return value as Record<string, unknown>;
};

/**
 * Configuration template library. A template is a reusable starting
 * EngineConfiguration a maintainer can clone into a fresh configuration
 * version. Reads require configuration.view, mutations configuration.manage;
 * every mutation is audited. Built-in seeded templates are read-only.
 *
 * Route ordering note: this controller is registered before the console
 * ConfigurationsController (see app.module) so the literal /configurations/
 * templates* paths match ahead of that controller's /configurations/:id route.
 */
@Controller('configurations/templates')
@UseGuards(AuthGuard, PermissionsGuard)
export class ConfigTemplatesController {
  constructor(private readonly repository: ConfigTemplatesRepository) {}

  @Get() @RequirePermissions('configuration.view') list(@Req() r: Request, @Query() q: any = {}) {
    return this.repository.listTemplates(actor(r), q);
  }

  @Post() @RequirePermissions('configuration.manage') create(
    @Req() r: Request,
    @Body() b: any = {},
  ) {
    const value: ConfigTemplateInput = {
      name: text(b.name, 'name'),
      description:
        typeof b.description === 'string' && b.description.trim()
          ? b.description.trim()
          : undefined,
      engine: optionalEngine(b.engine),
      content: contentObject(b.content),
    };
    return this.repository.createTemplate(actor(r), value);
  }

  @Get(':id') @RequirePermissions('configuration.view') get(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.getTemplate(actor(r), uuid(id, 'id'));
  }

  @Patch(':id') @RequirePermissions('configuration.manage') update(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() b: any = {},
  ) {
    const value: Partial<ConfigTemplateInput> = {
      name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : undefined,
      description: typeof b.description === 'string' ? b.description.trim() : undefined,
      engine: optionalEngine(b.engine),
      content: b.content === undefined ? undefined : contentObject(b.content),
      reason: typeof b.reason === 'string' ? b.reason : undefined,
    };
    return this.repository.updateTemplate(actor(r), uuid(id, 'id'), value);
  }

  @Delete(':id') @RequirePermissions('configuration.manage') remove(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    return this.repository.deleteTemplate(actor(r), uuid(id, 'id'));
  }

  /**
   * Instantiate a template: returns its content ready to feed to the generator
   * so the console can render/validate it (POST /configurations/generate) and
   * then create a new version (POST /configurations). This endpoint is a pure
   * read — it never creates a version itself, keeping the existing approval and
   * deployment workflow the single source of truth.
   */
  @Post(':id/instantiate') @RequirePermissions('configuration.manage') async instantiate(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    const template = await this.repository.getTemplate(actor(r), uuid(id, 'id'));
    return {
      templateId: template.id,
      name: template.name,
      engine: template.engine,
      content: template.content,
      note:
        'Feed content to POST /configurations/generate to render and natively validate, ' +
        'then POST /configurations to create a new version.',
    };
  }
}
