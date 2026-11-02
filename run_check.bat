@echo off
chcp 65001 >nul
cd /d "%~dp0"
python check_balances.py >> check.log 2>&1
