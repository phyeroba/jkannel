import { Module } from '@nestjs/common';
import { PasswordHasher } from './password-hasher';
import { TokenService } from './token.service';
import { DatabaseService } from '../database/database.service';
import { AUDIT_SINK, AUTH_REPOSITORY } from './auth.ports';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PostgresAuthRepository } from './postgres-auth.repository';
import { AuthGuard } from './auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { SessionsController } from './sessions.controller';
import { SessionAdminRepository } from './session-admin.repository';

@Module({
  controllers: [AuthController, SessionsController],
  providers: [
    DatabaseService,
    PostgresAuthRepository,
    { provide: AUTH_REPOSITORY, useExisting: PostgresAuthRepository },
    { provide: AUDIT_SINK, useExisting: PostgresAuthRepository },
    PasswordHasher,
    TokenService,
    AuthService,
    AuthGuard,
    PermissionsGuard,
    SessionAdminRepository,
  ],
  exports: [PasswordHasher, TokenService, AuthService, AuthGuard, PermissionsGuard],
})
export class AuthModule {}
