import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { CustomerAccountsController } from './customer-accounts.controller';
import { CustomerQuotaService } from './customer-quota.service';
import { CustomerCreditService } from './customer-credit.service';
import { CustomerSenderIdsService } from './customer-sender-ids.service';
import { CustomerRoutesService } from './customer-routes.service';

/**
 * Customer-depth feature module: quotas, prepaid credit, sender IDs, and route
 * bindings for existing customers (migration 026). Sibling to the customers
 * module — it adds business resources on top of the customer directory without
 * touching that module's files. Depends on {@link AuthModule} for the
 * auth/permissions guards. The quota and credit services expose enforcement
 * primitives ({@link CustomerQuotaService.consume},
 * {@link CustomerCreditService.postTransaction} /
 * {@link CustomerCreditService.hasSufficientBalance}) that a message send path
 * can call before dispatching; they are not yet wired into the live send path
 * (owned by the messaging-depth module).
 */
@Module({
  imports: [AuthModule],
  controllers: [CustomerAccountsController],
  providers: [
    DatabaseService,
    CustomerQuotaService,
    CustomerCreditService,
    CustomerSenderIdsService,
    CustomerRoutesService,
  ],
})
export class CustomersDepthModule {}
