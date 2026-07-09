import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { AiOperationsController } from './ai-operations.controller';
import { AiOperationsService } from './ai-operations.service';
import { AI_ASSISTANCE_STORE } from './ai-operations.types';
import { PostgresAiAssistanceStore } from './postgres-ai-assistance.store';
@Module({
  imports: [AuthModule],
  controllers: [AiOperationsController],
  providers: [
    DatabaseService,
    AiOperationsService,
    PostgresAiAssistanceStore,
    { provide: AI_ASSISTANCE_STORE, useExisting: PostgresAiAssistanceStore },
  ],
})
export class AiOperationsModule {}
