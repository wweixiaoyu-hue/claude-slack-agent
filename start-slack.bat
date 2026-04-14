@echo off
cd /d D:\Code\claude-slack-agent
:loop
echo [%date% %time%] Starting Claude Code...
claude --dangerously-skip-permissions --dangerously-load-development-channels server:slack
echo [%date% %time%] Exited with code %ERRORLEVEL%, restarting in 3s...
timeout /t 3 /nobreak >nul
goto loop
