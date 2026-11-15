// Растеризует build/icon.svg в build/icon.png (512×512, прозрачный фон) через Electron: `electron.exe scripts/make-icon.cjs`.
// Нужен значок окна и установщика; PNG лежит в репозитории, скрипт запускают только при смене знака.
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, '..', 'build', 'icon.svg'), 'utf8').replace('width="64" height="64"', 'width="512" height="512"')
  const win = new BrowserWindow({ width: 512, height: 512, x: -6000, y: 0, show: false, transparent: true, frame: false, skipTaskbar: true })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`))
  win.showInactive() // скрытое окно может не отрисоваться
  await new Promise((r) => setTimeout(r, 600))
  const img = await win.webContents.capturePage()
  writeFileSync(join(__dirname, '..', 'build', 'icon.png'), img.toPNG())
  console.log('icon.png', img.getSize().width + 'x' + img.getSize().height)
  app.quit()
})
