@echo off & setlocal EnableDelayedExpansion
title DJMSERVER Setup & color 07

net session >nul 2>&1 || (echo [!] Admin permissions required. & pause & exit)

call :check_node || call :install_node

if exist package.json (
    echo. & echo [NPM] Installing dependencies...
    call npm install --no-audit --no-fund --loglevel=error --progress=true
    echo [OK] Setup complete.
) else (
    echo [!] package.json missing.
)

pause & exit

:check_node
    node -v >nul 2>&1 || exit /b 1
    for /f "delims=." %%v in ('node -v') do set "v=%%v"
    if !v:v=! LSS 23 exit /b 1
    echo [SYS] Node.js !v! detected.
    exit /b 0

:install_node
    echo [SYS] Installing Node.js v23...
    powershell -nop -c "Invoke-WebRequest 'https://nodejs.org/dist/latest-v23.x/win-x64/node-v23.1.0-x64.msi' -OutFile 'node.msi'"
    start /wait msiexec /i node.msi /qn
    del node.msi
    set "PATH=%PATH%;C:\Program Files\nodejs\"
    echo [SYS] Node.js installed.
    exit /b 0