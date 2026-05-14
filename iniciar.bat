@echo off
echo.
echo  ================================================
echo   Claude RAG - Iniciando servidor...
echo  ================================================
echo.
echo  Acesse: http://localhost:3000
echo  Para parar: feche esta janela
echo.
cd /d "%~dp0"
node server.js
pause
