'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { Service } = require('node-windows')

if (process.platform !== 'win32') {
  console.error('MinecraftBotService yalnızca Windows üzerinde kurulabilir.')
  process.exitCode = 1
} else {
  const root = __dirname
  const logPath = path.join(root, 'logs', 'service')
  fs.mkdirSync(logPath, { recursive: true })

  const service = new Service({
    name: 'MinecraftBotService',
    description: 'Minecraft Mineflayer botu ve kontrol paneli',
    script: path.join(root, 'index.js'),
    workingDirectory: root,
    execPath: process.execPath,
    logpath: logPath,
    logmode: 'rotate',
    env: { name: 'MINECRAFT_BOT_SERVICE', value: '1' }
  })

  function setAutomaticStartup () {
    execFileSync('sc.exe', ['config', service.id, 'start=', 'auto'], { stdio: 'pipe' })
  }

  service.on('install', () => {
    try {
      setAutomaticStartup()
      console.log('MinecraftBotService otomatik başlangıca ayarlandı; hizmet başlatılıyor.')
      service.start()
    } catch (error) {
      console.error(`Hizmet kuruldu ancak otomatik başlatma/başlatma ayarlanamadı: ${error.message}`)
      process.exitCode = 1
    }
  })

  service.on('alreadyinstalled', () => {
    try {
      setAutomaticStartup()
      console.log('MinecraftBotService zaten kurulu; otomatik başlatma etkinleştirildi.')
    } catch (error) {
      console.error(`Hizmet otomatik başlatmaya ayarlanamadı: ${error.message}`)
      process.exitCode = 1
    }
  })

  service.on('invalidinstallation', () => {
    console.error('Hizmet kaydı eksik dosyalar içeriyor. Önce npm run service:uninstall çalıştırıp yeniden kurun.')
    process.exitCode = 1
  })

  service.on('start', () => {
    console.log('MinecraftBotService çalışıyor ve Windows ile otomatik başlayacak.')
  })

  service.on('error', error => {
    console.error(`Hizmet işlemi başarısız: ${error.message || error}`)
    process.exitCode = 1
  })

  try {
    service.install()
  } catch (error) {
    console.error(`Hizmet kurulamadı: ${error.message}`)
    process.exitCode = 1
  }
}
