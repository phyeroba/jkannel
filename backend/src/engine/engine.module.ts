import { Module } from '@nestjs/common';
import { EngineAdapterRegistry } from './engine-adapter.registry';
import { KamexAdapter } from './kamex.adapter';
import { KamexSqlboxRepository } from './kamex-sqlbox.repository';
import { KannelAdapter } from './kannel.adapter';

@Module({
  providers: [KannelAdapter, KamexSqlboxRepository, KamexAdapter, EngineAdapterRegistry],
  // KamexAdapter is exported directly for the queue console, which needs the
  // Kamex-specific typed queueSnapshot() that the generic registry does not expose.
  exports: [EngineAdapterRegistry, KamexSqlboxRepository, KamexAdapter],
})
export class EngineModule {}
