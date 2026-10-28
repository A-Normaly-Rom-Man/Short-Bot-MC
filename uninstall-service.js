'use strict'

const { Service } = require('node-windows')

if (process.platform !== 'win32') {
  console.error('MinecraftBotService yalnızca Windows üzerinde kaldırılabilir.')
  process.exitCode = 1
} else {
  const service = new Service({
    name: 'MinecraftBotService',
    script: `${__dirname}\\index.js`,
    workingDirectory: __dirname
  })

  service.on('uninstall', () => {
    console.log('MinecraftBotService durduruldu ve Windows Hizmetleri listesinden kaldırıldı.')
  })

  service.on('alreadyuninstalled', () => {
    console.log('MinecraftBotService zaten kurulu değil.')
  })

  service.on('error', error => {
    console.error(`Hizmet kaldırılamadı: ${error.message || error}`)
    process.exitCode = 1
  })

  try {
    service.uninstall()
  } catch (error) {
    console.error(`Hizmet kaldırılamadı: ${error.message}`)
    process.exitCode = 1
  }
}
