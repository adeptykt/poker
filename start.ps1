# Запуск NLH Poker v1.0: статический сервер на 8770 + открытие в браузере.
# PowerShell 5.1 совместим. Окно можно закрыть — сервер остановится.

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8770
$url  = "http://127.0.0.1:$port/"

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.ico'  = 'image/x-icon'
  '.svg'  = 'image/svg+xml'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
try {
  $listener.Start()
} catch {
  Write-Host "Не удалось занять порт $port (возможно, занят): $_" -ForegroundColor Yellow
  Start-Process $url
  exit
}

Write-Host "NLH Poker v1.0 -> $url  (Ctrl+C или закрытие окна — остановка)" -ForegroundColor Green
Start-Process $url

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($rel -eq '/') { $rel = '/index.html' }
    $file = Join-Path $root ($rel -replace '/', '\')
    $rootWithSep = $root.TrimEnd('\') + '\'
    if (-not ($file.StartsWith($rootWithSep)) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
      $ctx.Response.StatusCode = 404
      $bytes = [Text.Encoding]::UTF8.GetBytes('404')
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      $ctx.Response.Close()
      continue
    }
    $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
    $ctx.Response.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
    $bytes = [IO.File]::ReadAllBytes($file)
    # Без кэша: иначе браузер может держать старую вёрстку со старым styles.css.
    $ctx.Response.AddHeader('Cache-Control', 'no-store, must-revalidate')
    $ctx.Response.AddHeader('Pragma', 'no-cache')
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.Close()
  }
} finally {
  $listener.Stop()
}
