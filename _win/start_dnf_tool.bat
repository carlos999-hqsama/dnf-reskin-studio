@echo off
title DNF Sprite Studio
cd /d D:\dnf-reskin\afa-sprite-studio
echo ==================================================
echo   DNF Sprite Studio
echo   浏览器打开:  http://127.0.0.1:8773
echo   (关掉这个窗口即停止工具)
echo ==================================================
".venv\Scripts\python.exe" server.py D:\dnf-reskin\work
echo.
echo [服务已停止] 按任意键关闭...
pause >nul
