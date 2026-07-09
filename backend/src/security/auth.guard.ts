import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenService } from './token.service';
import { AuthenticatedPrincipal } from './auth.types';
import { accessTokenKey } from './signing-keys';

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  principal?: AuthenticatedPrincipal;
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer '))
      throw new UnauthorizedException('Bearer token required');
    const claims = this.tokens.verify(header.slice(7), 'access', accessTokenKey());
    request.principal = {
      tenantId: claims.tid,
      userId: claims.sub,
      sessionId: claims.sid,
      username: claims.username,
      roles: claims.roles,
      permissions: claims.permissions,
    };
    return true;
  }
}
