@echo off
setlocal

call "%~dp0packaging\windows\build_portable.bat" %*
exit /b %errorlevel%
