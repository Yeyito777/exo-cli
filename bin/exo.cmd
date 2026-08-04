@echo off
setlocal

set "PROJECT_DIR=%~dp0.."
set "BUN="
for %%I in (bun.exe) do set "BUN=%%~$PATH:I"

if not defined BUN if exist "%USERPROFILE%\.bun\bin\bun.exe" (
  set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
)

if not defined BUN (
  >&2 echo   x bun is required but was not found.
  >&2 echo     Install: powershell -c "irm bun.sh/install.ps1 ^| iex"
  exit /b 1
)

"%BUN%" run "%PROJECT_DIR%\src\main.ts" %*
exit /b %ERRORLEVEL%
