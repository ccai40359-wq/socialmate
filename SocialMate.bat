@echo off
rem SocialMate launcher (route A: repo dir + manual enable).
rem Pins the packaged app's data root to THIS folder so it reuses the same
rem edge-profile (X login state), secrets.json, provider.json, config.json,
rem queue and log the dev build already uses. Double-click to open.
setlocal
set "SOCIALMATE_DATA_DIR=%~dp0"
set "SOCIALMATE_DATA_DIR=%SOCIALMATE_DATA_DIR:~0,-1%"
set "EXE="
for /f "delims=" %%f in ('dir /b /o-d "%~dp0dist\SocialMate-*-portable.exe" 2^>nul') do if not defined EXE set "EXE=%~dp0dist\%%f"
if not defined EXE (
  echo [SocialMate] No packaged exe found in dist\.
  echo Run "npm run dist" first, or launch the dev build with "npm run app".
  pause
  exit /b 1
)
echo [SocialMate] data root: %SOCIALMATE_DATA_DIR%
echo [SocialMate] launching: %EXE%
start "" "%EXE%"
endlocal
