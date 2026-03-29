@echo off
setlocal

call "%~dp0packaging\windows\build_portable_embedded.bat" %*
exit /b %errorlevel%
