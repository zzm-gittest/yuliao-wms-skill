@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title yuliao-wms-skill installer (Windows)

set "SCRIPT_DIR=%~dp0"
echo ============================================
echo   yuliao-wms-skill installer for dsh
echo ============================================
echo.
echo This installs the WMS/ERP assistant plugins into your local
echo deepseek-harness (dsh) source checkout. Prerequisites:
echo   - dsh source cloned (github.com/deepseek-ai/deepseek-harness)
echo   - Node.js ^>= 24.9 and pnpm installed
echo.

set "DSH_DIR="
set /p DSH_DIR=Enter the full path of your dsh repo (e.g. E:\idea-work\deepseek-harness): 
if "%DSH_DIR%"=="" goto :badpath
if not exist "%DSH_DIR%\pnpm-workspace.yaml" goto :badpath
if not exist "%DSH_DIR%\packages\bundle\web-app\cordis.patch.yml" goto :badpath

echo.
echo [1/5] Copying plugin packages...
robocopy "%SCRIPT_DIR%packages\wms-ai" "%DSH_DIR%\packages\experimental\wms-ai" /E /NFL /NDL /NJH /NJS >nul
if errorlevel 8 goto :copyfail
robocopy "%SCRIPT_DIR%packages\wms-llm-bridge" "%DSH_DIR%\packages\experimental\wms-llm-bridge" /E /NFL /NDL /NJH /NJS >nul
if errorlevel 8 goto :copyfail
if not exist "%DSH_DIR%\overlays" mkdir "%DSH_DIR%\overlays"
copy /Y "%SCRIPT_DIR%overlays\wms-dsh-bridge.yml" "%DSH_DIR%\overlays\" >nul
echo       OK

echo [2/5] Registering plugins (idempotent patch)...
pushd "%DSH_DIR%"
node "%SCRIPT_DIR%patches\apply-wms-patch.mjs" "%DSH_DIR%"
if errorlevel 1 goto :fail
popd

echo [3/5] pnpm install (may take a few minutes)...
pushd "%DSH_DIR%"
call pnpm install
if errorlevel 1 goto :fail

echo [4/5] Building wms-ai...
node node_modules\typescript\bin\tsc -b packages\experimental\wms-ai
if errorlevel 1 goto :fail
pushd packages\experimental\wms-ai
node ..\..\..\node_modules\tsdown\dist\run.mjs
if errorlevel 1 goto :fail
popd

echo [5/5] Building wms-llm-bridge...
node node_modules\typescript\bin\tsc -b packages\experimental\wms-llm-bridge
if errorlevel 1 goto :fail
pushd packages\experimental\wms-llm-bridge
node ..\..\..\node_modules\tsdown\dist\run.mjs
if errorlevel 1 goto :fail
popd
popd

echo.
echo ============================================
echo   INSTALL SUCCESSFUL
echo ============================================
echo Start dsh web with:
echo   cd /d "%DSH_DIR%"
echo   pnpm dsh web --patch ./overlays/wms-dsh-bridge.yml
echo Then open the web UI and type /yuliao-erp in the chat box.
echo.
pause
exit /b 0

:badpath
echo.
echo [ERROR] "%DSH_DIR%" does not look like a dsh repo
echo         (pnpm-workspace.yaml or cordis.patch.yml not found).
echo Please clone deepseek-harness first, then re-run this installer.
pause
exit /b 1

:copyfail
echo.
echo [ERROR] File copy failed (robocopy exit code 8+).
popd >nul 2>&1
pause
exit /b 1

:fail
echo.
echo [ERROR] A step failed. See messages above.
popd >nul 2>&1
pause
exit /b 1
