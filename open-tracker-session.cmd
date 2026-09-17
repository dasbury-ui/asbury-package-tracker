@echo off
REM Asbury Package Tracker - Claude Code session, asburyderek account, Remote Control on.
REM Overrides the user-level CLAUDE_CONFIG_DIR (D:\.claude = dasbury@asburycabinets.com).
title Asbury Package Tracker
set "CLAUDE_CONFIG_DIR=C:\Users\dasbu\.claude"
cd /d "C:\Users\dasbu\Projects\asbury-package-tracker"
claude --remote-control "Asbury Package Tracker"
