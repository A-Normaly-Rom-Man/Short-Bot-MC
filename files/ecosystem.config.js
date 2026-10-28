'use strict'

// PM2 yapılandırması — Minecraft AFK botu + web paneli (index.js)
//
// Kullanım (proje klasöründe):
//   npm install                      # pm2 dahil bağımlılıkları kurar
//   npm run pm2:start                # botu arka planda başlatır (terminal kapansa da çalışır)
//   npm run pm2:logs                 # canlı log
//   npm run pm2:restart | pm2:stop | pm2:delete | pm2:status
//   npm run pm2:save                 # çalışan listeyi kaydeder (yeniden başlatmada geri yüklenir)
//
// Bilgisayar açılışında otomatik başlatma için PM2_KURULUM.md dosyasına bakın.

const path = require('node:path')

module.exports = {
  apps: [
    {
      name: 'minecraft-afk-bot',
      script: 'index.js',
      cwd: __dirname,
      interpreter: 'node',
      instances: 1,            // Aynı hesapla tek oturum: asla cluster/çoklu örnek açmayın
      exec_mode: 'fork',
      autorestart: true,
      watch: false,            // config.json panelden yazılıyor; izleme açılırsa sonsuz yeniden başlatma olur
      max_restarts: 50,
      min_uptime: '20s',       // 20 sn dayanmayan çalıştırma "çökme" sayılır (ör. hatalı config.json)
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: '600M',
      kill_timeout: 8000,      // shutdown() botu düzgün kapatsın (bot.quit) diye bekleme süresi
      listen_timeout: 15000,
      shutdown_with_message: process.platform === 'win32', // Windows'ta SIGINT yerine "shutdown" mesajı
      time: true,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: path.join(__dirname, 'logs', 'pm2-out.log'),
      error_file: path.join(__dirname, 'logs', 'pm2-error.log'),
      env: {
        NODE_ENV: 'production',
        MINECRAFT_BOT_DAEMON: '1',   // tarayıcı açma ve "Enter'a basın" beklemesini kapatır
        // PANEL_HOST: '0.0.0.0',    // iPad'den ağ üzerinden erişmek için açın
        // PANEL_ACCESS_TOKEN: '...' // PANEL_HOST yerel değilse ZORUNLU (en az 32 karakter)
        // PANEL_ALLOWED_ORIGINS: 'http://192.168.1.20:3000'
      }
    }
  ]
}
