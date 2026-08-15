$targets = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' }
foreach ($t in $targets) { Stop-Process -Id $t.ProcessId -Force }
Write-Output ("stopped: " + $targets.Count)