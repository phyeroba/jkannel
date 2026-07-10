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
import { ExportService } from '../platform/export.service';
import { IDENTITY_STORE, PostgresIdentityRepository } from './identity.repository';
import { IdentityMfaService } from './identity-mfa.service';
import { IdentityMfaController } from './identity-mfa.controller';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { LoginHistoryService } from './identity-login-history.service';
import { LoginHistoryController } from './identity-login-history.controller';

@Module({
  controllers: [
    AuthController,
    SessionsController,
    IdentityMfaController,
    ApiKeysController,
    LoginHistoryController,
  ],
  providers: [
    DatabaseService,
    PostgresAuthRepository,
    { provide: AUTH_REPOSITORY, useExisting: PostgresAuthRepository },
    { provide: AUDIT_SINK, useExisting: PostgresAuthRepository },
    PostgresIdentityRepository,
    { provide: IDENTITY_STORE, useExisting: PostgresIdentityRepository },
    PasswordHasher,
    TokenService,
    AuthService,
    AuthGuard,
    PermissionsGuard,
    SessionAdminRepository,
    ExportService,
    IdentityMfaService,
    ApiKeysService,
    LoginHistoryService,
  ],
  exports: [PasswordHasher, TokenService, AuthService, AuthGuard, PermissionsGuard],
})
export class AuthModule {}
