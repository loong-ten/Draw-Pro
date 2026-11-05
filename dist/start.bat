@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1

set "PORT=8080"
if not "%~1"=="" set "PORT=%~1"

py -3 -c "import sys; sys.exit(sys.version_info.major != 3)" >nul 2>&1
if not errorlevel 1 goto launch_py
python -c "import sys; sys.exit(sys.version_info.major != 3)" >nul 2>&1
if not errorlevel 1 goto launch_python
python3 -c "import sys; sys.exit(sys.version_info.major != 3)" >nul 2>&1
if not errorlevel 1 goto launch_python3

echo Python 3 was not found. Install Python 3 and run this script again.
set "RESULT=1"
goto finish

:launch_py
echo Open http://127.0.0.1:%PORT% in your browser. Press Ctrl+C to stop.
py -3 -m http.server "%PORT%" --bind 127.0.0.1 --directory .
set "RESULT=%ERRORLEVEL%"
goto finish

:launch_python
echo Open http://127.0.0.1:%PORT% in your browser. Press Ctrl+C to stop.
python -m http.server "%PORT%" --bind 127.0.0.1 --directory .
set "RESULT=%ERRORLEVEL%"
goto finish

:launch_python3
echo Open http://127.0.0.1:%PORT% in your browser. Press Ctrl+C to stop.
python3 -m http.server "%PORT%" --bind 127.0.0.1 --directory .
set "RESULT=%ERRORLEVEL%"

:finish
popd
if not "%RESULT%"=="0" pause
exit /b %RESULT%
