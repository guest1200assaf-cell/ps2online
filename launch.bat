@echo off
SET ELECTRON_RUN_AS_NODE=
SET APPDIR=%~dp0
SET APPDIR=%APPDIR:~0,-1%
"%~dp0node_modules\electron\dist\electron.exe" "%APPDIR%"
