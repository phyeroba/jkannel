import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

type TokenType = 'access' | 'refresh';
export interface TokenClaims {
  sub: string;
  tid: string;
  sid: string;
  username: string;
  roles: string[];
  permissions: string[];
  typ: TokenType;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

@Injectable()
export class TokenService {
  private readonly issuer = 'jkannel';
  private readonly audience = 'jkannel-api';

  issue(
    type: TokenType,
    principal: Omit<TokenClaims, 'typ' | 'jti' | 'iat' | 'exp' | 'iss' | 'aud'>,
    key: string,
    lifetimeSeconds: number,
  ): string {
    this.validateKey(key);
    const now = Math.floor(Date.now() / 1000);
    const payload: TokenClaims = {
      ...principal,
      typ: type,
      jti: randomUUID(),
      iat: now,
      exp: now + lifetimeSeconds,
      iss: this.issuer,
      aud: this.audience,
    };
    const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
    return `${unsigned}.${this.sign(unsigned, key)}`;
  }

  verify(token: string, expectedType: TokenType, key: string): TokenClaims {
    this.validateKey(key);
    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('Invalid token');
    const [header, body, signature] = parts;
    const expected = Buffer.from(this.sign(`${header}.${body}`, key));
    const supplied = Buffer.from(signature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
      throw new UnauthorizedException('Invalid token');
    try {
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenClaims;
      const now = Math.floor(Date.now() / 1000);
      if (
        claims.typ !== expectedType ||
        claims.iss !== this.issuer ||
        claims.aud !== this.audience ||
        claims.exp <= now ||
        claims.iat > now + 30 ||
        !claims.sub ||
        !claims.tid ||
        !claims.sid
      )
        throw new Error();
      return claims;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private sign(value: string, key: string): string {
    return createHmac('sha256', key).update(value).digest('base64url');
  }
  private validateKey(key: string): void {
    if (!key || Buffer.byteLength(key) < 32)
      throw new Error('Authentication signing key must contain at least 32 bytes');
  }
}
