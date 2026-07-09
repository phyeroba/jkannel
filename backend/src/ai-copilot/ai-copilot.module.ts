import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EngineModule } from '../engine/engine.module';
import { AuthModule } from '../security/auth.module';
import { CopilotController } from './copilot.controller';
import { CopilotService } from './copilot.service';
import { CopilotToolsService } from './copilot-tools.service';

@Module({
  imports: [AuthModule, EngineModule],
  controllers: [CopilotController],
  providers: [DatabaseService, CopilotToolsService, CopilotService],
})
export class AiCopilotModule {}
