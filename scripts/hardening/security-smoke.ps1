[CmdletBinding()]
param([uri]$BaseUri='http://localhost:3000/api/v1')
$ErrorActionPreference='Stop'
$healthUri=[uri]::new($BaseUri,'health')
$response=Invoke-WebRequest -UseBasicParsing -Uri $healthUri -Method Get
if($response.StatusCode -ne 200){throw "Health endpoint returned $($response.StatusCode)"}
$required=@{'X-Content-Type-Options'='nosniff';'X-Frame-Options'='DENY';'Referrer-Policy'='no-referrer';'Cache-Control'='no-store'}
foreach($entry in $required.GetEnumerator()){
  $actual=[string]$response.Headers[$entry.Key]
  if($actual -notlike "*$($entry.Value)*"){throw "Missing or invalid $($entry.Key) header"}
}
if(-not $response.Headers['X-Request-Id']){throw 'Missing request correlation header'}
[pscustomobject]@{endpoint=$healthUri.AbsoluteUri;status=$response.StatusCode;headersVerified=$required.Keys}|ConvertTo-Json
