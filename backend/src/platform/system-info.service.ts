import { Injectable } from '@nestjs/common';

/**
 * The operational designation of this deployment, as an operator thinks of it.
 *
 * DELIBERATELY NOT `NODE_ENV`. That variable answers a Node.js question — which
 * build of the framework to run, whether to cache templates, how verbose to be —
 * and it only has three values. An operator needs a different question answered:
 * "am I about to reconnect a bind on the site that carries live traffic?" A DR
 * site and a production site both run `NODE_ENV=production`, and conflating them
 * is exactly the mistake this indicator exists to prevent.
 */
export type DeploymentEnvironment = 'production' | 'disaster-recovery' | 'staging' | 'development';

const ENVIRONMENT_LABELS: Record<DeploymentEnvironment, string> = {
  production: 'Production',
  'disaster-recovery': 'DR',
  staging: 'Staging',
  development: 'Development',
};

/**
 * How prominent the indicator should be. The console renders these; the backend
 * decides them, so every surface agrees without duplicating the policy.
 *
 * `production` is `critical` because the whole point of the chip is that an
 * operator about to take a disruptive action can see, without looking for it,
 * that this is the system carrying real traffic.
 */
const ENVIRONMENT_TONES: Record<DeploymentEnvironment, 'critical' | 'warning' | 'neutral'> = {
  production: 'critical',
  'disaster-recovery': 'warning',
  staging: 'warning',
  development: 'neutral',
};

export interface SystemInfo {
  environment: DeploymentEnvironment;
  environmentLabel: string;
  environmentTone: 'critical' | 'warning' | 'neutral';
  /** True when the designation was configured rather than guessed from NODE_ENV. */
  environmentDeclared: boolean;
  version: string;
  /** Build identity (commit SHA), or null when the image was not stamped. */
  build: string | null;
  /** The timezone the ENGINE's timestamps are in — see the note below. */
  gatewayTimezone: string;
  serverTime: string;
}

@Injectable()
export class SystemInfoService {
  /**
   * Resolves the deployment designation.
   *
   * When `JKANNEL_ENVIRONMENT` is unset we fall back to NODE_ENV, but report
   * `environmentDeclared: false` so the console can say the designation was
   * inferred. An inferred "Production" on what is really a DR site is worse than
   * an obviously-unlabelled one, and the operator should be able to tell which
   * they are looking at.
   */
  info(): SystemInfo {
    const declared = (process.env.JKANNEL_ENVIRONMENT ?? '').trim().toLowerCase();
    const known: DeploymentEnvironment[] = [
      'production',
      'disaster-recovery',
      'staging',
      'development',
    ];
    const environment = (known as string[]).includes(declared)
      ? (declared as DeploymentEnvironment)
      : this.fromNodeEnv();

    return {
      environment,
      environmentLabel:
        process.env.JKANNEL_ENVIRONMENT_LABEL?.trim() || ENVIRONMENT_LABELS[environment],
      environmentTone: ENVIRONMENT_TONES[environment],
      environmentDeclared: (known as string[]).includes(declared),
      version: process.env.JKANNEL_VERSION?.trim() || '0.1.0',
      build: process.env.JKANNEL_BUILD_SHA?.trim() || null,
      // The container's TZ, which is what the engine stamps its rows with. The
      // console renders user-local time and uses this to label the difference;
      // showing an operator a timestamp without saying whose clock it is on is
      // how incident timelines get misread across sites.
      gatewayTimezone:
        process.env.TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      serverTime: new Date().toISOString(),
    };
  }

  private fromNodeEnv(): DeploymentEnvironment {
    const nodeEnv = (process.env.NODE_ENV ?? '').trim().toLowerCase();
    if (nodeEnv === 'production') return 'production';
    if (nodeEnv === 'test') return 'development';
    return 'development';
  }
}
