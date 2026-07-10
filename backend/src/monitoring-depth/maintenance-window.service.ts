import { Injectable } from '@nestjs/common';

/**
 * A maintenance window's scope. `all` suppresses everything for the tenant;
 * otherwise a target is covered when its smsc/route id is listed.
 */
export interface MaintenanceScope {
  all?: boolean;
  smscs?: string[];
  routes?: string[];
}

export interface MaintenanceWindow {
  id: string;
  name: string;
  starts_at: string | Date;
  ends_at: string | Date;
  scope: MaintenanceScope;
}

/** What an alert/escalation touches, used to decide suppression. */
export interface SuppressionTarget {
  smsc?: string;
  route?: string;
}

/**
 * Pure decision logic for maintenance-window suppression. The database-backed
 * CRUD/listing lives in {@link MonitoringDepthRepository}; the evaluator and the
 * escalation runner load the tenant's active windows and consult
 * {@link isSuppressed} before opening or advancing alerts for a scope.
 */
@Injectable()
export class MaintenanceWindowService {
  /** True when `now` falls inside the window [starts_at, ends_at). */
  isActive(window: MaintenanceWindow, now: Date): boolean {
    const start = new Date(window.starts_at).getTime();
    const end = new Date(window.ends_at).getTime();
    const t = now.getTime();
    return t >= start && t < end;
  }

  /** True when the window's scope covers the given target. */
  scopeCovers(scope: MaintenanceScope, target: SuppressionTarget): boolean {
    if (scope?.all) return true;
    if (target.smsc && scope?.smscs?.includes(target.smsc)) return true;
    if (target.route && scope?.routes?.includes(target.route)) return true;
    return false;
  }

  /**
   * True when at least one supplied window is active at `now` and covers the
   * target. Callers pass the tenant's windows (typically the active subset).
   */
  isSuppressed(now: Date, target: SuppressionTarget, windows: MaintenanceWindow[]): boolean {
    return windows.some((w) => this.isActive(w, now) && this.scopeCovers(w.scope, target));
  }
}
