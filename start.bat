@echo off
REM Start the Book CRM (Windows).
REM First run creates a virtual environment, installs Flask and creates the database.
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (set PY=py -3) else (set PY=python)

if not exist .venv (
  echo Creating virtual environment...
  %PY% -m venv .venv
  if errorlevel 1 (
    echo Python 3.9+ is required. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
    pause
    exit /b 1
  )
)
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt

if "%CRM_PORT%"=="" set CRM_PORT=5000
start "" http://localhost:%CRM_PORT%
python app.py
pause
