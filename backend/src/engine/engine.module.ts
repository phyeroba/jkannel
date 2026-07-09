import { Module } from '@nestjs/common';
import { EngineAdapterRegistry } from './engine-adapter.registry';
import { KamexAdapter } from './kamex.adapter';
import { KamexSqlboxRepository } from './kamex-sqlbox.repository';
import { KannelAdapter } from './kannel.adapter';

@Module({
  providers: [KannelAdapter, KamexSqlboxRepository, KamexAdapter, EngineAdapterRegistry],
  exports: [EngineAdapterRegistry, KamexSqlboxRepository],
})
export class EngineModule {}
