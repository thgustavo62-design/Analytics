@echo off
cd /d "%~dp0"
title Vermelhinha Analytics
echo Vermelhinha Analytics - servidor local
echo Deixe esta janela aberta enquanto quiser usar o site "ao vivo".
echo.
echo   Painel: http://localhost:4180
echo   Pasta de entrada: %~dp0inbox
echo.
if not defined APP_PASSWORD set APP_PASSWORD=vermelhinha
node server.js
echo.
echo O servidor parou. Pressione qualquer tecla para fechar.
pause >nul
