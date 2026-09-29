import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EngineModule } from '../engine/engine.module';
import { AuthModule } from '../security/auth.module';
import { ExportService } from '../platform/export.service';
import { PlatformConsoleRepository } from './platform-console.repository';
import { RuntimeContainersService } from './runtime-containers.service';
import {
  ApiGatewayController,
  PluginsController,
  RuntimeContainersController,
} from './platform.controllers';

@Module({
  imports: [AuthModule, EngineModule],
  // BackupsController was removed on 2026-09-29; /backup-dr is the only backup
  // surface now. See the note in platform.controllers.ts for the evidence.
  controllers: [ApiGatewayController, PluginsController, RuntimeContainersController],
  providers: [DatabaseService, PlatformConsoleRepository, RuntimeContainersService, ExportService],
})
export class PlatformConsoleModule {}
