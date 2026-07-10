import { Injectable } from '@nestjs/common';
import { Actor, RoutingDepthRepository } from './routing-depth.repository';
import { SelectionResult, selectRoute } from './route-selection';

export interface ResolveRequest {
  msisdn: string;
  sender?: string | null;
  operator?: string | null;
  availableSmscIds?: string[] | null;
  rotation?: number;
  at?: Date;
}

export interface ResolveResponse extends SelectionResult {
  msisdn: string;
  /** How many enabled routes were considered. */
  candidatesConsidered: number;
}

/**
 * Advanced routing orchestration. The heavy CRUD/versioning lives in the
 * repository; this service owns the `resolve`/preview flow that turns a
 * destination into "which SMSC, and why" by loading the tenant's enabled routes
 * and running them through the pure {@link selectRoute} function.
 */
@Injectable()
export class RoutingDepthService {
  constructor(private readonly repository: RoutingDepthRepository) {}

  async resolve(actor: Actor, request: ResolveRequest): Promise<ResolveResponse> {
    const candidates = await this.repository.candidateRoutes(actor);
    const result = selectRoute(candidates, {
      msisdn: request.msisdn,
      sender: request.sender ?? null,
      operator: request.operator ?? null,
      now: request.at,
      availableSmscIds: request.availableSmscIds ?? null,
      rotation: request.rotation ?? 0,
    });
    return { msisdn: request.msisdn, candidatesConsidered: candidates.length, ...result };
  }
}
