import { Module } from '@nestjs/common';
import { AuthModule } from '../security/auth.module';
import { DatabaseService } from '../database/database.service';
import { PrivacyController } from './privacy.controller';
import { PiiRevealService } from './pii-reveal.service';

/**
 * Masking and audited reveal (spec §10, §18).
 *
 * Exported so the read paths that carry subscriber data — messages, exports,
 * queues, delivery reports, MO — can resolve a caller's reveal authority
 * without each re-implementing the rule.
 */
@Module({
  imports: [AuthModule],
  controllers: [PrivacyController],
  providers: [DatabaseService, PiiRevealService],
  exports: [PiiRevealService],
})
export class PrivacyModule {}
