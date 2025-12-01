@echo off & setlocal EnableDelayedExpansion
title DJMSERVER Setup & color 07

net session >nul 2>&1 || (echo [!] Admin permissions required. & pause & exit)

call :check_node || call :install_node

if not exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%PATH%;%ProgramFiles%\nodejs"

if exist package.json (
    echo. & echo [NPM] Installing dependencies...
    call npm install
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
    echo [SYS] Node.js not found or too old.
    echo [SYS] Downloading Node.js v23.1.0...
    
    powershell -nop -c "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest 'https://nodejs.org/dist/v23.1.0/node-v23.1.0-x64.msi' -OutFile 'node.msi'"
    
    if not exist node.msi (
        echo [!] Download failed. Check internet connection.
        pause & exit
    )

    echo [SYS] Installing... (This may take a moment)
    start /wait msiexec /i node.msi /qn
    del node.msi
    
    set "PATH=%PATH%;C:\Program Files\nodejs\"
    
    echo [SYS] Node.js installed.
    exit /b 0
