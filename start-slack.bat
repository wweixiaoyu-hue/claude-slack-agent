@echo off
cd /d D:\Code\claude-slack-agent
if not exist logs mkdir logs
echo [%date% %time%] Starting Claude Code... >> logs\wrapper.log
echo [%date% %time%] Starting Claude Code...
start "" /b wscript "%~dp0auto-enter.vbs"
claude --dangerously-skip-permissions --dangerously-load-development-channels server:slack
echo [%date% %time%] Claude Code exited with code %ERRORLEVEL% >> logs\wrapper.log
echo [%date% %time%] Exited with code %ERRORLEVEL%
