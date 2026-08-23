@echo off
REM Serve Listboard locally for testing. Double-click, then open
REM http://localhost:8124 in any browser on this machine.
REM -c-1 disables caching so an edit shows up on a plain reload.
cd /d "%~dp0"
npx --yes http-server . -p 8124 -c-1 -o
