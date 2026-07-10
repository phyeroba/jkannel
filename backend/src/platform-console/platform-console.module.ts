import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EngineModule } from '../engine/engine.module';
import { AuthModule } from '../security/auth.module';
import { ExportService } from '../platform/export.service';
import { PlatformConsoleRepository } from './platform-console.repository';
import { RuntimeContainersService } from './runtime-containers.service';
import {
  ApiGatewayController,
  BackupsController,
  CustomersController,
  PluginsController,
  RuntimeContainersController,
} from './platform.controllers';

@Module({
  imports: [AuthModule, EngineModule],
  controllers: [
    ApiGatewayController,
    PluginsController,
    BackupsController,
    RuntimeContainersController,
    CustomersController,
  ],
  providers: [DatabaseService, PlatformConsoleRepository, RuntimeContainersService, ExportService],
})
export class PlatformConsoleModule {}
