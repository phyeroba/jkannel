import { BadRequestException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';

/**
 * A malformed request to an UNAUTHENTICATED endpoint must be a 400, not a 500.
 *
 * `POST /auth/login` read `body.tenant` off whatever `@Body()` handed it. The
 * decorator is a type annotation, not a validator, so a request with no body —
 * or a non-JSON one — arrived as `undefined` and the read threw. Production
 * answered with `HTTP_500 INTERNAL_SERVER_ERROR` and logged an
 * `UnhandledException`, for a request that was simply wrong.
 *
 * That matters more here than on an authenticated route. Anyone who can reach
 * the login form can reach this, so the 500 was provokable without credentials
 * — noise in the error log that looks like a server fault and is not one.
 */
describe('AuthController input validation', () => {
  const service = {
    login: jest.fn().mockResolvedValue({ accessToken: 'token' }),
    refresh: jest.fn().mockResolvedValue({ accessToken: 'token' }),
  } as unknown as AuthService;
  const controller = new AuthController(service);
  const request = { clientIp: '127.0.0.1', headers: {} } as never;

  beforeEach(() => jest.clearAllMocks());

  // `undefined` is what an absent body actually produces; the others are the
  // shapes a JSON parser yields for a body that parsed but is not an object.
  it.each([
    ['an absent body', undefined],
    ['a null body', null],
    ['a string body', 'username=operator'],
    ['a numeric body', 7],
  ])('rejects %s with 400 rather than throwing', (_label, body) => {
    expect(() => controller.login(body as never, request)).toThrow(BadRequestException);
    expect(service.login).not.toHaveBeenCalled();
  });

  it('rejects a malformed refresh body with 400', () => {
    expect(() => controller.refresh(undefined as never, request)).toThrow(BadRequestException);
    expect(service.refresh).not.toHaveBeenCalled();
  });

  // The guard must not start rejecting real traffic. A body missing a FIELD is
  // still a well-formed request and belongs to the auth service, which answers
  // 401 without saying which field was wrong.
  it('passes a well-formed body through, including one with fields missing', () => {
    controller.login({ tenant: '1', username: 'operator', password: 'x' } as never, request);
    expect(service.login).toHaveBeenCalledWith('1', 'operator', 'x', expect.anything(), {
      totp: undefined,
      recoveryCode: undefined,
    });

    controller.login({} as never, request);
    expect(service.login).toHaveBeenCalledTimes(2);
  });
});
