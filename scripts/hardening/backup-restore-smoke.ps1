[CmdletBinding()]
param(
  [string]$ComposeProject = 'jkannel',
  [string]$Service = 'postgres',
  [string]$OutputDirectory = ''
)
$ErrorActionPreference='Stop'
if(-not $OutputDirectory){$OutputDirectory=Join-Path $PSScriptRoot '..\..\artifacts\backup-smoke'}
$container="${ComposeProject}-${Service}-1"
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$dumpInContainer="/tmp/jkannel-smoke-$stamp.dump"
$dump=Join-Path $OutputDirectory "jkannel-$stamp.dump"
$restoreDb="jkannel_restore_smoke_$stamp" -replace '-','_'
$dbUser=(docker exec $container printenv POSTGRES_USER).Trim()
$dbName=(docker exec $container printenv POSTGRES_DB).Trim()
if(-not $dbUser -or -not $dbName){throw 'PostgreSQL container environment is incomplete'}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
try {
  docker exec $container pg_dump -U $dbUser --format=custom --no-owner --no-acl --dbname=$dbName --file=$dumpInContainer
  if($LASTEXITCODE -ne 0){throw 'pg_dump failed'}
  docker cp "${container}:${dumpInContainer}" $dump
  if($LASTEXITCODE -ne 0){throw 'docker cp failed'}
  $hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $dump).Hash.ToLowerInvariant()
  docker exec $container pg_restore --list $dumpInContainer | Out-Null
  if($LASTEXITCODE -ne 0){throw 'archive verification failed'}
  docker exec $container createdb -U $dbUser $restoreDb
  if($LASTEXITCODE -ne 0){throw 'disposable database creation failed'}
  docker exec $container pg_restore -U $dbUser --dbname=$restoreDb --no-owner --no-acl $dumpInContainer
  if($LASTEXITCODE -ne 0){throw 'isolated restore failed'}
  docker exec $container psql -U $dbUser --dbname=$restoreDb -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM schema_migrations'
  if($LASTEXITCODE -ne 0){throw 'restored database verification failed'}
  [pscustomobject]@{dump=$dump;sha256=$hash;restoreDatabase=$restoreDb;verified=$true}|ConvertTo-Json
} finally {
  docker exec $container dropdb -U $dbUser --if-exists $restoreDb 2>$null | Out-Null
  docker exec $container rm -f $dumpInContainer 2>$null | Out-Null
}
