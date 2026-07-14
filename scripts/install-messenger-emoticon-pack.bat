@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Usage:
rem   install-messenger-emoticon-pack.bat [source-pack-folder]
rem
rem If no source folder is passed, the script uses its own directory.
rem The target is:
rem   <PePe install dir>\messenger-emoticons\<pack-folder-name>

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
  echo [INFO] Requesting administrator privileges...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList @('%*') -Verb RunAs"
  exit /b
)

set "SRC=%~1"
if not defined SRC set "SRC=%~dp0"
for %%I in ("%SRC%") do set "SRC=%%~fI"
if not exist "%SRC%\." (
  echo [ERROR] Source folder not found: "%SRC%"
  exit /b 1
)

set "INSTALL_DIR=%PEPE_INSTALL_DIR%"
if not defined INSTALL_DIR (
  if exist "C:\Program Files (x86)\PePe Terminal(SSH)\PePe Terminal(SSH).exe" set "INSTALL_DIR=C:\Program Files (x86)\PePe Terminal(SSH)"
  if not defined INSTALL_DIR if exist "C:\Program Files\PePe Terminal(SSH)\PePe Terminal(SSH).exe" set "INSTALL_DIR=C:\Program Files\PePe Terminal(SSH)"
  if not defined INSTALL_DIR if exist "%LocalAppData%\Programs\PePe Terminal(SSH)\PePe Terminal(SSH).exe" set "INSTALL_DIR=%LocalAppData%\Programs\PePe Terminal(SSH)"
  if not defined INSTALL_DIR if exist "%~dp0PePe Terminal(SSH).exe" set "INSTALL_DIR=%~dp0"
  if not defined INSTALL_DIR if exist "%~dp0..\PePe Terminal(SSH).exe" set "INSTALL_DIR=%~dp0.."
)

if not defined INSTALL_DIR (
  echo [ERROR] Could not detect the PePe install directory.
  echo         Set PEPE_INSTALL_DIR or place this script next to the installed EXE.
  exit /b 1
)

for %%I in ("%SRC%") do set "PACK_NAME=%%~nxI"
set "TARGET_DIR=%INSTALL_DIR%\messenger-emoticons\%PACK_NAME%"

if not exist "%INSTALL_DIR%\messenger-emoticons" mkdir "%INSTALL_DIR%\messenger-emoticons" >nul 2>nul
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%" >nul 2>nul

echo [INFO] Copying pack:
echo        "%SRC%"
echo   ->   "%TARGET_DIR%"

robocopy "%SRC%" "%TARGET_DIR%" /MIR /NFL /NDL /NJH /NJS /NP >nul
set "RC=%ERRORLEVEL%"

if %RC% GEQ 8 (
  echo [ERROR] Robocopy failed with code %RC%.
  pause
  exit /b %RC%
)

echo [OK] Installed.
echo.
pause
exit /b 0
