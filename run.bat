@echo off
cd /d "%~dp0"

if not exist ".env" (
    echo .env ファイルが見つかりません。.env.example をコピーして設定してください。
    echo 例: copy .env.example .env
    pause
    exit /b
)

if not exist "node_modules" (
    echo パッケージをインストールしています...
    npm install
)

node setup.js

echo.
echo ===================================
echo  ShiftShare 起動中...
echo  http://localhost:8000
echo  Ctrl+C で停止
echo ===================================
echo.

node server.js
pause
