import { Module } from '@nestjs/common';
import { ConfigurationGeneratorService } from './configuration/configuration-generator.service';
import { RoutingService } from './routing/routing.service';
import { SmscService } from './smsc/smsc.service';
import { MessageExplorerService } from './messages/message-explorer.service';
import { AlertEvaluatorService } from './monitoring/alert-evaluator.service';
import { ReportingService } from './reporting/reporting.service';
@Module({
  providers: [
    ConfigurationGeneratorService,
    SmscService,
    RoutingService,
    MessageExplorerService,
    AlertEvaluatorService,
    ReportingService,
  ],
  exports: [
    ConfigurationGeneratorService,
    SmscService,
    RoutingService,
    MessageExplorerService,
    AlertEvaluatorService,
    ReportingService,
  ],
})
export class DomainModule {}
