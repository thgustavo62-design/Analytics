@echo off
cd /d "%~dp0"
title Analytics
echo Analytics - servidor local
echo Deixe esta janela aberta enquanto quiser usar o site "ao vivo".
echo.
echo   Painel: http://localhost:4180   (senha: 1234)
echo   Pasta de entrada: %~dp0inbox
echo.
rem Para a Analise Comercial gerar sozinha, defina a chave da Anthropic:
rem set ANTHROPIC_API_KEY=sk-ant-...
if not defined APP_PASSWORD set APP_PASSWORD=1234
node server.js
echo.
echo O servidor parou. Pressione qualquer tecla para fechar.
pause >nul
