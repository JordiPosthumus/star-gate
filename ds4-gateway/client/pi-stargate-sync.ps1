# Star Gate Pi client sync — committed body.
#
# The gateway prepends a generated preamble (renderPiClientScript) that defines
# exactly these variables before this body runs:
#   $StargateBaseUrl
#   $StargateFallbackBaseUrls
#   $StargateApiKey
# Do not add a param() block: PowerShell requires it to be the first statement,
# and the generated preamble comes first. -Check / -Test are read from $args.
#
# This is a committed template. It must never be executed without the preamble.
# Structural guard: ds4-gateway/pi-client-script.test.mjs (not a Windows test).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# Text safety: strip control characters, redact local user paths, cap length.
# The report route redacts too; doing it here keeps local logs and the wire
# payload clean even when the server is the thing that failed.
# ---------------------------------------------------------------------------
function Remove-ControlCharacters {
  param([string]$Text)
  if ($null -eq $Text) { return $null }
  $builder = New-Object System.Text.StringBuilder
  foreach ($character in $Text.ToCharArray()) {
    $code = [int][char]$character
    if ($code -eq 9 -or $code -eq 10 -or $code -eq 13) {
      [void]$builder.Append(' ')
    } elseif ($code -lt 32 -or $code -eq 127) {
      # drop C0 controls and DEL
    } else {
      [void]$builder.Append($character)
    }
  }
  return $builder.ToString()
}

function Redact-LocalText {
  param([string]$Text)
  if ($null -eq $Text) { return $null }
  $out = [regex]::Replace($Text, '[A-Za-z]:\\Users\\[^\\\s"'']+', 'C:\Users\<user>')
  $out = [regex]::Replace($out, '([a-z][a-z0-9+.-]*://)[^\s/@]+@', '$1')
  $out = [regex]::Replace($out, 'Bearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer <redacted>')
  return $out
}

function Sanitize-Text {
  param([string]$Text, [int]$Max)
  if ($null -eq $Text) { return $null }
  $clean = Redact-LocalText (Remove-ControlCharacters $Text)
  if ($clean.Length -gt $Max) { $clean = $clean.Substring(0, $Max) }
  return $clean
}

# ---------------------------------------------------------------------------
# JSON -> ordered map. Deterministic key order is what makes re-runs byte
# identical (SR1): a plain Hashtable would enumerate in hash order.
# ---------------------------------------------------------------------------
function ConvertTo-OrderedMap {
  param($Value)
  if ($null -eq $Value) { return $null }
  if ($Value -is [System.Collections.IDictionary]) {
    $map = [ordered]@{}
    foreach ($key in $Value.Keys) { $map[[string]$key] = ConvertTo-OrderedMap $Value[$key] }
    return $map
  }
  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $map = [ordered]@{}
    foreach ($property in $Value.PSObject.Properties) { $map[$property.Name] = ConvertTo-OrderedMap $property.Value }
    return $map
  }
  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
    $list = New-Object System.Collections.ArrayList
    foreach ($item in $Value) { [void]$list.Add((ConvertTo-OrderedMap $item)) }
    return $list.ToArray()
  }
  return $Value
}

# ---------------------------------------------------------------------------
# -Check / -Test. A param() block cannot follow the generated preamble.
# ---------------------------------------------------------------------------
$CheckMode = $false
$TestMode = $false
foreach ($argument in $args) {
  if ($argument -eq '-Check' -or $argument -eq '/Check') { $CheckMode = $true }
  if ($argument -eq '-Test' -or $argument -eq '/Test') { $TestMode = $true }
}

# ---------------------------------------------------------------------------
# Report state. Stage names are the frozen contract:
# fetch | parse | merge | write | validate | pi-check
# ---------------------------------------------------------------------------
$syncStarted = [System.Diagnostics.Stopwatch]::StartNew()
$script:ReportSteps = New-Object System.Collections.ArrayList
$script:Failed = $false
$script:Stage = 'fetch'
$script:ErrorCode = $null
$script:ErrorMessage = $null
$script:Revision = $null
$script:WorkingBase = $null
$script:ClientPiVersion = $null

function Add-ReportStep {
  param([string]$Stage, [bool]$Ok, $Detail)
  $clean = $null
  if ($null -ne $Detail) { $clean = Sanitize-Text ([string]$Detail) 512 }
  [void]$script:ReportSteps.Add(@{ stage = $Stage; ok = $Ok; detail = $clean })
}

function Stop-Sync {
  param([string]$Stage, [string]$Code, [string]$Message)
  $script:Failed = $true
  $script:Stage = $Stage
  $script:ErrorCode = $Code
  $script:ErrorMessage = Sanitize-Text $Message 512
  throw (New-Object System.Exception ($script:ErrorMessage))
}

function Invoke-PiProbe {
  param([string]$PiPath, [int]$TimeoutSeconds)
  $job = Start-Job -ScriptBlock {
    param($exe)
    $output = & $exe -p 'Reply with the single word: ok' 2>&1 | Out-String
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
  } -ArgumentList $PiPath
  $finished = Wait-Job -Job $job -Timeout $TimeoutSeconds
  if ($null -eq $finished) {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    return $null
  }
  $result = Receive-Job -Job $job
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  return $result
}

function Send-Report {
  param([string]$Base, $Payload)
  $url = ([string]$Base).TrimEnd('/') + '/client/pi/report'
  $body = ConvertTo-Json -InputObject $Payload -Depth 100 -Compress
  if ([System.Text.Encoding]::UTF8.GetByteCount($body) -gt 8192) { return $false }
  $headers = @{ Authorization = ('Bearer ' + $StargateApiKey) }
  try {
    Invoke-WebRequest -Uri $url -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 5 -UseBasicParsing | Out-Null
    return $true
  } catch {
    return $false
  }
}

# ===========================================================================
# Step 1 — resolve the Pi profile path.
# Authoritative: $env:USERPROFILE\.pi\agent\models.json.
# PI_CODING_AGENT_DIR is honoured when set (best effort).
# ===========================================================================
try {
  $agentDirectory = $null
  if ($env:PI_CODING_AGENT_DIR) {
    $agentDirectory = [string]$env:PI_CODING_AGENT_DIR
  } elseif ($env:USERPROFILE) {
    $agentDirectory = Join-Path $env:USERPROFILE '.pi\agent'
  } else {
    Stop-Sync 'merge' 'no_profile_path' 'USERPROFILE is not set; cannot locate the Pi profile'
  }
  $modelsPath = Join-Path $agentDirectory 'models.json'

  # -------------------------------------------------------------------------
  # Step 2 — fetch the bundle. Primary first, then each fallback, with a
  # timeout and UseBasicParsing for Windows PowerShell 5.1.
  # -------------------------------------------------------------------------
  $script:Stage = 'fetch'
  $fetchHeaders = @{ Authorization = ('Bearer ' + $StargateApiKey) }
  $candidateBases = New-Object System.Collections.ArrayList
  [void]$candidateBases.Add([string]$StargateBaseUrl)
  foreach ($fallback in @($StargateFallbackBaseUrls)) {
    if ($fallback) { [void]$candidateBases.Add([string]$fallback) }
  }

  $bundle = $null
  $lastFetchError = $null
  foreach ($candidate in $candidateBases) {
    $trimmedBase = $candidate.TrimEnd('/')
    $bundleUrl = $trimmedBase + '/client/pi'
    try {
      $response = Invoke-WebRequest -Uri $bundleUrl -Method Get -Headers $fetchHeaders -TimeoutSec 15 -UseBasicParsing
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        $bundle = $response.Content | ConvertFrom-Json
        $script:WorkingBase = $trimmedBase
        Add-ReportStep 'fetch' $true ('bundle fetched from ' + (Sanitize-Text $trimmedBase 256))
        break
      }
      $lastFetchError = 'HTTP ' + $response.StatusCode
    } catch {
      $lastFetchError = $_.Exception.Message
    }
  }
  if ($null -eq $bundle) {
    Add-ReportStep 'fetch' $false $lastFetchError
    Stop-Sync 'fetch' 'fetch_failed' $lastFetchError
  }

  # -------------------------------------------------------------------------
  # Step 3 — parse and validate the bundle.
  # -------------------------------------------------------------------------
  $script:Stage = 'parse'
  if ([int]$bundle.schema -ne 1) { Stop-Sync 'parse' 'schema' 'bundle schema must be 1' }
  if ([string]::IsNullOrWhiteSpace([string]$bundle.revision)) { Stop-Sync 'parse' 'revision' 'bundle revision is missing' }
  if ([string]::IsNullOrWhiteSpace([string]$bundle.provider)) { Stop-Sync 'parse' 'provider' 'bundle provider is missing' }
  if ([string]::IsNullOrWhiteSpace([string]$bundle.api)) { Stop-Sync 'parse' 'api' 'bundle api is missing' }
  if ([string]::IsNullOrWhiteSpace([string]$bundle.base_url)) { Stop-Sync 'parse' 'base_url' 'bundle base_url is missing' }
  if ($null -eq $bundle.model) { Stop-Sync 'parse' 'model' 'bundle model block is missing' }
  if ([string]::IsNullOrWhiteSpace([string]$bundle.model.id)) { Stop-Sync 'parse' 'model_id' 'bundle model.id is missing' }
  $script:Revision = Sanitize-Text ([string]$bundle.revision) 64
  Add-ReportStep 'parse' $true ('bundle revision ' + $script:Revision)

  # The provider object shape is pinned by plan 3.2b: baseUrl, api, apiKey,
  # models[] (always an array), and compat at the PROVIDER level.
  $providerObject = [ordered]@{
    baseUrl = [string]$bundle.base_url
    api = [string]$bundle.api
    apiKey = [string]$bundle.api_key
    models = @(
      [ordered]@{
        id = [string]$bundle.model.id
        name = [string]$bundle.model.name
        reasoning = [bool]$bundle.model.reasoning
        input = @($bundle.model.input | ForEach-Object { [string]$_ })
        contextWindow = [int]$bundle.model.contextWindow
        maxTokens = [int]$bundle.model.maxTokens
        thinkingLevelMap = ConvertTo-OrderedMap $bundle.model.thinkingLevelMap
        samplingParams = ConvertTo-OrderedMap $bundle.model.samplingParams
        cost = ConvertTo-OrderedMap $bundle.model.cost
      }
    )
    compat = ConvertTo-OrderedMap $bundle.compat
  }

  # Read the existing profile once (or start from an empty providers map).
  $existingDocument = $null
  if (Test-Path -LiteralPath $modelsPath) {
    $existingRaw = Get-Content -LiteralPath $modelsPath -Raw
    if (-not [string]::IsNullOrWhiteSpace($existingRaw)) {
      try {
        $existingDocument = ConvertTo-OrderedMap ($existingRaw | ConvertFrom-Json)
      } catch {
        Stop-Sync 'merge' 'existing_json' 'The existing models.json is not valid JSON'
      }
    }
  }
  if ($null -eq $existingDocument) { $existingDocument = [ordered]@{} }
  if ($existingDocument -isnot [System.Collections.IDictionary]) {
    Stop-Sync 'merge' 'existing_shape' 'The existing models.json is not a JSON object'
  }
  if (-not $existingDocument.Contains('providers') -or $null -eq $existingDocument['providers']) {
    $existingDocument['providers'] = [ordered]@{}
  }
  if ($existingDocument['providers'] -isnot [System.Collections.IDictionary]) {
    Stop-Sync 'merge' 'existing_providers' 'The existing models.json providers block is not an object'
  }

  if ($CheckMode) {
    # -----------------------------------------------------------------------
    # Step 8 — dry run. Report what would change, mutate nothing.
    # -----------------------------------------------------------------------
    $script:Stage = 'validate'
    $existingProvider = $null
    $providerMap = $existingDocument['providers']
    if ($providerMap.Contains($bundle.provider)) { $existingProvider = $providerMap[$bundle.provider] }
    $newJson = ConvertTo-Json -InputObject $providerObject -Depth 100 -Compress
    $oldJson = $null
    if ($null -ne $existingProvider) { $oldJson = ConvertTo-Json -InputObject $existingProvider -Depth 100 -Compress }
    $changeDetail = 'would create provider ' + [string]$bundle.provider
    if ($null -ne $oldJson) {
      if ($oldJson -eq $newJson) { $changeDetail = 'provider ' + [string]$bundle.provider + ' is already current' }
      else { $changeDetail = 'would update provider ' + [string]$bundle.provider }
    }
    Add-ReportStep 'validate' $true $changeDetail
  } else {
    # -----------------------------------------------------------------------
    # Step 4 — back up the existing profile (timestamp is filename-safe).
    # -----------------------------------------------------------------------
    $script:Stage = 'merge'
    # One UTC stamp for every backup this run takes, computed unconditionally so
    # the settings backup below cannot end up with an empty timestamp.
    $stamp = [DateTime]::UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'")
    if (Test-Path -LiteralPath $modelsPath) {
      $backupPath = $modelsPath + '.' + $stamp + '.bak'
      try {
        Copy-Item -LiteralPath $modelsPath -Destination $backupPath -Force
      } catch {
        Stop-Sync 'merge' 'backup_failed' ('Could not write the backup: ' + $_.Exception.Message)
      }
    }

    # -----------------------------------------------------------------------
    # Step 5 — merge. Replace ONLY providers[$bundle.provider]; every other
    # provider, top-level key and setting is preserved (SR3).
    # -----------------------------------------------------------------------
    $existingDocument['providers'][$bundle.provider] = $providerObject
    Add-ReportStep 'merge' $true ('replaced providers[' + (Sanitize-Text ([string]$bundle.provider) 64) + ']')

    # -----------------------------------------------------------------------
    # Step 5b — optional purge. Removes the other providers so a machine pinned
    # to the pool keeps no dead endpoints. Off unless the bundle asks for it;
    # `all` keeps only the synced provider. This runs AFTER the backup, so the
    # removals are recoverable from models.json.<stamp>.bak.
    # -----------------------------------------------------------------------
    $purge = $bundle.purgeProviders
    if ($null -ne $purge) {
      $purgeAll = ($purge -is [string]) -and ([string]$purge -eq 'all')
      if ($purgeAll -or (@($purge).Count -gt 0)) {
        $removed = New-Object System.Collections.ArrayList
        foreach ($providerName in @($existingDocument['providers'].Keys)) {
          $name = [string]$providerName
          if ($name -eq [string]$bundle.provider) { continue }
          if ($purgeAll -or (@($purge) -contains $name)) {
            $existingDocument['providers'].Remove($name) | Out-Null
            [void]$removed.Add($name)
          }
        }
        $removedText = if ($removed.Count -gt 0) { ($removed.ToArray() -join ', ') } else { 'none' }
        Add-ReportStep 'merge' $true ('purged ' + $removed.Count + ' provider(s): ' + (Sanitize-Text $removedText 256))
      }
    }

    # -----------------------------------------------------------------------
    # Step 6 — serialize and write atomically. ConvertTo-Json MUST carry
    # -Depth 100 or Windows PowerShell 5.1 corrupts the nested
    # compat.chatTemplateKwargs object into a string.
    # -----------------------------------------------------------------------
    $script:Stage = 'write'
    $profileDirectory = Split-Path -Parent $modelsPath
    if (-not (Test-Path -LiteralPath $profileDirectory)) {
      New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
    }
    $temporaryPath = Join-Path $profileDirectory ('models.json.' + [guid]::NewGuid().ToString('N') + '.tmp')
    $serialized = ConvertTo-Json -InputObject $existingDocument -Depth 100
    try {
      [System.IO.File]::WriteAllText($temporaryPath, $serialized, (New-Object System.Text.UTF8Encoding($false)))
      Move-Item -LiteralPath $temporaryPath -Destination $modelsPath -Force
    } catch {
      if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue }
      Stop-Sync 'write' 'write_failed' ('Could not write models.json: ' + $_.Exception.Message)
    }
    Add-ReportStep 'write' $true 'models.json written atomically'

    # -----------------------------------------------------------------------
    # Step 7 — validate the NESTED structure that was just written.
    # -----------------------------------------------------------------------
    $script:Stage = 'validate'
    $writtenRaw = Get-Content -LiteralPath $modelsPath -Raw
    $written = $writtenRaw | ConvertFrom-Json
    $writtenProviderProperty = $written.providers.PSObject.Properties[$bundle.provider]
    if ($null -eq $writtenProviderProperty) {
      Stop-Sync 'validate' 'provider_missing' ('provider ' + [string]$bundle.provider + ' is missing after write')
    }
    $writtenProvider = $writtenProviderProperty.Value
    if ($null -eq $writtenProvider.models -or @($writtenProvider.models).Count -lt 1) {
      Stop-Sync 'validate' 'models_missing' 'models is missing or empty after write'
    }
    $writtenModelId = [string]$writtenProvider.models[0].id
    if ($writtenModelId -ne [string]$bundle.model.id) {
      Stop-Sync 'validate' 'model_id' ('models[0].id is ' + $writtenModelId + ', expected ' + [string]$bundle.model.id)
    }
    $writtenKwargs = $writtenProvider.compat.chatTemplateKwargs
    if ($null -eq $writtenKwargs -or $writtenKwargs -is [string]) {
      Stop-Sync 'validate' 'chat_template_kwargs' 'compat.chatTemplateKwargs is not an object after write'
    }
    Add-ReportStep 'validate' $true 'nested provider structure verified'

    # -----------------------------------------------------------------------
    # Step 7b — adopt the served defaults (default provider/model/thinking
    # level) in settings.json, so the pool is what pi starts with. Deliberately
    # AFTER models.json is written and verified: pointing pi's default at a
    # provider that failed to land would leave it unable to start. Only written
    # when the bundle says apply, and only these three keys are ever touched.
    # -----------------------------------------------------------------------
    $adopt = $bundle.defaults
    if ($null -ne $adopt -and $adopt.apply -eq $true) {
      $settingsPath = Join-Path $agentDirectory 'settings.json'
      $settings = [ordered]@{}
      if (Test-Path -LiteralPath $settingsPath) {
        try {
          $settingsRaw = Get-Content -LiteralPath $settingsPath -Raw
          if (-not [string]::IsNullOrWhiteSpace($settingsRaw)) {
            $settings = ConvertTo-OrderedMap ($settingsRaw | ConvertFrom-Json)
          }
        } catch {
          Stop-Sync 'validate' 'existing_settings_json' 'The existing settings.json is not valid JSON'
        }
        if ($settings -isnot [System.Collections.IDictionary]) {
          Stop-Sync 'validate' 'existing_settings_shape' 'The existing settings.json is not a JSON object'
        }
        # Same UTC stamp as the models.json backup, so one run's backups pair up.
        try {
          Copy-Item -LiteralPath $settingsPath -Destination ($settingsPath + '.' + $stamp + '.bak') -Force
        } catch {
          Stop-Sync 'validate' 'settings_backup_failed' ('Could not write the settings backup: ' + $_.Exception.Message)
        }
      }
      $settings['defaultProvider'] = [string]$adopt.model.defaultProvider
      $settings['defaultModel'] = [string]$adopt.model.defaultModel
      $level = $adopt.model.defaultThinkingLevel
      if ($null -eq $level) { [void]$settings.Remove('defaultThinkingLevel') }
      else { $settings['defaultThinkingLevel'] = [string]$level }
      $settingsTemporary = Join-Path $agentDirectory ('settings.json.' + [guid]::NewGuid().ToString('N') + '.tmp')
      try {
        [System.IO.File]::WriteAllText($settingsTemporary, (ConvertTo-Json -InputObject $settings -Depth 100), (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $settingsTemporary -Destination $settingsPath -Force
      } catch {
        if (Test-Path -LiteralPath $settingsTemporary) { Remove-Item -LiteralPath $settingsTemporary -Force -ErrorAction SilentlyContinue }
        Stop-Sync 'write' 'settings_write_failed' ('Could not write settings.json: ' + $_.Exception.Message)
      }
      # Validate by re-reading: a silent key drop here would leave pi on its old
      # model with no error anywhere.
      $settingsBack = ConvertTo-OrderedMap ((Get-Content -LiteralPath $settingsPath -Raw) | ConvertFrom-Json)
      if ([string]$settingsBack['defaultModel'] -ne [string]$adopt.model.defaultModel) {
        Stop-Sync 'validate' 'default_model' 'settings.json defaultModel did not persist'
      }
      if ($settingsBack.Contains('defaultProvider') -and ([string]$settingsBack['defaultProvider'] -ne [string]$adopt.model.defaultProvider)) {
        Stop-Sync 'validate' 'default_provider' 'settings.json defaultProvider did not persist'
      }
      Add-ReportStep 'validate' $true ('default model set to ' + (Sanitize-Text ([string]$adopt.model.defaultModel) 64) +
        ' on ' + (Sanitize-Text ([string]$adopt.model.defaultProvider) 64) + ', thinking ' + (Sanitize-Text ([string]$level) 32))
    }
  }

  # -------------------------------------------------------------------------
  # Step 9 — optional -Test probe. A missing pi is not a failure.
  # -------------------------------------------------------------------------
  if ($TestMode) {
    $script:Stage = 'pi-check'
    $piCommand = Get-Command pi -ErrorAction SilentlyContinue
    if ($null -eq $piCommand) {
      Add-ReportStep 'pi-check' $true 'pi is not on PATH; probe skipped'
    } else {
      $piPath = [string]$piCommand.Source
      try {
        $versionText = (& $piPath --version 2>&1 | Out-String).Trim()
        if ($versionText.Length -gt 0) { $script:ClientPiVersion = Sanitize-Text $versionText 64 }
        Add-ReportStep 'pi-check' $true ('pi --version: ' + (Sanitize-Text $versionText 64))
      } catch {
        Add-ReportStep 'pi-check' $false ('pi --version failed: ' + (Sanitize-Text $_.Exception.Message 256))
      }
      $probe = Invoke-PiProbe $piPath 120
      if ($null -eq $probe) {
        Add-ReportStep 'pi-check' $false 'pi -p timed out'
      } elseif ([int]$probe.ExitCode -eq 0 -and ([string]$probe.Output).Trim().Length -gt 0) {
        Add-ReportStep 'pi-check' $true 'pi -p returned output'
      } else {
        Add-ReportStep 'pi-check' $false ('pi -p failed with exit code ' + [int]$probe.ExitCode)
      }
    }
  }
} catch {
  if (-not $script:Failed) {
    $script:Failed = $true
    $script:ErrorCode = 'unexpected_error'
    $script:ErrorMessage = Sanitize-Text $_.Exception.Message 512
  }
}

# ---------------------------------------------------------------------------
# Step 10 — report the outcome (success or failure) and exit 0/1.
# The report POST is non-fatal and uses a short timeout (SR5/SR6).
# ---------------------------------------------------------------------------
$reportBase = $script:WorkingBase
if (-not $reportBase) { $reportBase = [string]$StargateBaseUrl }
$reportBase = Sanitize-Text $reportBase 256

$clientOs = 'Windows'
try { $clientOs = 'Windows ' + [System.Environment]::OSVersion.Version.ToString() } catch {}
$clientPowerShell = 'unknown'
try { $clientPowerShell = $PSVersionTable.PSVersion.ToString() } catch {}
$clientOs = Sanitize-Text $clientOs 64
$clientPowerShell = Sanitize-Text $clientPowerShell 64
if (-not $clientOs) { $clientOs = 'Windows' }
if (-not $clientPowerShell) { $clientPowerShell = 'unknown' }

$report = [ordered]@{
  schema = 1
  revision = $script:Revision
  stage = $script:Stage
  ok = [bool](-not $script:Failed)
  error_code = $script:ErrorCode
  error_message = $script:ErrorMessage
  client = [ordered]@{
    os = $clientOs
    powershell = $clientPowerShell
    pi_version = $script:ClientPiVersion
  }
  base_url = $reportBase
  duration_ms = [int]$syncStarted.ElapsedMilliseconds
  steps = @($script:ReportSteps.ToArray())
}

$reportDelivered = Send-Report $reportBase $report

if ($script:Failed) {
  Write-Host ('Star Gate sync failed at stage ' + $script:Stage + ': ' + $script:ErrorMessage)
  if (-not $reportDelivered) { Write-Host 'DSG was not reachable for the report; the error above is local only.' }
  exit 1
}

if ($CheckMode) {
  Write-Host 'Star Gate check complete (no files changed).'
} else {
  Write-Host 'Star Gate sync complete.'
}
if (-not $reportDelivered) { Write-Host 'Note: the DSG report could not be delivered.' }
exit 0
