Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap(64, 64)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'

# Gradient: emerald -> gold (matches app theme)
$c1 = [System.Drawing.Color]::FromArgb(16, 185, 129)
$c2 = [System.Drawing.Color]::FromArgb(251, 191, 36)
$p1 = New-Object System.Drawing.Point(0, 0)
$p2 = New-Object System.Drawing.Point(64, 64)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($p1, $p2, $c1, $c2)
$g.FillRectangle($brush, 0, 0, 64, 64)

# Letter "A" for Arisan
$font = New-Object System.Drawing.Font('Arial', 34, [System.Drawing.FontStyle]::Bold)
$dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(15, 20, 25))
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = 'Center'
$sf.LineAlignment = 'Center'
$rect = New-Object System.Drawing.RectangleF(0, 0, 64, 64)
$g.DrawString('A', $font, $dark, $rect, $sf)

$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$fs = New-Object System.IO.FileStream('C:\Users\CulluL\arisan\icon.ico', 'Create')
$icon.Save($fs)
$fs.Close()
$g.Dispose()
$bmp.Dispose()
Write-Host "Icon.ico created!"
