import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { ConfigurationDiffService } from '../configuration/configuration-diff.service';
import { ConfigTemplatesController } from './config-templates.controller';
import { ConfigTemplatesRepository } from './config-templates.repository';
import { ConfigDriftController } from './config-drift.controller';
import { ConfigDriftService } from './config-drift.service';

/**
 * Configuration Depth: reusable configuration templates and live/deployed
 * drift detection. Layered on top of the existing configuration_versions
 * workflow without modifying it. This module is imported BEFORE ConsoleModule
 * in app.module so its literal /configurations/templates* and
 * /configurations/drift* routes register ahead of the console
 * ConfigurationsController's /configurations/:id route.
 */
@Module({
  imports: [AuthModule],
  controllers: [ConfigTemplatesController, ConfigDriftController],
  providers: [
    DatabaseService,
    ConfigurationDiffService,
    ConfigTemplatesRepository,
    ConfigDriftService,
  ],
})
export class ConfigurationDepthModule {}
