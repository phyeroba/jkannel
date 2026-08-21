import { Module } from '@nestjs/common';
import { AuthModule } from '../security/auth.module';
import { DatabaseService } from '../database/database.service';
import { CarrierController } from './carrier.controller';
import { CarrierService } from './carrier.service';
import { SmscDetailController } from './smsc-detail.controller';
import { SmscDetailService } from './smsc-detail.service';
import { QueueMetricsController } from './queue-metrics.controller';
import { QueueMetricsService } from './queue-metrics.service';
import { KamexSqlboxRepository } from '../engine/kamex-sqlbox.repository';
import { SafeControlController } from './safe-control.controller';
import { SafeControlService } from './safe-control.service';
import { GatewayPerformanceController } from './gateway-performance.controller';
import { GatewayPerformanceService } from './gateway-performance.service';
import { OperationalEventsService } from '../diagnostics/operational-events.service';

/**
 * Connectivity: the operational hierarchy above the engine's flat SMSC list
 * (spec §4, §5) — Carrier -> SMSC -> SMPP Session.
 *
 * Kept out of the existing console module because that file is already large
 * and this is a new domain rather than another workspace on the old one.
 */
@Module({
  imports: [AuthModule],
  controllers: [
    CarrierController,
    SmscDetailController,
    QueueMetricsController,
    SafeControlController,
    GatewayPerformanceController,
  ],
  providers: [
    DatabaseService,
    CarrierService,
    SmscDetailService,
    QueueMetricsService,
    KamexSqlboxRepository,
    SafeControlService,
    GatewayPerformanceService,
    OperationalEventsService,
  ],
  exports: [
    CarrierService,
    SmscDetailService,
    QueueMetricsService,
    SafeControlService,
    GatewayPerformanceService,
  ],
})
export class ConnectivityModule {}
