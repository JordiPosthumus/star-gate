#!/usr/bin/env pwsh
# Parse-check the served Pi client script with a REAL PowerShell engine.
#
# Why this exists: the Windows sync script is the one deliverable that has to run
# on a machine we do not own, and until now it had only been structurally
# inspected by regex. A regex cannot tell a valid scriptblock from an unclosed
# one. This parses the exact bytes we serve and fails on any parser error, so a
# syntax error is caught here instead of on Max's PC.
#
# This is a SYNTAX gate, not a functional Windows test: it proves the script
# parses and that its structure is introspectable, not that the sync works.

param(
  [Parameter(Mandatory = $true)][string]$ScriptPath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ScriptPath)) {
  Write-Host "FAIL: no script at $ScriptPath"
  exit 2
}

$text = [System.IO.File]::ReadAllText($ScriptPath)

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput(
  $text, [ref]$tokens, [ref]$errors)

if ($errors -and $errors.Count -gt 0) {
  Write-Host ("FAIL: {0} parse error(s) in {1}" -f $errors.Count, $ScriptPath)
  foreach ($e in $errors) {
    Write-Host ("  line {0} col {1}: {2}" -f $e.Extent.StartLineNumber, $e.Extent.StartColumnNumber, $e.Message)
  }
  exit 1
}

Write-Host ("OK: parsed {0} tokens, {1} lines, no errors" -f $tokens.Count, ($text -split "`n").Count)
exit 0
