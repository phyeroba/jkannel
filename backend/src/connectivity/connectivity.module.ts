import { Module } from '@nestjs/common';
import { AuthModule } from '../security/auth.module';
import { DatabaseService } from '../database/database.service';
import { CarrierController } from './carrier.controller';
import { CarrierService } from './carrier.service';

/**
 * Connectivity: the operational hierarchy above the engine's flat SMSC list
 * (spec §4, §5) — Carrier -> SMSC -> SMPP Session.
 *
 * Kept out of the existing console module because that file is already large
 * and this is a new domain rather than another workspace on the old one.
 */
@Module({
  imports: [AuthModule],
  controllers: [CarrierController],
  providers: [DatabaseService, CarrierService],
  exports: [CarrierService],
})
export class ConnectivityModule {}
