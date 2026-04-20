@echo off
title Arisan Manager
echo ========================================
echo   Arisan Manager
echo ========================================
echo.
echo Starting server...
echo Buka http://localhost:3001 di browser
echo.
echo Tekan Ctrl+C untuk stop server
echo ========================================
echo.
start http://localhost:3001
node server.js
pause
