[CmdletBinding()]
param([uri]$HealthUri='http://localhost:3000/api/v1/health',[ValidateRange(1,10000)][int]$Requests=100,[ValidateRange(1,100)][int]$Concurrency=10,[ValidateRange(1,60000)][int]$P95LimitMs=1000)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Net.Http
$handler=New-Object Net.Http.HttpClientHandler
$client=New-Object Net.Http.HttpClient($handler)
$client.Timeout=[TimeSpan]::FromSeconds(5)
$results=@()
try {
  for($offset=0;$offset -lt $Requests;$offset+=$Concurrency){
    $batchSize=[Math]::Min($Concurrency,$Requests-$offset)
    $watch=[Diagnostics.Stopwatch]::StartNew()
    $tasks=@(1..$batchSize|ForEach-Object{$client.GetAsync($HealthUri)})
    try{[Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$tasks);$elapsed=$watch.Elapsed.TotalMilliseconds;foreach($task in $tasks){$results+=[pscustomobject]@{ok=$task.Result.IsSuccessStatusCode;ms=$elapsed;status=[int]$task.Result.StatusCode}}}
    catch{$elapsed=$watch.Elapsed.TotalMilliseconds;1..$batchSize|ForEach-Object{$results+=[pscustomobject]@{ok=$false;ms=$elapsed;status=0}}}
  }
} finally {$client.Dispose();$handler.Dispose()}
$ordered=@($results.ms|Sort-Object);$index=[Math]::Max(0,[Math]::Ceiling($ordered.Count*0.95)-1);$p95=[Math]::Round($ordered[$index],2);$failures=@($results|Where-Object{-not $_.ok}).Count
$summary=[pscustomobject]@{requests=$Requests;concurrency=$Concurrency;failures=$failures;p95Ms=$p95;limitMs=$P95LimitMs}
$summary|ConvertTo-Json
if($failures -gt 0){throw "$failures readiness requests failed"};if($p95 -gt $P95LimitMs){throw "p95 $p95 ms exceeded $P95LimitMs ms smoke threshold"}
