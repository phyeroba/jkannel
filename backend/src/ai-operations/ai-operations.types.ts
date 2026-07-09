export type AssistanceStatus =
  'advisory' | 'approval_required' | 'approved' | 'rejected' | 'insufficient_data';
export interface AssistanceEvidence {
  source: string;
  observation: string;
  value?: number | string;
  unit?: string;
}
export interface AssistanceRequest {
  question: string;
  evidence: AssistanceEvidence[];
  allowRecommendation: boolean;
}
export interface AssistanceRecord {
  id: string;
  tenantId: string;
  requestedBy: string;
  question: string;
  evidence: AssistanceEvidence[];
  observedBehaviour: string;
  reasoning: string[];
  recommendation: string | null;
  confidence: number;
  risk: 'none' | 'low' | 'medium' | 'high';
  status: AssistanceStatus;
  model: { provider: 'local-rules'; version: 'phase15-v1' };
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
}
export interface AssistanceActor {
  tenantId: string;
  userId: string;
  correlationId?: string;
}
export interface AssistanceStore {
  save(actor: AssistanceActor, record: AssistanceRecord): Promise<void>;
  find(actor: AssistanceActor, id: string): Promise<AssistanceRecord | undefined>;
  approve(
    actor: AssistanceActor,
    id: string,
    decision: 'approve' | 'reject',
    reason: string,
  ): Promise<AssistanceRecord | undefined>;
}
export const AI_ASSISTANCE_STORE = Symbol('AI_ASSISTANCE_STORE');
