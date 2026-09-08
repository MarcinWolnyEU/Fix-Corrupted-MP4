@echo off
setlocal DisableDelayedExpansion
rem Downloaded Stream Fixer: Windows launcher.
rem Drag broken MP4 files, or folders containing them, onto this file. Several at
rem once is fine. Or double-click it and type a path when asked.
rem Node.js (https://nodejs.org/) must be installed. On the first run the script
rem offers to download ffmpeg and untrunc into the folders next to it.
rem Known limit: a dropped path with an ampersand or a caret and no spaces is
rem mangled by cmd.exe before this file runs (Explorer only quotes paths that
rem contain spaces). Typing or pasting such a path at the prompt works.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found.
  echo Install the LTS version from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

rem Folder of this launcher. fix-vods.js lives next to it.
set "HERE=%~dp0"

rem Copy everything dropped on this file into ARG1..ARGn, one argument at a time.
rem Each value is assigned inside quotes with delayed expansion off, which is the
rem only way batch keeps characters such as & ( ) ^ ! intact in file names.
rem "shift /1" leaves %0 alone. A plain "shift" would move the script name too.
set "N=0"
:collect
if "%~1"=="" goto :collected
set /a N+=1
set "ARG%N%=%~1"
shift /1
goto :collect
:collected

if %N% gtr 0 goto :run

echo Drag files or folders onto this file, or type the path to a folder with the
echo broken MP4 files, or to one MP4 file, and press Enter.
set /p "TARGET=Path: "
if not defined TARGET (
  echo No path given.
  pause
  exit /b 1
)
rem Strip quotes the user may have pasted around the path.
set "TARGET=%TARGET:"=%"
set "N=1"
set "ARG1=%TARGET%"

:run
rem Rebuild the argument list with delayed expansion, which inserts the values
rem without parsing them again. A trailing backslash gets a dot appended, because a
rem backslash right before the closing quote would otherwise escape that quote.
setlocal EnableDelayedExpansion
set "ARGS="
for /l %%i in (1,1,%N%) do (
  set "A=!ARG%%i!"
  if "!A:~-1!"=="\" set "A=!A!."
  set ARGS=!ARGS! "!A!"
)
node "%HERE%fix-vods.js" !ARGS!
echo.
pause
