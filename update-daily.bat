@echo off
setlocal
REM ============================================================
REM  LimitUp Dashboard - Daily Auto Update
REM  Fetches today's A-share limit-up data and pushes to GitHub.
REM  Designed to be triggered by Windows Task Scheduler.
REM ============================================================

set "ROOT=D:\workbuddy\2026-10-20-21-06-21\limitup-dashboard"
set "NODE=C:\Users\t1511\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

cd /d "%ROOT%" || exit /b 1

REM Make sure git is reachable (portable git may not be on PATH in scheduler)
where git >nul 2>&1
if errorlevel 1 set "PATH=%PATH%;D:\soft\WorkBuddy\resources\vendor\PortableGit\mingw64\bin"

REM Disable local proxy so git push does not get reset by the proxy
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "http_proxy="
set "https_proxy="
set "ALL_PROXY="
set "all_proxy="

REM Fetch data (script connects directly to Eastmoney + 10jqka, no proxy)
"%NODE%" fetch/limitup.mjs
if errorlevel 1 (
  echo [ERR] fetch failed
  exit /b 1
)

REM Commit + push only when there are changes
git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "data: auto update %DATE%"
  git push
  echo [OK] updated and pushed
) else (
  echo [SKIP] no data change today
)

endlocal
