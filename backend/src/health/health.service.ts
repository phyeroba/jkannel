import { Injectable } from '@nestjs/common';

export interface HealthStatus {
  service: 'jkannel-backend';
  status: 'ok';
  timestamp: string;
}

@Injectable()
export class HealthService {
  getStatus(): HealthStatus {
    return {
      service: 'jkannel-backend',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
