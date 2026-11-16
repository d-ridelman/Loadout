// Rasterizes build/icon.svg to build/icon.png (512×512, transparent background) via Electron: `electron.exe scripts/make-icon.cjs`.
// Needed for the window and installer icon; the PNG is kept in the repository, the script is run only when the mark changes.
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, '..', 'build', 'icon.svg'), 'utf8').replace('width="64" height="64"', 'width="512" height="512"')
  const win = new BrowserWindow({ width: 512, height: 512, x: -6000, y: 0, show: false, transparent: true, frame: false, skipTaskbar: true })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`))
  win.showInactive() // a hidden window may not render
  await new Promise((r) => setTimeout(r, 600))
  const img = await win.webContents.capturePage()
  writeFileSync(join(__dirname, '..', 'build', 'icon.png'), img.toPNG())
  console.log('icon.png', img.getSize().width + 'x' + img.getSize().height)
  app.quit()
})
