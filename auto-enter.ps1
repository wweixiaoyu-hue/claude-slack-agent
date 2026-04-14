$logDir = "D:\Code\claude-slack-agent\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = "$logDir\auto-enter.log"
function L($m) { "$(Get-Date -Format 'HH:mm:ss.fff') $m" | Out-File $log -Append -Encoding utf8 }

L "=== auto-enter.ps1 started ==="
Start-Sleep -Seconds 3
L "after 3s sleep"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@

$procs = @(Get-Process claude -ErrorAction SilentlyContinue)
L "found $($procs.Count) claude processes"
foreach ($pp in $procs) {
    L "  PID=$($pp.Id) hwnd=$($pp.MainWindowHandle) title='$($pp.MainWindowTitle)'"
}

$p = $procs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) {
    L "NO claude process with window handle - attempting to find by title"
    # Fallback: find any process whose main window title contains "claude"
    $p = Get-Process | Where-Object { $_.MainWindowTitle -match 'claude' } | Select-Object -First 1
    if ($p) {
        L "found by title: PID=$($p.Id) title='$($p.MainWindowTitle)'"
    } else {
        L "still no match - aborting"
        exit
    }
}

$hwnd = $p.MainWindowHandle
L "targeting hwnd=$hwnd"

# ALT-key hack to grant ourselves foreground privilege
[Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[Win]::keybd_event(0x12, 0, 0x0002, [UIntPtr]::Zero)

$curThread = [Win]::GetCurrentThreadId()
$tgtThread = [Win]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
L "curThread=$curThread tgtThread=$tgtThread"

[Win]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
$attached = [Win]::AttachThreadInput($curThread, $tgtThread, $true)
L "AttachThreadInput=$attached"
$fg = [Win]::SetForegroundWindow($hwnd)
L "SetForegroundWindow=$fg"
[Win]::AttachThreadInput($curThread, $tgtThread, $false) | Out-Null

Start-Sleep -Milliseconds 400
try {
    (New-Object -ComObject wscript.shell).SendKeys('~')
    L "SendKeys ~ sent"
} catch {
    L "SendKeys failed: $_"
}
L "=== done ==="
