param(
  [string]$Path = "C:\Projects\poker\.shot.raw",
  [int]$SrcW = 376, [int]$SrcH = 689, [int]$Cols = 74
)
$buf = [System.IO.File]::ReadAllBytes($Path)
$stride = $SrcW * 3
$rows = [int][math]::Round($Cols * ($SrcH / $SrcW) / 2.0)

$cell = New-Object 'int[]' ($rows * $Cols * 3)
for ($cy = 0; $cy -lt $rows; $cy++) {
  $y0 = [int]($cy * $SrcH / $rows); $y1 = [int](($cy + 1) * $SrcH / $rows); if ($y1 -le $y0) { $y1 = $y0 + 1 }
  for ($cx = 0; $cx -lt $Cols; $cx++) {
    $x0 = [int]($cx * $SrcW / $Cols); $x1 = [int](($cx + 1) * $SrcW / $Cols); if ($x1 -le $x0) { $x1 = $x0 + 1 }
    $sr=0; $sg=0; $sb=0; $n=0
    for ($y = $y0; $y -lt $y1; $y++) {
      $base = $y * $stride
      for ($x = $x0; $x -lt $x1; $x++) {
        $i = $base + $x*3
        $sb += $buf[$i]; $sg += $buf[$i+1]; $sr += $buf[$i+2]; $n++
      }
    }
    $k = ($cy*$Cols + $cx)*3
    $cell[$k] = [int]($sr/$n); $cell[$k+1] = [int]($sg/$n); $cell[$k+2] = [int]($sb/$n)
  }
}

function Get-HueChar([int]$r, [int]$g, [int]$b) {
  $mx = [math]::Max($r, [math]::Max($g, $b)); $mn = [math]::Min($r, [math]::Min($g, $b))
  $d = $mx - $mn
  if ($mx -eq 0) { return '.' }
  $sat = $d / $mx
  if ($sat -lt 0.22) { if ($mx -gt 190) { return 'W' } elseif ($mx -gt 110) { return 'w' } elseif ($mx -gt 48) { return '-' } else { return '.' } }
  if ($d -eq 0) { return '-' }
  $h = 0.0
  if ($mx -eq $r)      { $h = 60 * ((($g - $b) / $d) % 6) }
  elseif ($mx -eq $g)  { $h = 60 * ((($b - $r) / $d) + 2) }
  else                { $h = 60 * ((($r - $g) / $d) + 4) }
  if ($h -lt 0) { $h += 360 }
  if ($h -lt 15 -or $h -ge 345) { return 'R' }
  if ($h -lt 45)  { return 'O' }
  if ($h -lt 70)  { return 'Y' }
  if ($h -lt 165) { return 'G' }
  if ($h -lt 200) { return 'C' }
  if ($h -lt 255) { return 'B' }
  if ($h -lt 290) { return 'P' }
  return 'M'
}

$lum = New-Object 'System.Text.StringBuilder'
$hue = New-Object 'System.Text.StringBuilder'
$rowHex = New-Object 'System.Text.StringBuilder'
for ($cy = 0; $cy -lt $rows; $cy++) {
  $l=''; $h=''; $ar=0; $ag=0; $ab=0
  for ($cx = 0; $cx -lt $Cols; $cx++) {
    $k = ($cy*$Cols+$cx)*3
    $r=$cell[$k]; $g=$cell[$k+1]; $b=$cell[$k+2]
    $ar+=$r; $ag+=$g; $ab+=$b
    $v = [math]::Max($r,[math]::Max($g,$b))
    $d = [int][math]::Round(($v/255.0)*9.0); if ($d -gt 9) { $d = 9 }
    $l += "$d"
    $h += (Get-HueChar $r $g $b)
  }
  [void]$lum.AppendLine(("{0,3}| " -f [int]($cy*$SrcH/$rows)) + $l)
  [void]$hue.AppendLine(("    ") + $h)
  [void]$rowHex.AppendLine(("{0,3}| #{1:X2}{2:X2}{3:X2}" -f [int]($cy*$SrcH/$rows), [int]($ar/$Cols), [int]($ag/$Cols), [int]($ab/$Cols)))
}
Write-Output "=== LUMA ===";   Write-Output $lum.ToString()
Write-Output "=== HUE (R O Y G C B P M colors / W w - . gray) ==="; Write-Output $hue.ToString()
Write-Output "=== ROW AVERAGE (real RGB) ==="; Write-Output $rowHex.ToString()
