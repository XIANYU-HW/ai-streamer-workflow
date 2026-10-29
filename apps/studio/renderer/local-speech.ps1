$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$synth = $null
$stream = $null
$reader = $null
$inputStream = $null

function Write-Response($value) {
    [Console]::Out.Write(($value | ConvertTo-Json -Depth 6 -Compress))
}

function Get-ServiceId($voice) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$voice.Id))
        return 'winrt-' + (([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant().Substring(0, 24))
    } finally {
        $sha.Dispose()
    }
}

function Await-WinRT($operation, [Type]$resultType) {
    $task = $script:asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait()
    return $task.Result
}

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw) -or $raw.Length -gt 20000) { throw 'Invalid local speech request.' }
    $request = $raw | ConvertFrom-Json
    if ($null -eq $request -or $request -isnot [pscustomobject]) { throw 'Request must be a JSON object.' }
    if ($request.action -notin @('voices', 'synthesize')) { throw 'Unsupported local speech action.' }
    $allowed = if ($request.action -eq 'voices') { @('action') } else { @('action', 'text', 'voice_id', 'rate', 'pitch', 'volume') }
    foreach ($property in $request.PSObject.Properties.Name) {
        if ($property -notin $allowed) { throw 'Unsupported request field.' }
    }
    foreach ($property in $allowed) {
        if ($property -notin $request.PSObject.Properties.Name) { throw 'Missing request field.' }
    }

    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
    $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    if ($null -eq $script:asTask) { throw 'Windows Runtime task adapter is unavailable.' }

    $available = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices)
    $ids = @{}
    $voices = @($available | ForEach-Object {
        $serviceId = Get-ServiceId $_
        if ($ids.ContainsKey($serviceId)) { throw 'Duplicate local voice identifier.' }
        $ids[$serviceId] = $_
        [pscustomobject]@{
            voice_id = $serviceId
            name = [string]$_.DisplayName
            language = [string]$_.Language
            gender = ([string]$_.Gender).ToLowerInvariant()
            engine = 'windows_local'
        }
    })
    if ($request.action -eq 'voices') {
        Write-Response @{ ok = $true; voices = $voices }
    } else {
        if ($request.voice_id -isnot [string] -or $request.voice_id -notmatch '^winrt-[0-9a-f]{24}$' -or -not $ids.ContainsKey($request.voice_id)) { throw 'Unknown local voice identifier.' }
        if ($request.text -isnot [string] -or [string]::IsNullOrWhiteSpace($request.text) -or $request.text.Length -gt 1000 -or $request.text -match '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]') { throw 'Speech text must contain 1 to 1000 characters.' }
        foreach ($key in @('rate', 'pitch', 'volume')) {
            $value = $request.$key
            if ($value -is [bool] -or $value -is [string] -or $null -eq $value -or [double]::IsNaN([double]$value) -or [double]::IsInfinity([double]$value)) { throw 'Speech parameters must be finite numbers.' }
        }
        if ($request.rate -lt 0.5 -or $request.rate -gt 2 -or $request.pitch -lt 0.5 -or $request.pitch -gt 2 -or $request.volume -le 0 -or $request.volume -gt 1) { throw 'Speech parameters are outside the supported range.' }
        $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
        $synth.Voice = $ids[$request.voice_id]
        $synth.Options.SpeakingRate = [double]$request.rate
        $synth.Options.AudioPitch = [double]$request.pitch
        $synth.Options.AudioVolume = [double]$request.volume
        $stream = Await-WinRT ($synth.SynthesizeTextToStreamAsync([string]$request.text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
        if ($stream.Size -le 0 -or $stream.Size -gt 8388608) { throw 'Generated WAV exceeds the 8 MiB limit or is empty.' }
        $inputStream = $stream.GetInputStreamAt(0)
        $reader = New-Object Windows.Storage.Streams.DataReader($inputStream)
        $count = Await-WinRT ($reader.LoadAsync([uint32]$stream.Size)) ([uint32])
        if ($count -ne $stream.Size) { throw 'Incomplete local speech stream.' }
        $bytes = New-Object byte[] ([int]$stream.Size)
        $reader.ReadBytes($bytes)
        Write-Response @{
            ok = $true
            voice_id = (Get-ServiceId $synth.Voice)
            engine = 'windows_local'
            rate = [double]$synth.Options.SpeakingRate
            pitch = [double]$synth.Options.AudioPitch
            volume = [double]$synth.Options.AudioVolume
            wav_base64 = [Convert]::ToBase64String($bytes)
        }
    }
} catch {
    Write-Response @{ ok = $false; error = ('Windows local speech failed: ' + $_.Exception.Message) }
    exit 1
} finally {
    foreach ($resource in @($reader, $inputStream, $stream, $synth)) {
        if ($null -ne $resource) {
            try { $resource.Dispose() } catch { }
        }
    }
}
