import { validateEnvironment } from './environment';

describe('validateEnvironment', () => {
  it('returns safe defaults', () =>
    expect(validateEnvironment({})).toMatchObject({ nodeEnv: 'development', port: 3000 }));
  it('rejects invalid ports', () =>
    expect(() => validateEnvironment({ PORT: '0' })).toThrow('PORT'));
  it('requires service URLs in production', () =>
    expect(() => validateEnvironment({ NODE_ENV: 'production' })).toThrow('DATABASE_URL'));
});
