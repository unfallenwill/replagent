param([int]$RootProcessId)

# Keep descendant identities even when an intermediate shell exits on timeout.
# Only PIDs with the same creation time are eligible for cleanup.
$knownProcesses = [System.Collections.Generic.Dictionary[int,long]]::new()
$rootProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $RootProcessId" -ErrorAction Stop
if ($null -eq $rootProcess) { throw 'Evaluation worker exited before process tracking started.' }
$knownProcesses.Add($RootProcessId, $rootProcess.CreationDate.ToUniversalTime().Ticks)

function Update-Descendants {
    $inventory = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $byId = @{}
    foreach ($scopeProcess in $inventory) { $byId[[int]$scopeProcess.ProcessId] = $scopeProcess }
    do {
        $added = $false
        foreach ($scopeProcess in $inventory) {
            $childId = [int]$scopeProcess.ProcessId
            $parentId = [int]$scopeProcess.ParentProcessId
            if ($knownProcesses.ContainsKey($childId) -or -not $knownProcesses.ContainsKey($parentId)) { continue }
            $parent = $byId[$parentId]
            if ($null -ne $parent -and $parent.CreationDate.ToUniversalTime().Ticks -ne $knownProcesses[$parentId]) { continue }
            $knownProcesses.Add($childId, $scopeProcess.CreationDate.ToUniversalTime().Ticks)
            $added = $true
        }
    } while ($added)
}

Update-Descendants
Add-Type -TypeDefinition 'public static class EvalStopSignal { public static volatile bool Stopped; public static void Start() { var thread = new System.Threading.Thread(() => { System.Console.ReadLine(); Stopped = true; }); thread.IsBackground = true; thread.Start(); } }'
[EvalStopSignal]::Start()
[Console]::Out.WriteLine('{"type":"ready"}')
while (-not [EvalStopSignal]::Stopped) {
    Update-Descendants
    Start-Sleep -Milliseconds 500
}
Update-Descendants
function Stop-ObservedRoots {
    $liveOwned = @{}
    foreach ($scopeProcess in @(Get-CimInstance Win32_Process)) {
        $knownId = [int]$scopeProcess.ProcessId
        if ($knownProcesses.ContainsKey($knownId) -and $scopeProcess.CreationDate.ToUniversalTime().Ticks -eq $knownProcesses[$knownId]) {
            $liveOwned[$knownId] = $scopeProcess
        }
    }
    foreach ($scopeProcess in $liveOwned.Values) {
        if (-not $liveOwned.ContainsKey([int]$scopeProcess.ParentProcessId)) {
            & taskkill.exe /PID $scopeProcess.ProcessId /T /F >$null 2>$null
        }
    }
}
# Work scales with surviving roots, rather than every child that ever exited.
Stop-ObservedRoots
Start-Sleep -Milliseconds 100
Stop-ObservedRoots
$remaining = 0
foreach ($scopeProcess in @(Get-CimInstance Win32_Process)) {
    $knownId = [int]$scopeProcess.ProcessId
    if ($knownProcesses.ContainsKey($knownId) -and $scopeProcess.CreationDate.ToUniversalTime().Ticks -eq $knownProcesses[$knownId]) { $remaining++ }
}
[Console]::Out.WriteLine(('{"type":"closed","tracked":' + $knownProcesses.Count + ',"remaining":' + $remaining + '}'))
