# Life OS FX connector — one-click installer / updater for Windows.
# Run via LifeOS-FX-Setup.bat. Per-user install, no administrator rights needed.
#   - stops the old "Life Dashboard XM MT5" connector and disables its autostart
#   - migrates MT5 path / account / server and the state/ ledgers from the old install
#   - installs Python 3.12 (per user) when missing, creates a venv, installs requirements
#   - copies the connector to %LOCALAPPDATA%\LifeOS\fx-connector (ini and state/ are kept on update)
#   - runs a connection check, registers autostart at logon (auto-restart), and starts it
param([switch]$NoStart, [switch]$Quiet)
# Windows PowerShell 5.1 turns any stderr line of a native program into a terminating error when
# $ErrorActionPreference is "Stop". Keep it at "Continue" for native commands (checked via $LASTEXITCODE)
# and make every cmdlet stop on error instead.
$ErrorActionPreference = "Continue"
$PSDefaultParameterValues = @{ "*:ErrorAction" = "Stop" }
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$SetupLog = Join-Path $env:LOCALAPPDATA "LifeOS\fx-setup.log"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SetupLog) | Out-Null
try { Start-Transcript -Path $SetupLog -Force | Out-Null } catch { }
trap {
  Write-Host ""
  Write-Host "  失敗: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  記録: $SetupLog" -ForegroundColor Yellow
  Write-Host "  このファイルの内容を Claude に送ってください。" -ForegroundColor Yellow
  try { Stop-Transcript | Out-Null } catch { }
  exit 1
}

$Src = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # extracted zip folder
$Dest = Join-Path $env:LOCALAPPDATA "LifeOS\fx-connector"
$State = Join-Path $Dest "state"
$LogDir = Join-Path $State "logs"
$TaskName = "Life OS FX Connector"
$OldShortcutName = "Life Dashboard XM MT5 Connector.lnk"
$NewShortcutName = "Life OS FX Connector.lnk"

function Step($n, $text) { Write-Host ""; Write-Host "[$n/7] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  !!  $text" -ForegroundColor Yellow }
function Fail($text) { throw $text }

function Get-ConnectorProcesses([string]$pattern) {
  Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe' OR Name='py.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern }
}

Write-Host "Life OS FX コネクター セットアップ" -ForegroundColor White
Write-Host "インストール先: $Dest"

# ---------------------------------------------------------------- 1. stop old + current
Step 1 "動いているコネクターを停止"
$startup = [Environment]::GetFolderPath("Startup")
$oldShortcut = Join-Path $startup $OldShortcutName
$oldRoots = New-Object System.Collections.Generic.List[string]
if (Test-Path -LiteralPath $oldShortcut) {
  try {
    $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($oldShortcut)
    if ($sc.WorkingDirectory) { $oldRoots.Add($sc.WorkingDirectory) }
    elseif ($sc.TargetPath) { $oldRoots.Add((Split-Path -Parent $sc.TargetPath)) }
  } catch { }
}
foreach ($c in @((Join-Path $env:LOCALAPPDATA "LifeDashboard\XM-MT5"), (Join-Path $env:USERPROFILE "xm-mt5-connector"))) { $oldRoots.Add($c) }

# old connector: connector.py (not lifeos_connector.py) or start.cmd in an old root
$old = Get-ConnectorProcesses '(?<!lifeos_)connector\.py|XM-MT5|xm-mt5-connector'
foreach ($p in $old) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Ok "旧コネクターを停止しました (PID $($p.ProcessId))" } catch { Warn "PID $($p.ProcessId) を停止できませんでした: $_" }
}
if (-not $old) { Ok "旧コネクターは動いていません" }
if (Test-Path -LiteralPath $oldShortcut) {
  Move-Item -LiteralPath $oldShortcut -Destination ($oldShortcut + ".disabled") -Force
  Ok "旧コネクターの自動起動を無効にしました（$OldShortcutName.disabled）"
}
# current new connector (update case)
try { if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } } catch { }
$cur = Get-ConnectorProcesses 'lifeos_connector\.py|run-loop\.cmd'
foreach ($p in $cur) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { } }
if ($cur) { Ok "更新のため現在のコネクターを停止しました" }
$lock = Join-Path $State "connector.lock"
if (Test-Path -LiteralPath $lock) { Start-Sleep -Seconds 1; Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------- 2. copy files
Step 2 "ファイルを配置"
New-Item -ItemType Directory -Force -Path $Dest, $State, $LogDir | Out-Null
$keep = @("lifeos_connector.local.ini", "state", ".venv")
Get-ChildItem -LiteralPath $Src -Force | Where-Object { $keep -notcontains $_.Name -and $_.Name -ne "LifeOS-FX-Setup.bat" } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $Dest -Recurse -Force
}
Ok "コネクター一式をコピーしました"

# ---------------------------------------------------------------- 3. migrate from old install
Step 3 "旧コネクターの設定と台帳を引き継ぎ"
$oldRoot = $oldRoots | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ "config.json")) } | Select-Object -First 1
$mt5Path = ""; $mt5Login = ""; $mt5Server = ""; $symbolMap = ""
$localIni = Join-Path $Dest "lifeos_connector.local.ini"
$existingLocal = @{}
if (Test-Path -LiteralPath $localIni) {
  foreach ($line in Get-Content -LiteralPath $localIni -Encoding UTF8) { if ($line -match '^\s*([A-Za-z_]+)\s*=\s*(.*)$') { $existingLocal[$Matches[1].ToUpper()] = $Matches[2].Trim() } }
}
if ($oldRoot) {
  Ok "旧コネクターを見つけました: $oldRoot"
  try {
    $cfg = Get-Content -LiteralPath (Join-Path $oldRoot "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $mt5Path = [string]$cfg.terminal_path; $mt5Login = [string]$cfg.expected_login; $mt5Server = [string]$cfg.expected_server
    if ($cfg.symbol_map) {
      $traded = @("USDJPY", "EURJPY", "GBPJPY", "AUDJPY", "EURUSD", "GBPUSD", "AUDUSD")
      $pairs = @(); foreach ($prop in $cfg.symbol_map.PSObject.Properties) { $k = ($prop.Name -replace '[/_]', '').ToUpper(); if ($traded -contains $k) { $pairs += ("{0}_{1}:{2}" -f $k.Substring(0,3), $k.Substring(3,3), $prop.Value) } }
      $symbolMap = ($pairs -join ",")
    }
    Ok "MT5の設定を引き継ぎました（口座 $mt5Login / $mt5Server）"
  } catch { Warn "旧 config.json を読めませんでした: $_" }
  $oldState = Join-Path $oldRoot "state"
  if (Test-Path -LiteralPath $oldState) {
    $copied = 0
    foreach ($f in Get-ChildItem -LiteralPath $oldState -Filter *.json -File) {
      $target = Join-Path $State $f.Name
      if (-not (Test-Path -LiteralPath $target)) { Copy-Item -LiteralPath $f.FullName -Destination $target; $copied++ }
    }
    if ($copied) { Ok "台帳を $copied 件引き継ぎました（既存の台帳は上書きしません）" } else { Ok "引き継ぐ台帳はありません（すでにあります）" }
  }
} else { Ok "旧コネクターは見つかりませんでした（新規インストール）" }
# keep what the user already set in local.ini
if ($existingLocal["MT5_PATH"]) { $mt5Path = $existingLocal["MT5_PATH"] }
if ($existingLocal["MT5_LOGIN"]) { $mt5Login = $existingLocal["MT5_LOGIN"] }
if ($existingLocal["MT5_SERVER"]) { $mt5Server = $existingLocal["MT5_SERVER"] }
if ($existingLocal["SYMBOL_MAP"]) {
  $traded = @("USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_USD", "GBP_USD", "AUD_USD")
  $symbolMap = (($existingLocal["SYMBOL_MAP"] -split ",") | Where-Object { $_ -match '^\s*([A-Za-z]{3})[_/]?([A-Za-z]{3})\s*[:=]' -and ($traded -contains ("{0}_{1}" -f $Matches[1].ToUpper(), $Matches[2].ToUpper())) }) -join ","
}

# find MT5 when not known
if (-not $mt5Path -or -not (Test-Path -LiteralPath $mt5Path)) {
  $running = Get-Process terminal64 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($running -and $running.Path) { $mt5Path = $running.Path }
  else {
    $cands = @()
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:APPDATA "..\Local\Programs"))) {
      if ($root -and (Test-Path -LiteralPath $root)) { $cands += Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName "terminal64.exe" } | Where-Object { Test-Path -LiteralPath $_ } }
    }
    $xm = $cands | Where-Object { $_ -match 'XM' } | Select-Object -First 1
    $mt5Path = if ($xm) { $xm } else { $cands | Select-Object -First 1 }
  }
}
if (-not $mt5Path) { Fail "MT5（terminal64.exe）が見つかりません。XM の MT5 をインストールしてログインしてから、もう一度実行してください。" }
Ok "MT5: $mt5Path"

$terminalId = if ($existingLocal["TERMINAL_ID"]) { $existingLocal["TERMINAL_ID"] } else { "win-home" }
$lines = @("[lifeos]", "; このファイルはあなたの設定です。zip の更新で上書きされません。", "MT5_PATH=$mt5Path", "STATE_DIR=$State", "TERMINAL_ID=$terminalId")
if ($mt5Login) { $lines += "MT5_LOGIN=$mt5Login" }
if ($mt5Server) { $lines += "MT5_SERVER=$mt5Server" }
if ($symbolMap) { $lines += "SYMBOL_MAP=$symbolMap" }
if ($existingLocal["TIME_BASIS"]) { $tb = $existingLocal["TIME_BASIS"]; $lines += "TIME_BASIS=$tb" }
[System.IO.File]::WriteAllLines($localIni, $lines, (New-Object System.Text.UTF8Encoding($false)))
Ok "設定を書き込みました: lifeos_connector.local.ini"

# ---------------------------------------------------------------- 4. python
Step 4 "Python と必要なパッケージ"
function Find-Python {
  foreach ($v in @("3.12", "3.13", "3.11")) {
    try { $out = & py "-$v" -c "import platform,sys;print(sys.executable+'|'+platform.architecture()[0])" 2>$null; if ($LASTEXITCODE -eq 0 -and $out -match '\|64bit$') { return ($out -split '\|')[0] } } catch { }
  }
  foreach ($p in @((Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"), (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe"))) { if (Test-Path -LiteralPath $p) { return $p } }
  return $null
}
$py = Find-Python
if (-not $py) {
  Warn "Python 3.12 が見つからないためインストールします（数分かかります）"
  $installed = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    & winget install --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Host
    $installed = ($LASTEXITCODE -eq 0)
  }
  if (-not $installed) {
    $exe = Join-Path $env:TEMP "python-3.12-amd64.exe"
    Invoke-WebRequest -UseBasicParsing -Uri "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe" -OutFile $exe
    $p = Start-Process -FilePath $exe -ArgumentList "/quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_test=0" -Wait -PassThru
    if ($p.ExitCode -ne 0) { Fail "Python のインストールに失敗しました（コード $($p.ExitCode)）" }
  }
  $py = Find-Python
  if (-not $py) { Fail "Python をインストールしましたが見つかりません。PC を再起動してからもう一度実行してください。" }
}
Ok "Python: $py"
$venvPy = Join-Path $Dest ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPy)) {
  & $py -m venv (Join-Path $Dest ".venv")
  if ($LASTEXITCODE -ne 0) { Fail "Python の仮想環境を作れませんでした" }
}
& $venvPy -m pip install --disable-pip-version-check -q --upgrade pip | Out-Null
& $venvPy -m pip install --disable-pip-version-check -q -r (Join-Path $Dest "requirements.txt")
if ($LASTEXITCODE -ne 0) { Fail "パッケージ（requests / MetaTrader5）を入れられませんでした。ネットワークを確認してください。" }
Ok "パッケージを入れました"

# ---------------------------------------------------------------- 5. MT5 running + check
Step 5 "MT5 と Life OS への接続確認（注文は出しません）"
if (-not (Get-Process terminal64 -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath $mt5Path | Out-Null
  Warn "MT5 を起動しました。ログインが済むまで待ちます…"
  Start-Sleep -Seconds 20
}
$env:PYTHONIOENCODING = "utf-8"
Push-Location $Dest
$checkOut = & $venvPy lifeos_connector.py --check 2>&1 | ForEach-Object { "$_" } | Out-String
$checkCode = $LASTEXITCODE
Pop-Location
Write-Host $checkOut
$checkOut | Set-Content -LiteralPath (Join-Path $LogDir "last-check.txt") -Encoding UTF8
if ($checkCode -ne 0) {
  Warn "接続確認でエラーが出ました。上の内容を確認してください（MT5 にログインしているか、口座が正しいか）。"
  Warn "自動起動は登録しますが、問題が直るまでコネクターは新規の注文を出しません。"
} else { Ok "接続確認に成功しました" }

# ---------------------------------------------------------------- 6. autostart
Step 6 "Windows ログイン時の自動起動"
$runLoop = Join-Path $Dest "installer\run-loop.cmd"
$hidden = Join-Path $Dest "installer\run-hidden.vbs"
$registered = $false
try {
  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$hidden`"" -WorkingDirectory $Dest
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
  $registered = $true
  Ok "タスクスケジューラに登録しました（$TaskName）"
} catch { Warn "タスクスケジューラに登録できませんでした。スタートアップのショートカットで代用します。" }
$newShortcut = Join-Path $startup $NewShortcutName
if (-not $registered) {
  $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($newShortcut)
  $sc.TargetPath = "wscript.exe"; $sc.Arguments = "`"$hidden`""; $sc.WorkingDirectory = $Dest; $sc.Save()
  Ok "スタートアップに登録しました"
} elseif (Test-Path -LiteralPath $newShortcut) { Remove-Item -LiteralPath $newShortcut -Force }

# desktop shortcuts
$desk = [Environment]::GetFolderPath("Desktop")
$shell = New-Object -ComObject WScript.Shell
foreach ($s in @(@{n="Life OS FX 接続確認"; t=(Join-Path $Dest "installer\check.cmd")}, @{n="Life OS FX 停止"; t=(Join-Path $Dest "installer\stop.cmd")}, @{n="Life OS FX ログ"; t=$LogDir})) {
  $l = $shell.CreateShortcut((Join-Path $desk ($s.n + ".lnk"))); $l.TargetPath = $s.t; $l.WorkingDirectory = $Dest; $l.Save()
}
Ok "デスクトップに「接続確認」「停止」「ログ」を作りました"

# sleep (asks once)
if (-not $Quiet) {
  $ans = Read-Host "  電源接続中にPCがスリープしないよう設定しますか？ スリープ中は取引の管理が止まります [Y/n]"
  if ($ans -eq "" -or $ans -match '^[Yy]') { & powercfg /change standby-timeout-ac 0; & powercfg /change hibernate-timeout-ac 0; Ok "電源接続中のスリープを無効にしました" }
}

# ---------------------------------------------------------------- 7. start
Step 7 "コネクターを起動"
if (-not $NoStart) {
  if ($registered) { Start-ScheduledTask -TaskName $TaskName } else { Start-Process -FilePath "wscript.exe" -ArgumentList "`"$hidden`"" -WorkingDirectory $Dest }
  Start-Sleep -Seconds 8
  if (Get-ConnectorProcesses 'lifeos_connector\.py') { Ok "起動しました。Life OS の FX → 設定・接続 で「接続中」になっていれば完了です。" }
  else { Warn "起動を確認できませんでした。デスクトップの「Life OS FX ログ」を確認してください。" }
}
Write-Host ""
Write-Host "セットアップが終わりました。ルールは Life OS の FX 画面で ON にするまで発注しません。" -ForegroundColor Green
try { Stop-Transcript | Out-Null } catch { }
exit 0
