# Arka planda 7/24 çalışma (PM2)

## 1. Kurulum ve başlatma
```bash
npm install
npm run pm2:start     # terminali kapatsanız da bot çalışmaya devam eder
npm run pm2:status
npm run pm2:logs
```
Panel: http://127.0.0.1:3000 (config.json → panel.port). Tarayıcı otomatik açılmaz.

## 2. Bilgisayar açılışında otomatik başlatma

### Linux / macOS / VPS
```bash
npx pm2 startup        # ekrana yazdığı sudo komutunu aynen çalıştırın
npm run pm2:start
npm run pm2:save
```

### Windows
`pm2 startup` Windows'ta desteklenmez. İki seçenek:
1. **Görev Zamanlayıcı (önerilen, ek paket yok):** Yeni görev → Tetikleyici "Oturum açıldığında" (veya "Başlangıçta") →
   Eylem: `cmd.exe`, Bağımsız değişken: `/c "cd /d C:\\proje\\yolu && npx pm2 resurrect"`.
   Önce `npm run pm2:start` ve `npm run pm2:save` çalıştırın.
2. **pm2-windows-startup:** `npm i -g pm2-windows-startup && pm2-startup install`, ardından `npm run pm2:save`.

> Projede ayrıca `npm run service:install` (node-windows hizmeti) var. **PM2 ile hizmeti aynı anda çalıştırmayın**:
> aynı hesapla iki oturum açılır, sunucu birini atar ve sürekli yeniden bağlanma döngüsü oluşur.
> Birini seçin; hizmeti kaldırmak için `npm run service:uninstall`.

## 3. Sık kullanılan komutlar
| Amaç | Komut |
|---|---|
| Yeniden başlat | `npm run pm2:restart` |
| Durdur | `npm run pm2:stop` |
| Listeden sil | `npm run pm2:delete` |
| Log dosyaları | `logs/pm2-out.log`, `logs/pm2-error.log` |
| Log temizle | `npx pm2 flush` |

## 4. Ağdan (iPad) erişim
`ecosystem.config.js` içindeki `PANEL_HOST: '0.0.0.0'` ve `PANEL_ACCESS_TOKEN` (en az 32 karakter) satırlarının yorumunu kaldırın,
`npm run pm2:restart` yapın; iPad'de panelin "Bağlantı" bölümüne `http://<bilgisayar-ip>:3000` ve token'ı girin.
Not: Ayarlar değişince `pm2 restart --update-env` gerekir.
