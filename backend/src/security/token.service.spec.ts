import { UnauthorizedException } from '@nestjs/common';
import { TokenService } from './token.service';

describe('TokenService', () => {
  const service = new TokenService();
  const key = 'a-secure-test-key-with-at-least-32-bytes';
  const principal = {
    sub: 'user-1',
    tid: 'tenant-1',
    sid: 'session-1',
    username: 'operator',
    roles: ['operator'],
    permissions: ['dashboard.view'],
  };
  it('issues and verifies typed tokens', () =>
    expect(
      service.verify(service.issue('access', principal, key, 60), 'access', key),
    ).toMatchObject(principal));
  it('rejects tampering and type confusion', () => {
    const token = service.issue('refresh', principal, key, 60);
    expect(() => service.verify(`${token}x`, 'refresh', key)).toThrow(UnauthorizedException);
    expect(() => service.verify(token, 'access', key)).toThrow(UnauthorizedException);
  });
});
