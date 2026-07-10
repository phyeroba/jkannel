import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { AuditSignatureService } from './audit-signature.service';
import { DataModelRetentionService } from './retention.service';
import { DataModelRetentionScheduler } from './retention.scheduler';
import { DataModelRecordsService } from './data-model-records.service';
import { DataModelController } from './data-model.controller';

/**
 * Data-model completeness module (migration 027): audit hash-chain verification,
 * historical archive/retention (job + scheduler), and the soft-delete +
 * optimistic-locking conventions exercised by DataModelRecordsService. Depends on
 * {@link AuthModule} for the auth/permissions guards. The retention scheduler is
 * disabled under NODE_ENV=test and DATA_MODEL_JOBS_ENABLED=false.
 */
@Module({
  imports: [AuthModule],
  controllers: [DataModelController],
  providers: [
    DatabaseService,
    AuditSignatureService,
    DataModelRetentionService,
    DataModelRetentionScheduler,
    DataModelRecordsService,
  ],
})
export class DataModelModule {}
