@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installazione dipendenze...
  call npm install
)
start "" http://localhost:3000
npm start
