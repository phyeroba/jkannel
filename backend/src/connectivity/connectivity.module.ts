import { Module } from '@nestjs/common';
import { AuthModule } from '../security/auth.module';
import { DatabaseService } from '../database/database.service';
import { CarrierController } from './carrier.controller';
import { CarrierService } from './carrier.service';
import { SmscDetailController } from './smsc-detail.controller';
import { SmscDetailService } from './smsc-detail.service';

/**
 * Connectivity: the operational hierarchy above the engine's flat SMSC list
 * (spec §4, §5) — Carrier -> SMSC -> SMPP Session.
 *
 * Kept out of the existing console module because that file is already large
 * and this is a new domain rather than another workspace on the old one.
 */
@Module({
  imports: [AuthModule],
  controllers: [CarrierController, SmscDetailController],
  providers: [DatabaseService, CarrierService, SmscDetailService],
  exports: [CarrierService, SmscDetailService],
})
export class ConnectivityModule {}
