import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_SECURITY_POLICY,
  SECURITY_SETTING_KEYS,
  SecurityPolicyService,
  SecuritySettingsSource,
} from './security-policy.service';

class FakeSettings implements SecuritySettingsSource {
  calls = 0;
  failNext = false;
  constructor(public rows: Record<string, unknown> = {}) {}
  async loadSecuritySettings(): Promise<Record<string, unknown>> {
    this.calls += 1;
    if (this.failNext) throw new Error('database unavailable');
    return this.rows;
  }
}

describe('SecurityPolicyService', () => {
  it('uses the pre-wiring hardcoded behaviour when no settings source is available', async () => {
    const policy = await new SecurityPolicyService().resolve('1');
    expect(policy).toEqual(DEFAULT_SECURITY_POLICY);
    expect(policy.lockoutThreshold).toBe(5);
    expect(policy.lockoutMinutes).toBe(15);
    expect(policy.accessTokenTtlSeconds).toBe(900);
  });

  it('applies stored overrides', async () => {
    const service = new SecurityPolicyService(
      new FakeSettings({
        [SECURITY_SETTING_KEYS.lockoutThreshold]: 3,
        [SECURITY_SETTING_KEYS.lockoutMinutes]: 45,
        [SECURITY_SETTING_KEYS.sessionIdleTimeoutMinutes]: 30,
        [SECURITY_SETTING_KEYS.passwordRequireSymbol]: true,
      }),
    );
    const policy = await service.resolve('1');
    expect(policy.lockoutThreshold).toBe(3);
    expect(policy.lockoutMinutes).toBe(45);
    expect(policy.sessionIdleTimeoutMinutes).toBe(30);
    expect(policy.passwordRequireSymbol).toBe(true);
  });

  // The whole point of clamping at the point of use: the settings endpoint is a
  // generic key/value writer, so an operator can put any number in the row.
  it('clamps the minimum password length UP to 12 and never below it', () => {
    expect(
      SecurityPolicyService.merge({ [SECURITY_SETTING_KEYS.passwordMinLength]: 4 })
        .passwordMinLength,
    ).toBe(12);
    expect(
      SecurityPolicyService.merge({ [SECURITY_SETTING_KEYS.passwordMinLength]: 20 })
        .passwordMinLength,
    ).toBe(20);
    expect(
      SecurityPolicyService.merge({ [SECURITY_SETTING_KEYS.passwordMinLength]: 9999 })
        .passwordMinLength,
    ).toBe(128);
  });

  it('clamps every other bounded knob into its safe range', () => {
    const merged = SecurityPolicyService.merge({
      [SECURITY_SETTING_KEYS.lockoutThreshold]: 1,
      [SECURITY_SETTING_KEYS.lockoutMinutes]: 99999,
      [SECURITY_SETTING_KEYS.accessTokenTtlSeconds]: 1,
      [SECURITY_SETTING_KEYS.passwordHistoryDepth]: 500,
    });
    expect(merged.lockoutThreshold).toBe(3);
    expect(merged.lockoutMinutes).toBe(1440);
    expect(merged.accessTokenTtlSeconds).toBe(300);
    expect(merged.passwordHistoryDepth).toBe(24);
  });

  it('reads 0 as "disabled" for the session knobs and as "unlimited" for the cap', () => {
    const merged = SecurityPolicyService.merge({
      [SECURITY_SETTING_KEYS.sessionIdleTimeoutMinutes]: 0,
      [SECURITY_SETTING_KEYS.sessionMaxLifetimeHours]: 0,
      [SECURITY_SETTING_KEYS.maxConcurrentSessions]: 0,
    });
    expect(merged.sessionIdleTimeoutMinutes).toBe(0);
    expect(merged.sessionMaxLifetimeHours).toBe(0);
    expect(merged.maxConcurrentSessions).toBe(0);
  });

  it('ignores unusable values rather than letting them disable a control', () => {
    const merged = SecurityPolicyService.merge({
      [SECURITY_SETTING_KEYS.lockoutThreshold]: 'not a number',
      [SECURITY_SETTING_KEYS.passwordRequireNumber]: 'maybe',
    });
    expect(merged.lockoutThreshold).toBe(DEFAULT_SECURITY_POLICY.lockoutThreshold);
    expect(merged.passwordRequireNumber).toBe(DEFAULT_SECURITY_POLICY.passwordRequireNumber);
  });

  it('caches per tenant and re-reads after invalidation', async () => {
    const source = new FakeSettings({ [SECURITY_SETTING_KEYS.lockoutThreshold]: 7 });
    const service = new SecurityPolicyService(source);
    await service.resolve('1');
    await service.resolve('1');
    expect(source.calls).toBe(1);
    await service.resolve('2');
    expect(source.calls).toBe(2);
    service.invalidate();
    await service.resolve('1');
    expect(source.calls).toBe(3);
  });

  it('degrades to the strict defaults when the settings lookup fails', async () => {
    const source = new FakeSettings({ [SECURITY_SETTING_KEYS.lockoutThreshold]: 7 });
    source.failNext = true;
    const policy = await new SecurityPolicyService(source).resolve('1');
    expect(policy).toEqual(DEFAULT_SECURITY_POLICY);
  });

  describe('password validation', () => {
    it('accepts a password that meets every requirement', () => {
      expect(() =>
        SecurityPolicyService.assertPasswordAllowed('Correct horse 42 staple', {
          ...DEFAULT_SECURITY_POLICY,
        }),
      ).not.toThrow();
    });

    it('names every unmet requirement in one message', () => {
      let message = '';
      try {
        SecurityPolicyService.assertPasswordAllowed('short', {
          ...DEFAULT_SECURITY_POLICY,
          passwordRequireSymbol: true,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        message = (error as BadRequestException).message;
      }
      expect(message).toContain('at least 12 characters');
      expect(message).toContain('uppercase');
      expect(message).toContain('digit');
      expect(message).toContain('symbol');
      // Never echoes the submitted password back to the caller or the log.
      expect(message).not.toContain('short');
    });

    it('rejects on complexity even when the password is long enough', () => {
      expect(() =>
        SecurityPolicyService.assertPasswordAllowed('all lowercase and long', {
          ...DEFAULT_SECURITY_POLICY,
        }),
      ).toThrow(BadRequestException);
    });

    it('accepts a simple long password once complexity is switched off', () => {
      expect(() =>
        SecurityPolicyService.assertPasswordAllowed('all lowercase and long', {
          ...DEFAULT_SECURITY_POLICY,
          passwordRequireUppercase: false,
          passwordRequireNumber: false,
        }),
      ).not.toThrow();
    });
  });
});
