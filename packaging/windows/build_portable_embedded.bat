@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT=%%~fI"
if exist "%ROOT%\venv_portable\Scripts\python.exe" (
    set "PYTHON_BIN=%ROOT%\venv_portable\Scripts\python.exe"
) else (
    set "PYTHON_BIN=python"
)
echo Using Python: %PYTHON_BIN%

%PYTHON_BIN% "%ROOT%\tools\portable_embedded\build_portable_windows_embedded.py"
if errorlevel 1 goto :error

goto :eof

:error
echo Embedded build failed. See the messages above for details.
exit /b 1
