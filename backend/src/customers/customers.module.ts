import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuthModule } from '../security/auth.module';
import { CustomersController } from './customers.controller';
import { CustomersRepository } from './customers.repository';

@Module({
  imports: [AuthModule],
  controllers: [CustomersController],
  providers: [DatabaseService, CustomersRepository],
})
export class CustomersModule {}
