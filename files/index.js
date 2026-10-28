'use strict'

// Minertown AFK botu (Mineflayer) + Web Paneli (Express + Socket.io + SSE)
//
// Bot akışı:
//   spawn -> ~1 sn sonra giriş komutu -> tam 20 sn bekleme -> /skyblock
//   -> 20 sn ada yükleme -> oto-komut (örn. /günlük) -> her 24 saatte tekrar
//   Ayrıca: bağımsız anti-AFK (30 sn) ve 5 sn sonra otomatik yeniden bağlanma.
//
// Panel:
//   * public/index.html + public/app.js Express ile servis edilir.
//   * Canlı durum, log, sohbet ve pencere (sandık/GUI) verisi hem Socket.io (panelin kullandığı)
//     hem de SSE (/events) üzerinden yayınlanır.
//   * Panelden slota tıklama: Socket.io "click_window" olayı veya POST /api/click-slot.
//   * Sandık otomasyonu panel ayarlarından yönetilir; POST /api/trigger-deposit anlık tetikler.
//
// Ayarlar config.json dosyasından okunur (exe olarak çalışıyorsa exe'nin yanındaki dosya).

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const mineflayer = require('mineflayer')
const express = require('express')
const { Server } = require('socket.io')

// ───────────── Zamanlama kuralları ─────────────
const LOGIN_DELAY_MS = 1000          // spawn -> giriş komutu
const ENVOY_COOLDOWN_MS = 120000     // aynı etkinlik için tekrar tetikleme bekleme süresi
const EAT_CHECK_INTERVAL_MS = 3000   // oto-yeme periyodik kontrol
const EAT_LOW_HEALTH = 12            // can bu değerin altındaysa (ve aç değilse bile) yemek yenir
const EAT_TIMEOUT_MS = 6000          // tek bir yemek için azami süre
const EAT_QUEUE_WAIT_MS = 30000      // sıra beklerken azami süre
const EAT_RETRY_COOLDOWN_MS = 5000   // başarısız denemeden sonra bekleme
const EAT_PREFERRED = ['cooked_beef']
const EAT_AVOID = new Set([
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'suspicious_stew',
  'golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'ominous_bottle', 'honey_bottle', 'milk_bucket'
])
const STABILIZE_DELAY_MS = 20000     // giriş komutu -> /skyblock (tam 20 sn)
const ISLAND_LOAD_DELAY_MS = 20000   // Skyblock geçişi -> oto-komut
const AFK_INTERVAL_MS = 30000        // anti-AFK aralığı
const AFK_JUMP_MS = 300
const AFK_WALK_MS = 800
const DEFAULT_RECONNECT_SECONDS = 5
const DAILY_COMMAND = '/gunluk'
const DAILY_COMMAND_INTERVAL_MS = 86400000
const DEFAULT_CHEST_AUTOMATION_INTERVAL_MINUTES = 5
const MIN_CHEST_AUTOMATION_INTERVAL_MINUTES = 1
const MAX_CHEST_AUTOMATION_INTERVAL_MINUTES = 1440
const CHEST_OPEN_TIMEOUT_MS = 8000
const FOREIGN_WINDOW_GRACE_MS = 3000
const DEFAULT_CHEST_WHITELIST = ['cooked_beef', 'steak', 'biftek']

// ───────────── Panel sabitleri ─────────────
const MAX_PANEL_HISTORY = 500
const STATUS_INTERVAL_MS = 1000
const WINDOW_PUBLISH_MS = 80         // art arda gelen slot güncellemelerini tek pakette toplar
const CLICK_TIMEOUT_MS = 8000
const MINECRAFT_VERSIONS = ['1.21.4', '1.21.1', '1.20.4', '1.20.1']
const LOG_RANK = { error: 0, warn: 1, info: 2 }

// PM2 / hizmet / arka plan modunda: tarayıcı açılmaz, Enter beklenmez.
const IS_DAEMON = process.env.pm_id !== undefined || process.env.MINECRAFT_BOT_SERVICE === '1' ||
  process.env.MINECRAFT_BOT_DAEMON === '1' || !process.stdin.isTTY

const ROOT = process.pkg ? path.dirname(process.execPath) : __dirname
const CONFIG_PATH = path.join(ROOT, 'config.json')
const PUBLIC_DIR = path.join(__dirname, 'public')
const PANEL_HOST = (process.env.PANEL_HOST || '127.0.0.1').trim()
const PANEL_ACCESS_TOKEN = process.env.PANEL_ACCESS_TOKEN || ''
const REMOTE_ACCESS = !['127.0.0.1', 'localhost', '::1'].includes(PANEL_HOST.toLowerCase())
const ALLOWED_PANEL_ORIGINS = [
  'capacitor://localhost',
  ...(process.env.PANEL_ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean)
]

// ───────────── Güvenlik yardımcıları ─────────────
function isLoopbackAddress (address) {
  const normalized = String(address || '').toLowerCase().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '')
  return normalized === '::1' || normalized === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

// Ters vekil (reverse proxy) arkasındaki istekler yerel sayılmaz; anahtar gerekir.
function isLocalRequest (headers, address) {
  return isLoopbackAddress(address) && !headers['x-forwarded-for'] && !headers.forwarded
}

// DNS rebinding koruması: yalnızca yerel panelde Host başlığı yerel bir ad olmalı.
function isAllowedHostHeader (hostHeader) {
  if (REMOTE_ACCESS) return true
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

// Başka sitelerin (CORS / WebSocket) panele erişmesini engeller.
function isOriginAllowed (headers) {
  const origin = headers.origin
  if (!origin) return true
  if (ALLOWED_PANEL_ORIGINS.includes(origin)) return true
  try {
    const url = new URL(origin)
    if (url.host.toLowerCase() === String(headers.host || '').toLowerCase()) return true
    return isLoopbackAddress(url.hostname)
  } catch {
    return false
  }
}

function hasValidPanelToken (token) {
  if (!PANEL_ACCESS_TOKEN) return false
  const expected = Buffer.from(PANEL_ACCESS_TOKEN)
  const supplied = Buffer.from(typeof token === 'string' ? token : '')
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)
}

const app = express()
app.disable('x-powered-by')
app.use((request, response, next) => {
  if (!isAllowedHostHeader(request.headers.host)) {
    response.status(403).json({ error: 'Bu ana makine adıyla panele erişilemez.' })
    return
  }
  const origin = request.get('origin')
  if (!origin) return next()
  if (!isOriginAllowed(request.headers)) {
    response.status(403).json({ error: 'Bu kaynak için erişime izin verilmiyor.' })
    return
  }
  response.set('Access-Control-Allow-Origin', origin)
  response.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  response.set('Vary', 'Origin')
  if (request.method === 'OPTIONS') {
    response.sendStatus(204)
    return
  }
  next()
})
app.use(express.static(PUBLIC_DIR))
app.use(express.json({ limit: '16kb' }))
const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: ALLOWED_PANEL_ORIGINS },
  allowRequest: (request, callback) => {
    callback(null, isAllowedHostHeader(request.headers.host) && isOriginAllowed(request.headers))
  }
})

// ───────────── Durum ─────────────
let cfg = null
let rawConfig = null
let current = null
let reconnectTimer = null
let shuttingDown = false
let manuallyDisconnected = false
let pendingMsa = null
let lastStateJson = ''
let panelUrl = ''
const panelMeta = { lastDisconnectReason: '', lastKick: '', lastErrorCode: '', chestAutomationStatus: 'Bekleniyor.' }
const systemLogs = []
const chatMessages = []
const eventClients = new Set()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ───────────── Ayar yardımcıları ─────────────
class ConfigError extends Error {}

function text (value, fallback = '') {
  return typeof value === 'string' ? value.trim().replace(/[\r\n]/g, '') : fallback
}

function asCommand (value) {
  if (!value) return ''
  return value.startsWith('/') ? value : `/${value}`
}

function clamp (value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

function obj (value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizeChestCoordinates (value, fallback = null) {
  if (value === undefined) return fallback
  if (value === null) return null
  const coordinates = obj(value)
  const { x, y, z } = coordinates
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) ||
    Math.abs(x) > 30000000 || Math.abs(z) > 30000000 || y < -2048 || y > 4096) {
    throw new ConfigError('Sandık koordinatları tam sayı olmalı; X/Z ±30.000.000, Y -2.048 ile 4.096 arasında olmalıdır.')
  }
  return { x, y, z }
}

function normalizeKeywords (value, fallback = ['envoy']) {
  if (value === undefined) return fallback
  const list = Array.isArray(value) ? value : String(value || '').split(/[,\r\n]+/)
  const keywords = [...new Set(list.map(item => String(item || '').trim().toLocaleLowerCase('tr-TR')).filter(Boolean))]
  if (keywords.length > 20 || keywords.some(item => item.length > 64)) {
    throw new ConfigError('Envoy anahtar kelimeleri en fazla 20 adet ve her biri en fazla 64 karakter olmalıdır.')
  }
  return keywords
}

function normalizeItemName (value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s-]+/g, '_')
}

function normalizeChestWhitelist (value, fallback = DEFAULT_CHEST_WHITELIST) {
  if (value === undefined) value = fallback
  if (!Array.isArray(value) || value.length > 50) {
    throw new ConfigError('Korunan eşya listesi en fazla 50 eşya adı içermelidir.')
  }
  const names = value.map(normalizeItemName)
  if (names.some(name => !/^[a-z0-9_]{1,64}$/.test(name))) {
    throw new ConfigError('Korunan eşya adları yalnızca harf, sayı ve alt çizgi içerebilir.')
  }
  const whitelist = [...new Set([...DEFAULT_CHEST_WHITELIST, ...names])]
  if (whitelist.length > 50) throw new ConfigError('Biftek koruması dahil en fazla 50 eşya adı kaydedilebilir.')
  return whitelist
}

// ───────────── Log, sohbet ve gizli bilgi temizleme ─────────────
// Giriş komutu ve içindeki şifre log, sohbet ve panelde asla görünmez.
function redact (value) {
  let output = String(value)
  if (cfg && cfg.apiKey && cfg.apiKey.length >= 8) output = output.split(cfg.apiKey).join('[api-anahtarı]')
  const command = cfg && cfg.loginCommand
  if (command) {
    output = output.split(command).join('[gizli komut]')
    const space = command.indexOf(' ')
    const secret = space === -1 ? '' : command.slice(space + 1).trim()
    if (secret.length >= 4) output = output.split(secret).join('***')
  }
  return output
}

function logToSystem (message, level = 'info') {
  const threshold = LOG_RANK[(cfg && cfg.logLevel) || 'info']
  if (LOG_RANK[level] > threshold) return
  const time = new Date().toLocaleTimeString('tr-TR')
  const entry = { time, level, message: redact(message) }
  systemLogs.push(entry)
  if (systemLogs.length > MAX_PANEL_HISTORY) systemLogs.shift()
  const levelName = { error: 'HATA', warn: 'UYARI', info: 'BİLGİ' }[level] || level.toUpperCase()
  const line = `[${time}] ${levelName}: ${entry.message}`
  if (level === 'error') console.error(line)
  else console.log(line)
  io.emit('system_log', entry)
  emitSse('logsBatch', [entry])
}

function log (level, message) {
  const labels = { HATA: 'error', UYARI: 'warn', BİLGİ: 'info' }
  logToSystem(message, labels[level] || 'info')
}

function logToChat (sender, message) {
  const entry = {
    time: new Date().toLocaleTimeString('tr-TR'),
    sender: typeof sender === 'string' ? sender : '',
    text: redact(message)
  }
  chatMessages.push(entry)
  if (chatMessages.length > MAX_PANEL_HISTORY) chatMessages.shift()
  console.log(`[${entry.time}] SOHBET: ${entry.sender ? `${entry.sender}: ` : ''}${entry.text}`)
  io.emit('chat_message', entry)
  emitSse('chatsBatch', [entry])
}

// ───────────── SSE (/events) ─────────────
function writeSse (client, type, data) {
  try {
    client.write(`data: ${JSON.stringify({ type, data })}\n\n`)
  } catch (error) {
    eventClients.delete(client)
  }
}

function emitSse (type, data) {
  for (const client of eventClients) writeSse(client, type, data)
}

function hasPanelClients () {
  return eventClients.size > 0 || io.engine.clientsCount > 0
}

// ───────────── Yardımcılar ─────────────
// Kick/hata sebepleri string, JSON metni veya NBT benzeri nesne olabilir; okunur metne çevirir.
function readable (value, seen = new Set()) {
  if (value == null) return ''
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return readable(JSON.parse(trimmed), seen) } catch {}
    }
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value !== 'object' || seen.has(value)) return ''
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => readable(item, seen)).join('')
  if (Object.hasOwn(value, 'value')) return readable(value.value, seen)

  const parts = []
  if (typeof value.text === 'string') parts.push(value.text)
  else if (typeof value.translate === 'string') parts.push(value.translate)
  if (Array.isArray(value.with)) parts.push(readable(value.with, seen))
  if (Array.isArray(value.extra)) parts.push(readable(value.extra, seen))
  if (parts.length) return parts.filter(Boolean).join(' ')
  return Object.values(value).map(item => readable(item, seen)).filter(Boolean).join(' ')
}

// Renk kodlarını (§a gibi) atıp düz metin üretir.
function cleanText (value) {
  return readable(value).replace(/§[0-9a-fk-or]/gi, '').trim()
}

function classifyError (error) {
  const code = error && error.code ? String(error.code) : ''
  const message = error && error.message ? String(error.message) : String(error)
  if (code === 'ECONNREFUSED') return { code: 'ERR_CONNECTION_REFUSED', title: 'Sunucu bağlantıyı reddetti', message }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code: 'ERR_DNS_FAILED', title: 'Sunucu adresi çözülemedi', message }
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') return { code: 'ERR_CONNECTION_TIMEOUT', title: 'Bağlantı zaman aşımına uğradı', message }
  if (code === 'ECONNRESET' || code === 'EPIPE') return { code: 'ERR_CONNECTION_RESET', title: 'Bağlantı sunucu tarafından kesildi', message }
  return { code: code || 'ERR_CONNECTION_FAILED', title: 'Bağlantı hatası', message }
}

function notifyError (notice) {
  panelMeta.lastErrorCode = notice.code
  io.emit('errorNotice', notice)
  emitSse('errorNotice', notice)
}

// ───────────── Pencere (sandık / GUI) verisi ─────────────
function itemSnapshot (item, slot) {
  if (!item) return null
  let displayName = item.displayName || item.name
  let lore = []
  try {
    if (item.customName) displayName = cleanText(item.customName) || displayName
  } catch {}
  try {
    if (Array.isArray(item.customLore)) lore = item.customLore.map(cleanText).filter(Boolean).slice(0, 12)
  } catch {}
  return {
    slot,
    slotId: slot,
    name: String(item.name || 'unknown'),
    displayName: String(displayName || 'Bilinmeyen eşya').slice(0, 80),
    id: item.type,
    count: item.count,
    lore
  }
}

function windowColumns (type) {
  const value = String(type)
  const generic = /generic_(\d+)x\d+/.exec(value)
  if (generic) return Number(generic[1])
  if (/hopper/.test(value)) return 5
  return 9
}

function snapshotWindow (window) {
  const total = Array.isArray(window.slots) ? window.slots.length : 0
  const slots = []
  for (let slot = 0; slot < total; slot++) slots.push(itemSnapshot(window.slots[slot], slot))
  return {
    open: true,
    windowId: window.id,
    title: cleanText(window.title) || 'Minecraft penceresi',
    type: String(window.type),
    columns: windowColumns(window.type),
    inventoryStart: Number.isInteger(window.inventoryStart) ? window.inventoryStart : total,
    slots
  }
}

function publishWindow (window) {
  const state = window ? snapshotWindow(window) : null
  io.emit('window_state', state)
  emitSse('window', state)
}

function queueWindowPublish (session) {
  if (session.windowTimer) return
  session.windowTimer = setTimeout(() => {
    session.windowTimer = null
    if (session.ended || current !== session || !session.activeWindow) return
    if (hasPanelClients()) publishWindow(session.activeWindow)
  }, WINDOW_PUBLISH_MS)
}

// Panelden gelen slot tıklaması: bot.clickWindow(slot, 0, 0) (sol tık)
async function clickPanelWindow (payload) {
  const session = current
  const slot = payload && payload.slot
  if (!session || session.ended || !session.spawned || !session.bot) {
    return { ok: false, status: 409, code: 'ERR_BOT_NOT_CONNECTED', error: 'Bot sunucuya bağlı değil.' }
  }
  const window = session.activeWindow
  const open = session.bot.currentWindow
  if (!window || !open || open.id !== window.id || !payload || payload.windowId !== window.id) {
    return { ok: false, status: 409, code: 'ERR_WINDOW_CLOSED', error: 'Minecraft penceresi artık açık değil; paneli yenileyin.' }
  }
  if (!Number.isInteger(slot) || slot < 0 || slot >= window.slots.length) {
    return { ok: false, status: 400, code: 'ERR_INVALID_SLOT', error: 'Geçersiz pencere slotu.' }
  }
  if (session.clickBusy) {
    return { ok: false, status: 429, code: 'ERR_CLICK_BUSY', error: 'Önceki tıklama henüz tamamlanmadı.' }
  }
  if (session.eatBusy) {
    return { ok: false, status: 429, code: 'ERR_EAT_BUSY', error: 'Bot yemek yerken pencereye tıklanamaz.' }
  }
  if (session.depositBusy) {
    return { ok: false, status: 429, code: 'ERR_CHEST_BUSY', error: 'Sandık aktarımı sürerken pencereye tıklanamaz.' }
  }
  session.clickBusy = true
  let timer
  try {
    const label = window.slots[slot] ? cleanText(itemSnapshot(window.slots[slot], slot).displayName) : 'boş'
    log('BİLGİ', `Panelden slot tıklandı: ${slot} (${label})`)
    await Promise.race([
      session.bot.clickWindow(slot, 0, 0),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Sunucu tıklamaya yanıt vermedi.')), CLICK_TIMEOUT_MS)
      })
    ])
    return { ok: true }
  } catch (error) {
    log('UYARI', `Panel slot tıklaması başarısız (slot ${slot}): ${error.message}`)
    return { ok: false, status: 502, code: 'ERR_WINDOW_CLICK', error: 'Minecraft slotuna tıklanamadı.' }
  } finally {
    clearTimeout(timer)
    session.clickBusy = false
  }
}

// ───────────── Ayarlar ─────────────
function defaultRawConfig () {
  return {
    server: { host: 'play.minertown.net', port: 25565 },
    account: { username: 'KullaniciAdi', auth: 'offline', serverCommand: '/login SIFRENIZ' },
    minecraftVersion: '1.21.4',
    sequentialFlow: { enabled: true, firstCommand: '/skyblock' },
    antiAfk: { enabled: true, minSeconds: 30, maxSeconds: 30 },
    reconnect: { enabled: true, initialSeconds: 5, maxSeconds: 5 },
    autoEat: { enabled: false, hungerThreshold: 14 },
    autoClicker: { enabled: true, command: '/günlük', slots: [10, 11, 12, 13, 14, 15, 16], intervalHours: 24 },
    chestAutomation: {
      enabled: true,
      intervalMinutes: DEFAULT_CHEST_AUTOMATION_INTERVAL_MINUTES,
      coordinates: null,
      whitelist: DEFAULT_CHEST_WHITELIST
    },
    autoResponder: { enabled: false, rules: [] },
    discord: { webhookUrl: '' },
    apiKey: '',
    envoy: { enabled: true, keywords: ['envoy'], coordinates: null },
    logLevel: 'info',
    panel: { port: 3000, openBrowser: true }
  }
}

// Ham ayar nesnesinden botun kullandığı düz ayarı üretir.
function normalizeConfig (raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('config.json geçerli bir JSON nesnesi olmalı.')
  const server = obj(raw.server)
  const account = obj(raw.account)
  const flow = obj(raw.sequentialFlow)
  const antiAfk = obj(raw.antiAfk)
  const clicker = obj(raw.autoClicker)
  const chestAutomation = obj(raw.chestAutomation)
  const reconnect = obj(raw.reconnect)
  const autoEatRaw = obj(raw.autoEat)
  const envoyRaw = obj(raw.envoy)

  // Panelin yazdığı autoClicker.* önceliklidir; eski üst düzey anahtarlar yedek olarak okunur.
  const commandSource = clicker.command !== undefined ? clicker.command : raw.autoCommand
  if (raw.chestAutomation !== undefined &&
    (!raw.chestAutomation || typeof raw.chestAutomation !== 'object' || Array.isArray(raw.chestAutomation))) {
    throw new ConfigError('Sandık otomasyonu ayarı bir JSON nesnesi olmalıdır.')
  }
  if (chestAutomation.enabled !== undefined && typeof chestAutomation.enabled !== 'boolean') {
    throw new ConfigError('Sandık otomasyonu açık/kapalı değeri boolean olmalıdır.')
  }

  const result = {
    host: text(server.host),
    port: clamp(server.port, 25565, 1, 65535),
    username: text(account.username).slice(0, 16),
    auth: account.auth === 'microsoft' ? 'microsoft' : 'offline',
    loginCommand: asCommand(text(account.serverCommand)),
    version: text(raw.minecraftVersion) || '1.21.4',
    flowEnabled: flow.enabled !== false,
    skyblockCommand: asCommand(text(flow.firstCommand)) || '/skyblock',
    autoCommand: clicker.enabled === false ? '' : asCommand(text(commandSource, '/günlük')),
    autoCommandIntervalMs: DAILY_COMMAND_INTERVAL_MS,
    chestAutomationEnabled: chestAutomation.enabled !== false,
    chestAutomationIntervalMs: Math.round(clamp(
      chestAutomation.intervalMinutes,
      DEFAULT_CHEST_AUTOMATION_INTERVAL_MINUTES,
      MIN_CHEST_AUTOMATION_INTERVAL_MINUTES,
      MAX_CHEST_AUTOMATION_INTERVAL_MINUTES
    )) * 60000,
    chestCoordinates: normalizeChestCoordinates(chestAutomation.coordinates),
    chestWhitelist: normalizeChestWhitelist(chestAutomation.whitelist),
    antiAfkEnabled: antiAfk.enabled !== false,
    apiKey: text(raw.apiKey).slice(0, 256),
    envoyEnabled: envoyRaw.enabled !== false,
    envoyKeywords: normalizeKeywords(envoyRaw.keywords),
    envoyCoordinates: normalizeChestCoordinates(envoyRaw.coordinates),
    autoEatEnabled: autoEatRaw.enabled === true,
    autoEatThreshold: Math.round(clamp(autoEatRaw.hungerThreshold, 14, 1, 20)),
    reconnectEnabled: reconnect.enabled !== false,
    reconnectMs: DEFAULT_RECONNECT_SECONDS * 1000,
    logLevel: Object.hasOwn(LOG_RANK, raw.logLevel) ? raw.logLevel : 'info'
  }
  if (!result.host || !result.username) {
    throw new ConfigError('config.json içinde server.host ve account.username doldurulmalı.')
  }
  return result
}

function loadConfig () {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(defaultRawConfig(), null, 2)}\n`, 'utf8')
    throw new ConfigError(`config.json bulunamadı; örnek dosya oluşturuldu:\n${CONFIG_PATH}\nİçini doldurup programı yeniden başlatın.`)
  }
  try {
    rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch (error) {
    throw new ConfigError(`config.json okunamadı: ${error.message}`)
  }
  return normalizeConfig(rawConfig)
}

// Panelin gönderdiği veriyi doğrulayıp mevcut ayarla birleştirir; gizli alanlar boşsa korunur.
function mergeIncoming (incoming) {
  const old = obj(rawConfig)
  const inc = obj(incoming)
  if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new ConfigError('Ayar verisi bir JSON nesnesi olmalıdır.')
  }
  const oServer = obj(old.server); const iServer = obj(inc.server)
  const oAccount = obj(old.account); const iAccount = obj(inc.account)
  const oFlow = obj(old.sequentialFlow); const iFlow = obj(inc.sequentialFlow)
  const oAfk = obj(old.antiAfk); const iAfk = obj(inc.antiAfk)
  const oReconnect = obj(old.reconnect); const iReconnect = obj(inc.reconnect)
  const oEat = obj(old.autoEat); const iEat = obj(inc.autoEat)
  const oClicker = obj(old.autoClicker); const iClicker = obj(inc.autoClicker)
  const oChestAutomation = obj(old.chestAutomation); const iChestAutomation = obj(inc.chestAutomation)
  const oResponder = obj(old.autoResponder); const iResponder = obj(inc.autoResponder)
  const oDiscord = obj(old.discord); const iDiscord = obj(inc.discord)
  const oPanel = obj(old.panel); const iPanel = obj(inc.panel)
  if (inc.chestAutomation !== undefined &&
    (!inc.chestAutomation || typeof inc.chestAutomation !== 'object' || Array.isArray(inc.chestAutomation))) {
    throw new ConfigError('Sandık otomasyonu ayarı bir JSON nesnesi olmalıdır.')
  }

  const host = text(iServer.host, text(oServer.host))
  if (!host || host.length > 255 || /\s/.test(host)) throw new ConfigError('Sunucu adresi geçerli olmalıdır.')
  const username = text(iAccount.username, text(oAccount.username))
  if (!username || username.length > 16) throw new ConfigError('Kullanıcı adı 1-16 karakter olmalıdır.')

  let serverCommand = text(oAccount.serverCommand)
  if (iAccount.clearServerCommand === true) serverCommand = ''
  else if (typeof iAccount.serverCommand === 'string' && iAccount.serverCommand.trim()) {
    serverCommand = text(iAccount.serverCommand)
    if (serverCommand.length > 256) throw new ConfigError('Giriş komutu en fazla 256 karakter olmalıdır.')
  }

  let webhookUrl = text(oDiscord.webhookUrl)
  if (iDiscord.clearWebhook === true) webhookUrl = ''
  else if (typeof iDiscord.webhookUrl === 'string' && iDiscord.webhookUrl.trim()) {
    webhookUrl = text(iDiscord.webhookUrl)
    let parsed
    try { parsed = new URL(webhookUrl) } catch {}
    if (!parsed || parsed.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(parsed.hostname) ||
      !parsed.pathname.startsWith('/api/webhooks/')) {
      throw new ConfigError('Discord webhook adresi geçerli değil.')
    }
  }

  let apiKey = text(old.apiKey)
  if (inc.clearApiKey === true) apiKey = ''
  else if (typeof inc.apiKey === 'string' && inc.apiKey.trim()) {
    apiKey = inc.apiKey.trim()
    if (apiKey.length > 256 || /\s/.test(apiKey)) throw new ConfigError('API anahtarı boşluk içermemeli ve en fazla 256 karakter olmalıdır.')
  }
  const oEnvoy = obj(old.envoy); const iEnvoy = obj(inc.envoy)
  const envoy = {
    enabled: iEnvoy.enabled !== undefined ? iEnvoy.enabled === true : oEnvoy.enabled !== false,
    keywords: normalizeKeywords(iEnvoy.keywords !== undefined ? iEnvoy.keywords : oEnvoy.keywords),
    coordinates: normalizeChestCoordinates(iEnvoy.coordinates, normalizeChestCoordinates(oEnvoy.coordinates))
  }

  const firstCommand = text(iFlow.firstCommand, text(oFlow.firstCommand)) || '/skyblock'
  if (firstCommand.length > 256) throw new ConfigError('İlk sunucu komutu en fazla 256 karakter olmalıdır.')

  const clickerCommand = text(iClicker.command, text(oClicker.command))
  const clickerEnabled = iClicker.enabled !== undefined ? iClicker.enabled !== false : oClicker.enabled !== false
  if (clickerEnabled && (!clickerCommand || clickerCommand.length > 256)) {
    throw new ConfigError('Otomatik komut 1-256 karakter olmalıdır.')
  }
  let slots = Array.isArray(oClicker.slots) ? oClicker.slots : []
  if (Array.isArray(iClicker.slots)) {
    if (iClicker.slots.length > 54 || iClicker.slots.some(slot => !Number.isInteger(slot) || slot < 0 || slot > 53) ||
      new Set(iClicker.slots).size !== iClicker.slots.length) {
      throw new ConfigError('Slotlar 0-53 arasında, tekrarsız sayılar olmalıdır.')
    }
    slots = iClicker.slots
  }

  let rules = Array.isArray(oResponder.rules) ? oResponder.rules : []
  if (Array.isArray(iResponder.rules)) {
    if (iResponder.rules.length > 20) throw new ConfigError('En fazla 20 oto-yanıt kuralı ekleyebilirsiniz.')
    rules = iResponder.rules.map(rule => {
      const keyword = text(obj(rule).keyword)
      const response = text(obj(rule).response)
      if (!keyword || keyword.length > 80 || !response || response.length > 256) {
        throw new ConfigError('Oto-yanıt kuralında kelime en fazla 80, yanıt 1-256 karakter olmalıdır.')
      }
      return { keyword, response }
    })
  }

  const version = text(inc.minecraftVersion, text(old.minecraftVersion)) || '1.21.4'
  if (!MINECRAFT_VERSIONS.includes(version)) throw new ConfigError('Desteklenmeyen Minecraft sürümü.')
  const logLevel = Object.hasOwn(LOG_RANK, inc.logLevel) ? inc.logLevel : (Object.hasOwn(LOG_RANK, old.logLevel) ? old.logLevel : 'info')
  if (iChestAutomation.enabled !== undefined && typeof iChestAutomation.enabled !== 'boolean') {
    throw new ConfigError('Sandık otomasyonu açık/kapalı değeri boolean olmalıdır.')
  }
  const existingChestCoordinates = normalizeChestCoordinates(oChestAutomation.coordinates)
  const chestCoordinates = normalizeChestCoordinates(iChestAutomation.coordinates, existingChestCoordinates)
  const chestWhitelist = normalizeChestWhitelist(iChestAutomation.whitelist, normalizeChestWhitelist(oChestAutomation.whitelist))
  const existingChestInterval = Math.round(clamp(
    oChestAutomation.intervalMinutes,
    DEFAULT_CHEST_AUTOMATION_INTERVAL_MINUTES,
    MIN_CHEST_AUTOMATION_INTERVAL_MINUTES,
    MAX_CHEST_AUTOMATION_INTERVAL_MINUTES
  ))
  const chestIntervalMinutes = iChestAutomation.intervalMinutes === undefined
    ? existingChestInterval
    : iChestAutomation.intervalMinutes
  if (!Number.isInteger(chestIntervalMinutes) ||
    chestIntervalMinutes < MIN_CHEST_AUTOMATION_INTERVAL_MINUTES ||
    chestIntervalMinutes > MAX_CHEST_AUTOMATION_INTERVAL_MINUTES) {
    throw new ConfigError(`Sandık aralığı ${MIN_CHEST_AUTOMATION_INTERVAL_MINUTES}-${MAX_CHEST_AUTOMATION_INTERVAL_MINUTES} dakika arasında tam sayı olmalıdır.`)
  }

  const next = {
    ...old,
    server: { host, port: Math.round(clamp(iServer.port, clamp(oServer.port, 25565, 1, 65535), 1, 65535)) },
    account: { username, auth: (iAccount.auth || oAccount.auth) === 'microsoft' ? 'microsoft' : 'offline', serverCommand },
    minecraftVersion: version,
    sequentialFlow: {
      enabled: iFlow.enabled !== undefined ? iFlow.enabled !== false : oFlow.enabled !== false,
      firstCommand
    },
    antiAfk: {
      enabled: iAfk.enabled !== undefined ? iAfk.enabled !== false : oAfk.enabled !== false,
      minSeconds: 30,
      maxSeconds: 30
    },
    reconnect: {
      enabled: iReconnect.enabled !== undefined ? iReconnect.enabled !== false : oReconnect.enabled !== false,
      initialSeconds: DEFAULT_RECONNECT_SECONDS,
      maxSeconds: DEFAULT_RECONNECT_SECONDS
    },
    autoEat: {
      enabled: iEat.enabled !== undefined ? iEat.enabled === true : oEat.enabled === true,
      hungerThreshold: Math.round(clamp(iEat.hungerThreshold, clamp(oEat.hungerThreshold, 14, 1, 20), 1, 20))
    },
    autoClicker: {
      enabled: clickerEnabled,
      command: clickerCommand || '/günlük',
      slots,
      intervalHours: 24
    },
    chestAutomation: {
      enabled: iChestAutomation.enabled !== undefined ? iChestAutomation.enabled === true : oChestAutomation.enabled !== false,
      intervalMinutes: chestIntervalMinutes,
      coordinates: chestCoordinates,
      whitelist: chestWhitelist
    },
    autoResponder: {
      enabled: iResponder.enabled !== undefined ? iResponder.enabled === true : oResponder.enabled === true,
      rules
    },
    discord: { webhookUrl },
    apiKey,
    envoy,
    logLevel,
    panel: {
      port: Math.round(clamp(iPanel.port, clamp(oPanel.port, 3000, 1, 65535), 1, 65535)),
      openBrowser: iPanel.openBrowser !== undefined ? iPanel.openBrowser !== false : oPanel.openBrowser !== false
    }
  }
  // Eski üst düzey anahtarlar artık autoClicker.* ile çakışmasın.
  delete next.autoCommand
  delete next.autoCommandIntervalHours
  return next
}

function persistConfig (incoming) {
  const next = mergeIncoming(incoming)
  const normalized = normalizeConfig(next)
  const temporaryPath = `${CONFIG_PATH}.tmp`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    fs.renameSync(temporaryPath, CONFIG_PATH)
  } catch (error) {
    try { fs.unlinkSync(temporaryPath) } catch {}
    throw new ConfigError(`config.json kaydedilemedi: ${error.message}`)
  }
  rawConfig = next
  return normalized
}

// Panele giden ayar özeti; şifre komutu ve webhook adresi asla gönderilmez.
function publicConfig () {
  const raw = obj(rawConfig)
  const server = obj(raw.server)
  const account = obj(raw.account)
  const flow = obj(raw.sequentialFlow)
  const antiAfk = obj(raw.antiAfk)
  const reconnect = obj(raw.reconnect)
  const autoEat = obj(raw.autoEat)
  const clicker = obj(raw.autoClicker)
  const chestAutomation = obj(raw.chestAutomation)
  const responder = obj(raw.autoResponder)
  const discord = obj(raw.discord)
  const panel = obj(raw.panel)
  const version = text(raw.minecraftVersion) || '1.21.4'
  return {
    server: { host: text(server.host), port: clamp(server.port, 25565, 1, 65535) },
    account: {
      username: text(account.username),
      auth: account.auth === 'microsoft' ? 'microsoft' : 'offline',
      hasServerCommand: Boolean(text(account.serverCommand))
    },
    minecraftVersion: version,
    sequentialFlow: { enabled: flow.enabled !== false, firstCommand: text(flow.firstCommand) || '/skyblock' },
    antiAfk: { enabled: antiAfk.enabled !== false, minSeconds: 30, maxSeconds: 30 },
    reconnect: {
      enabled: reconnect.enabled !== false,
      initialSeconds: DEFAULT_RECONNECT_SECONDS,
      maxSeconds: DEFAULT_RECONNECT_SECONDS
    },
    autoEat: { enabled: autoEat.enabled === true, hungerThreshold: clamp(autoEat.hungerThreshold, 14, 1, 20) },
    autoClicker: {
      enabled: clicker.enabled !== false,
      command: text(clicker.command) || text(raw.autoCommand) || '/günlük',
      slots: Array.isArray(clicker.slots) ? clicker.slots : [],
      intervalHours: 24
    },
    chestAutomation: {
      enabled: chestAutomation.enabled !== false,
      intervalMinutes: Math.round(clamp(
        chestAutomation.intervalMinutes,
        DEFAULT_CHEST_AUTOMATION_INTERVAL_MINUTES,
        MIN_CHEST_AUTOMATION_INTERVAL_MINUTES,
        MAX_CHEST_AUTOMATION_INTERVAL_MINUTES
      )),
      coordinates: normalizeChestCoordinates(chestAutomation.coordinates),
      whitelist: normalizeChestWhitelist(chestAutomation.whitelist)
    },
    autoResponder: { enabled: responder.enabled === true, rules: Array.isArray(responder.rules) ? responder.rules : [] },
    discord: { hasWebhook: Boolean(text(discord.webhookUrl)) },
    apiKeyInfo: { configured: Boolean(text(raw.apiKey)), hint: text(raw.apiKey).length >= 8 ? `…${text(raw.apiKey).slice(-4)}` : '' },
    envoy: {
      enabled: obj(raw.envoy).enabled !== false,
      keywords: normalizeKeywords(obj(raw.envoy).keywords),
      coordinates: normalizeChestCoordinates(obj(raw.envoy).coordinates)
    },
    logLevel: Object.hasOwn(LOG_RANK, raw.logLevel) ? raw.logLevel : 'info',
    panel: { port: clamp(panel.port, 3000, 1, 65535), openBrowser: panel.openBrowser !== false },
    runtime: { node: process.version, minecraft: version }
  }
}

function publishConfig () {
  const config = publicConfig()
  io.emit('init_config', config)
  emitSse('config', config)
}

// ───────────── Canlı durum ─────────────
function formatGameTime (ticks) {
  const hours = Math.floor(ticks / 1000 + 6) % 24
  const minutes = Math.floor((ticks % 1000) * 60 / 1000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function round1 (number) {
  return Math.round(Number(number) * 10) / 10
}

function publishChestAutomationStatus (message) {
  panelMeta.chestAutomationStatus = message
  publishBotState()
}

function scheduleChestAutomation (session) {
  session.chestScheduleGeneration++
  const generation = session.chestScheduleGeneration
  clearTimeout(session.chestTimer)
  session.chestTimer = null
  session.chestTimerAt = null
  if (session.ended || !session.spawned || !cfg.chestAutomationEnabled) {
    if (session && !session.ended && !cfg.chestAutomationEnabled) panelMeta.chestAutomationStatus = 'Sandık otomasyonu kapalı.'
    publishBotState()
    return
  }
  const scheduleNext = delay => {
    session.chestTimerAt = Date.now() + delay
    session.chestTimer = setTimeout(async () => {
      session.chestTimer = null
      session.chestTimerAt = null
      if (session.ended || current !== session || !cfg.chestAutomationEnabled ||
        generation !== session.chestScheduleGeneration) {
        publishBotState()
        return
      }
      if (session.envoyActive) {
        log('BİLGİ', '[Sandık] Envoy etkinliği sürüyor; standart döngü askıda, sonraki aralıkta devam edecek.')
      } else {
        await enqueueTask(session, 'Sandık', () => runChestDeposit(session, false))
      }
      if (!session.ended && current === session && cfg.chestAutomationEnabled &&
        generation === session.chestScheduleGeneration) {
        scheduleNext(cfg.chestAutomationIntervalMs)
        publishBotState()
      }
    }, delay)
    session.chestTimer.unref()
  }
  panelMeta.chestAutomationStatus = `Sonraki otomatik sandık işlemi ${cfg.chestAutomationIntervalMs / 60000} dakika içinde.`
  scheduleNext(cfg.chestAutomationIntervalMs)
  publishBotState()
}

function isProtectedChestItem (item) {
  const protectedNames = new Set(cfg.chestWhitelist)
  return [item.name, item.displayName, item.customName]
    .filter(Boolean)
    .some(name => protectedNames.has(normalizeItemName(name)))
}

function skipChestDeposit (session, message, manual) {
  log('BİLGİ', `[Sandık] ${message}${manual ? '' : ' Otomatik işlem atlandı.'}`)
  panelMeta.chestAutomationStatus = message
  publishBotState()
  return { ok: false, status: 409, code: 'ERR_CHEST_UNAVAILABLE', error: message }
}

async function closeChestWindow (bot, window) {
  if (!bot || !window || bot.currentWindow !== window) return
  if (typeof bot.closeWindow === 'function') {
    await bot.closeWindow(window)
    return
  }
  if (typeof window.close === 'function') {
    await window.close()
    return
  }
  throw new Error('Mineflayer pencere kapatma API’si bulunamadı.')
}

async function walkToCoordinate (session, target, timeoutMs = 25000) {
  const bot = session.bot
  if (!bot || !bot.entity) return false
  const goalX = target.x + 0.5
  const goalZ = target.z + 0.5
  const previousPhysics = bot.physicsEnabled
  const deadline = Date.now() + timeoutMs
  let lastPosition = bot.entity.position.clone()
  let lastProgressAt = Date.now()
  try {
    bot.physicsEnabled = true
    while (!session.ended && current === session && Date.now() < deadline) {
      const position = bot.entity.position
      const dx = goalX - position.x
      const dz = goalZ - position.z
      const dy = target.y - position.y
      if (Math.hypot(dx, dz) < 0.7 && Math.abs(dy) < 2) return true
      await bot.look(Math.atan2(-dx, -dz), 0, true)
      bot.setControlState('forward', true)
      const stuck = position.distanceTo(lastPosition) < 0.05
      if (!stuck) { lastPosition = position.clone(); lastProgressAt = Date.now() }
      bot.setControlState('jump', dy > 0.6 || (stuck && Date.now() - lastProgressAt > 600))
      await sleep(100)
    }
    return false
  } finally {
    releaseControls(session)
    bot.physicsEnabled = previousPhysics
  }
}

async function runChestDeposit (session, manual = false, overrideCoordinates = null) {
  if (!session || session.ended || current !== session || !session.spawned || !session.bot) {
    return { ok: false, status: 409, code: 'ERR_BOT_NOT_CONNECTED', error: 'Bot sunucuya bağlı değil.' }
  }
  if (!manual && !cfg.chestAutomationEnabled) {
    return { ok: false, status: 409, code: 'ERR_CHEST_AUTOMATION_DISABLED', error: 'Sandık otomasyonu kapalı.' }
  }
  if (session.depositBusy || session.depositQueued) {
    return { ok: false, status: 409, code: 'ERR_CHEST_BUSY', error: 'Bir sandık aktarımı zaten sürüyor.' }
  }
  const coordinates = overrideCoordinates || cfg.chestCoordinates
  session.depositQueued = true
  publishChestAutomationStatus('Botun hareketi veya açık pencere kapanması bekleniyor; işlem atlanmayacak.')
  let chest = null
  let openTimeout = null
  let openTimedOut = false
  try {
    let foreignWindowSince = 0
    while (!session.ended && current === session &&
      (session.moving || session.clickBusy || session.eatBusy || session.activeWindow)) {
      // Hareket/tıklama bitene kadar bekle; işlem asla iptal edilmez.
      if (!session.moving && !session.clickBusy && !session.eatBusy && session.activeWindow) {
        // Açık kalmış yabancı pencere (örn. sunucu menüsü) döngüyü sonsuza dek kilitlemesin.
        if (!foreignWindowSince) foreignWindowSince = Date.now()
        if (Date.now() - foreignWindowSince > FOREIGN_WINDOW_GRACE_MS) {
          try {
            await closeChestWindow(session.bot, session.activeWindow)
          } catch (error) {
            log('UYARI', `[Sandık] Açık pencere kapatılamadı: ${error.message}`)
          }
          session.activeWindow = null
          foreignWindowSince = 0
        }
      } else {
        foreignWindowSince = 0
      }
      await sleep(25)
    }
    if (session.ended || current !== session || !session.spawned || !session.bot) {
      return { ok: false, status: 409, code: 'ERR_BOT_NOT_CONNECTED', error: 'Bot bekleme sırasında bağlantıyı kaybetti.' }
    }
    session.depositQueued = false
    session.depositBusy = true
    publishChestAutomationStatus('Sandık aranıyor.')
    const bot = session.bot
    if (!bot.entity || !bot.entity.position) {
      return skipChestDeposit(session, 'Bot konumu henüz hazır değil.', manual)
    }
    if (coordinates) {
      publishChestAutomationStatus(`Hedef koordinata gidiliyor (${coordinates.x}, ${coordinates.y}, ${coordinates.z}).`)
      const arrived = await walkToCoordinate(session, coordinates)
      if (session.ended || current !== session) {
        return { ok: false, status: 409, code: 'ERR_BOT_NOT_CONNECTED', error: 'Bot yürürken bağlantıyı kaybetti.' }
      }
      if (!arrived) log('UYARI', '[Sandık] Hedef koordinata tam ulaşılamadı; yakındaki sandık denenecek.')
    }
    const isChest = candidate => candidate && ['chest', 'trapped_chest', 'barrel'].includes(candidate.name)
    let block = typeof bot.findBlock === 'function'
      ? bot.findBlock({ matching: candidate => isChest(candidate), maxDistance: 5 })
      : null
    // Hedef koordinatta tam bir sandık/varil varsa öncelik onundur.
    if (coordinates && typeof bot.blockAt === 'function') {
      const exact = bot.blockAt(new (bot.entity.position.constructor)(coordinates.x, coordinates.y, coordinates.z))
      if (isChest(exact)) block = exact
    }
    if (!isChest(block) && typeof bot.blockAtCursor === 'function') block = bot.blockAtCursor(5)
    if (!isChest(block)) {
      const location = coordinates ? ` (${coordinates.x}, ${coordinates.y}, ${coordinates.z})` : ''
      return skipChestDeposit(session, `Sandık bulunamadı${location}; koordinatı ve çevredeki sandığı kontrol edin.`, manual)
    }
    if (bot.entity.position.distanceTo(block.position) > 5) {
      return skipChestDeposit(session, 'Sandık botun erişim mesafesinin dışında.', manual)
    }

    const opening = bot.openChest(block)
    opening.then(openedChest => {
      if (openTimedOut && bot.currentWindow === openedChest) {
        void closeChestWindow(bot, openedChest).catch(error => {
          log('UYARI', `[Sandık] Zaman aşımından sonra açılan pencere kapatılamadı: ${error.message}`)
        })
      }
    }, () => {})
    chest = await Promise.race([
      opening,
      new Promise((resolve, reject) => {
        openTimeout = setTimeout(() => {
          openTimedOut = true
          reject(new Error('Sandık arayüzü zamanında açılmadı.'))
        }, CHEST_OPEN_TIMEOUT_MS)
      })
    ])
    clearTimeout(openTimeout)
    openTimeout = null
    if (session.ended || current !== session || bot.currentWindow !== chest) {
      return skipChestDeposit(session, 'Sandık açılırken bağlantı veya pencere durumu değişti.', manual)
    }

    const transfers = new Map()
    for (const item of bot.inventory.items()) {
      if (isProtectedChestItem(item)) continue
      const nbt = item.nbt || null
      const key = `${item.type}:${item.metadata ?? ''}:${nbt ? JSON.stringify(nbt) : ''}`
      const transfer = transfers.get(key)
      if (transfer) transfer.count += item.count
      else transfers.set(key, {
        type: item.type,
        metadata: item.metadata ?? null,
        nbt,
        count: item.count,
        name: item.name
      })
    }

    let movedCount = 0
    for (const item of transfers.values()) {
      if (session.ended || current !== session) break
      await chest.deposit(item.type, item.metadata, item.count, item.nbt)
      movedCount += item.count
    }
    const message = movedCount
      ? `${movedCount} eşya sandığa aktarıldı; biftek korundu.`
      : 'Aktarılacak korumasız eşya bulunamadı.'
    log('BİLGİ', `[Sandık] ${message}`)
    panelMeta.chestAutomationStatus = message
    return { ok: true, movedCount, message }
  } catch (error) {
    const message = `Sandık işlemi atlandı: ${error.message}`
    log('UYARI', `[Sandık] ${message}`)
    panelMeta.chestAutomationStatus = message
    return { ok: false, status: 502, code: 'ERR_CHEST_DEPOSIT', error: message }
  } finally {
    clearTimeout(openTimeout)
    if (chest && botWindowIsOpen(session, chest)) {
      try {
        await closeChestWindow(session.bot, chest)
      } catch (error) {
        log('UYARI', `[Sandık] Arayüz kapatılamadı: ${error.message}`)
      }
    }
    session.depositQueued = false
    session.depositBusy = false
    publishBotState()
  }
}

function botWindowIsOpen (session, chest) {
  return session.bot && session.bot.currentWindow === chest
}

function panelStatus () {
  const session = current && !current.ended ? current : null
  const bot = session && session.spawned ? session.bot : null
  let status
  if (bot) status = 'Bağlı'
  else if (session || reconnectTimer) status = 'Bağlanıyor'
  else status = manuallyDisconnected ? 'Bağlantı kesildi' : 'Bağlı değil'

  const state = {
    status,
    connected: Boolean(bot),
    connectedAt: bot ? session.connectedAt : null,
    uptimeSeconds: bot ? Math.floor((Date.now() - session.connectedAt) / 1000) : 0,
    health: null,
    food: null,
    saturation: null,
    experience: null,
    position: null,
    dimension: null,
    ping: null,
    players: [],
    gameTime: null,
    hotbar: [],
    heldItem: null,
    lowHealth: false,
    lastDisconnectReason: panelMeta.lastDisconnectReason,
    lastKick: panelMeta.lastKick,
    lastErrorCode: panelMeta.lastErrorCode,
    chestAutomation: {
      enabled: cfg.chestAutomationEnabled,
      nextRunAt: session ? session.chestTimerAt : null,
      busy: Boolean(session && session.depositBusy),
      queued: Boolean(session && session.depositQueued),
      status: panelMeta.chestAutomationStatus
    },
    dailyCommand: {
      enabled: Boolean(cfg.flowEnabled || (session && session.dailyCommandAt)),
      nextRunAt: session ? session.dailyCommandAt : null
    },
    antiAfk: {
      enabled: cfg.antiAfkEnabled,
      nextRunAt: session ? session.afkTimerAt : null,
      busy: Boolean(session && session.moving)
    }
  }
  if (!bot) return state

  try {
    state.health = bot.health == null ? null : round1(bot.health)
    state.food = bot.food == null ? null : bot.food
    state.saturation = bot.foodSaturation == null ? null : bot.foodSaturation
    state.experience = bot.experience && bot.experience.level != null ? bot.experience.level : null
    state.lowHealth = state.health != null && state.health <= 6
    if (bot.entity && bot.entity.position) {
      const { x, y, z } = bot.entity.position
      state.position = { x: round1(x), y: round1(y), z: round1(z) }
    }
    state.dimension = bot.game && bot.game.dimension != null ? String(bot.game.dimension).replace(/^minecraft:/, '') : null
    state.ping = bot.player && bot.player.ping != null ? bot.player.ping : null
    state.players = Object.keys(bot.players || {}).slice(0, 300)
    if (bot.time && Number.isFinite(bot.time.timeOfDay)) state.gameTime = formatGameTime(bot.time.timeOfDay)
    const start = bot.QUICK_BAR_START || 36
    for (let index = 0; index < 9; index++) {
      const item = bot.inventory && bot.inventory.slots[start + index]
      state.hotbar.push(item ? { name: String(item.displayName || item.name), count: item.count } : null)
    }
    if (bot.heldItem) state.heldItem = { name: String(bot.heldItem.displayName || bot.heldItem.name), count: bot.heldItem.count }
  } catch (error) {
    // Durum okunamazsa panel eski bilgiyle devam eder; bot etkilenmez.
  }
  return state
}

function publishBotState (force = true) {
  const state = panelStatus()
  const json = JSON.stringify(state)
  if (!force && json === lastStateJson) return
  lastStateJson = json
  io.emit('bot_state', state)
  emitSse('state', { full: true, value: state })
}

// Panel istemcisi yokken hiçbir şey hesaplanmaz.
setInterval(() => {
  if (hasPanelClients()) publishBotState(false)
}, STATUS_INTERVAL_MS).unref()

// ───────────── Sohbet / komut gönderme ─────────────
function sendPanelChat (command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 256 || /[\r\n]/.test(command)) {
    return { ok: false, status: 400, error: 'Komut boş olamaz; en fazla 256 karakter olmalı ve satır sonu içermemelidir.' }
  }
  if (!current || current.ended || !current.spawned || !current.bot) {
    return { ok: false, status: 409, code: 'ERR_BOT_NOT_CONNECTED', error: 'Bot sunucuya bağlı değil.' }
  }
  try {
    current.bot.chat(command.trim())
    log('BİLGİ', `Panelden komut gönderildi: ${command.trim()}`)
    return { ok: true }
  } catch (error) {
    log('HATA', `Panel komutu gönderilemedi: ${error.message}`)
    return { ok: false, status: 500, error: error.message }
  }
}

function say (session, command, shownAs = command) {
  if (session.ended) return false
  try {
    session.bot.chat(command)
    log('BİLGİ', `Komut gönderildi: ${shownAs}`)
    return true
  } catch (error) {
    log('UYARI', `Komut gönderilemedi (${shownAs}): ${error.message}`)
    return false
  }
}

// Akış her an tek bir zamanlayıcıyla ilerler; yenisi kurulunca eskisi iptal edilir.
function setFlowTimer (session, delayMs, callback) {
  clearTimeout(session.flowTimer)
  session.flowTimer = setTimeout(() => {
    session.flowTimer = null
    if (!session.ended) callback()
  }, delayMs)
}

// ───────────── Komut akışı ─────────────
function beginFlow (session) {
  if (!cfg.flowEnabled) {
    session.phase = 'running'
    log('BİLGİ', '[AKIŞ] Giriş ve komut zinciri panelden kapatılmış; yalnızca anti-AFK çalışıyor.')
    return
  }
  session.phase = 'login'
  setFlowTimer(session, LOGIN_DELAY_MS, () => {
    if (cfg.loginCommand) say(session, cfg.loginCommand, '[giriş komutu]')
    else log('UYARI', 'Giriş komutu ayarlı değil (account.serverCommand); atlandı.')
    waitBeforeSkyblock(session)
  })
}

function waitBeforeSkyblock (session) {
  clearDailyCommandTimer(session)
  session.phase = 'stabilizing'
  log('BİLGİ', `[AKIŞ] ${STABILIZE_DELAY_MS / 1000} sn stabilizasyon bekleniyor; bu sürede komut gönderilmeyecek.`)
  setFlowTimer(session, STABILIZE_DELAY_MS, () => sendSkyblock(session))
}

function sendSkyblock (session) {
  session.phase = 'island-loading'
  say(session, cfg.skyblockCommand)
  log('BİLGİ', `[AKIŞ] /skyblock gönderildi; ada yüklenmesi için ${ISLAND_LOAD_DELAY_MS / 1000} sn beklenecek.`)
  setFlowTimer(session, ISLAND_LOAD_DELAY_MS, () => runAutoCommand(session))
}

function runAutoCommand (session) {
  session.phase = 'running'
  if (cfg.autoCommand) say(session, cfg.autoCommand)
  else log('BİLGİ', '[AKIŞ] Oto-komut kapalı; günlük /gunluk zamanlayıcısı yine de etkin.')
  scheduleDailyCommand(session)
}

function clearDailyCommandTimer (session) {
  clearTimeout(session.dailyCommandTimer)
  session.dailyCommandTimer = null
  session.dailyCommandAt = null
}

function scheduleDailyCommand (session) {
  clearDailyCommandTimer(session)
  if (session.ended || current !== session || !session.spawned) {
    publishBotState()
    return
  }
  session.dailyCommandAt = Date.now() + DAILY_COMMAND_INTERVAL_MS
  session.dailyCommandTimer = setTimeout(() => {
    session.dailyCommandTimer = null
    session.dailyCommandAt = null
    if (session.ended || current !== session || !session.spawned) {
      publishBotState()
      return
    }
    say(session, DAILY_COMMAND)
    scheduleDailyCommand(session)
  }, DAILY_COMMAND_INTERVAL_MS)
  session.dailyCommandTimer.unref()
  publishBotState()
}

function triggerDailyCommand () {
  const session = current
  if (!session || session.ended || !session.spawned || !session.bot) {
    return { ok: false, status: 409, code: 'ERR_BOT_NOT_CONNECTED', error: 'Bot sunucuya bağlı değil.' }
  }
  const result = sendPanelChat(DAILY_COMMAND)
  if (result.ok) scheduleDailyCommand(session)
  return result
}

// ───────────── Bağımsız anti-AFK ─────────────
// ───────────── Görev kuyruğu ve Envoy etkinliği ─────────────
// Sandık / envoy görevleri tek bir zincirde sırayla çalışır; yeme ve Anti-AFK bayrak tabanlı kilitlerle bu zincire uyar.
function enqueueTask (session, name, task) {
  const previous = session.taskChain || Promise.resolve()
  session.taskChain = previous.then(async () => {
    if (session.ended || current !== session) return null
    try {
      return await task()
    } catch (error) {
      log('UYARI', `[Kuyruk] "${name}" görevi başarısız: ${error && error.message ? error.message : error}`)
      return null
    }
  })
  return session.taskChain
}

function triggerEnvoy (session, reason, coordinates = null, manual = false) {
  if (!session || session.ended || current !== session || !session.spawned || !session.bot) {
    return { ok: false, status: 409, code: 'ERR_BOT_NOT_CONNECTED', error: 'Bot sunucuya bağlı değil.' }
  }
  if (!manual && !cfg.envoyEnabled) return { ok: false, status: 409, code: 'ERR_ENVOY_DISABLED', error: 'Envoy algılama kapalı.' }
  const target = coordinates || cfg.envoyCoordinates || cfg.chestCoordinates
  if (!target) {
    return { ok: false, status: 409, code: 'ERR_ENVOY_NO_TARGET', error: 'Envoy için hedef koordinat tanımlı değil.' }
  }
  if (session.envoyPending) {
    return { ok: false, status: 409, code: 'ERR_ENVOY_BUSY', error: 'Envoy görevi zaten sırada veya sürüyor.' }
  }
  if (!manual && Date.now() - session.envoyLastAt < ENVOY_COOLDOWN_MS) {
    return { ok: false, status: 429, code: 'ERR_ENVOY_COOLDOWN', error: 'Envoy yakın zamanda tetiklendi.' }
  }
  session.envoyPending = true
  session.envoyLastAt = Date.now()
  log('BİLGİ', `[Envoy] Tetiklendi (${reason}); hedef ${target.x}, ${target.y}, ${target.z}. Standart döngü askıya alındı.`)
  void enqueueTask(session, 'Envoy', async () => {
    session.envoyActive = true
    try {
      for (let attempt = 0; attempt < 120 && !session.ended && current === session; attempt++) {
        const result = await runChestDeposit(session, true, target)
        if (result && result.code === 'ERR_CHEST_BUSY') { await sleep(500); continue }
        log(result && result.ok ? 'BİLGİ' : 'UYARI', `[Envoy] ${result && result.ok ? 'Sandık aktarımı tamamlandı.' : `Tamamlanamadı: ${result && result.error ? result.error : 'bilinmeyen sebep'}`}`)
        break
      }
    } finally {
      session.envoyActive = false
      session.envoyPending = false
      log('BİLGİ', '[Envoy] Standart döngüye dönüldü.')
    }
  })
  return { ok: true }
}

// Duyuru satırından koordinat çıkarır: "X: 608 Y: 101 Z: 3003", "x=608 y=101 z=3003", "608, 101, 3003", "(608 101 3003)".
const ENVOY_MAX_DYNAMIC_DISTANCE = 400 // bota bu kadar bloktan uzak dinamik hedefler yok sayılır
function extractCoordinates (line) {
  const labeled = line.match(/x\s*[:=]?\s*(-?\d{1,8})[\s,;|/]+y\s*[:=]?\s*(-?\d{1,5})[\s,;|/]+z\s*[:=]?\s*(-?\d{1,8})/i)
  const plain = labeled ? null : line.match(/(?:^|[^\d.-])(-?\d{1,8})\s*[,;/ ]\s*(-?\d{1,5})\s*[,;/ ]\s*(-?\d{1,8})(?![\d.])/)
  const found = labeled || plain
  if (!found) return null
  try {
    return normalizeChestCoordinates({ x: Number(found[1]), y: Number(found[2]), z: Number(found[3]) })
  } catch {
    return null
  }
}

function dynamicEnvoyTarget (session, line) {
  const target = extractCoordinates(line)
  if (!target || !session.bot || !session.bot.entity) return null
  const position = session.bot.entity.position
  if (Math.hypot(target.x - position.x, target.z - position.z) > ENVOY_MAX_DYNAMIC_DISTANCE) {
    log('UYARI', `[Envoy] Duyurudaki koordinat (${target.x}, ${target.y}, ${target.z}) çok uzak; sabit hedefe dönülüyor.`)
    return null
  }
  return target
}

function handleEnvoyChat (session, line) {
  if (!cfg.envoyEnabled || !cfg.envoyKeywords.length || session.ended || current !== session) return
  if (/^<[^>]{1,16}>/.test(line)) return // oyuncu sohbeti etkinlik sayılmaz
  const lower = line.toLocaleLowerCase('tr-TR')
  const keyword = cfg.envoyKeywords.find(item => lower.includes(item))
  if (!keyword) return
  const dynamic = dynamicEnvoyTarget(session, line)
  if (dynamic) log('BİLGİ', `[Envoy] Duyurudan dinamik koordinat alındı: ${dynamic.x}, ${dynamic.y}, ${dynamic.z}`)
  triggerEnvoy(session, `sohbet: "${keyword}"${dynamic ? ' + dinamik koordinat' : ''}`, dynamic)
}

// ───────────── Oto yeme (auto-eat) ─────────────
function pickFood (bot) {
  const foods = bot.registry && bot.registry.foods ? bot.registry.foods : {}
  const candidates = bot.inventory.items().filter(item => foods[item.type] && !EAT_AVOID.has(item.name))
  if (!candidates.length) return null
  const rank = item => {
    const preferred = EAT_PREFERRED.indexOf(item.name)
    return preferred === -1 ? 1000 - (foods[item.type].foodPoints || 0) : preferred
  }
  candidates.sort((a, b) => rank(a) - rank(b))
  return candidates[0]
}

function needsFood (bot) {
  if (!bot || !bot.entity || bot.food == null) return false
  if (bot.food >= 20) return false // tok bot yemek yiyemez
  const lowHealth = bot.health != null && bot.health <= EAT_LOW_HEALTH
  return bot.food <= cfg.autoEatThreshold || lowHealth
}

function requestEat (session) {
  if (!cfg.autoEatEnabled || session.ended || current !== session || !session.spawned) return
  if (session.eatBusy || session.eatQueued || Date.now() < session.eatCooldownUntil) return
  if (!needsFood(session.bot)) return
  void runEat(session).catch(error => {
    log('UYARI', `[Oto-Yeme] Beklenmeyen hata: ${error && error.message ? error.message : error}`)
  })
}

async function runEat (session) {
  const bot = session.bot
  session.eatQueued = true
  const waitStart = Date.now()
  try {
    // Sıra: hareket, tıklama, sandık işlemi veya açık pencere bitene kadar kısa aralıklarla bekle.
    // Sandık sırası öncelikli olduğundan yeme onun bitmesini bekler (kilitlenme olmaz).
    while (!session.ended && current === session &&
      (session.moving || session.clickBusy || session.depositBusy || session.depositQueued || session.activeWindow)) {
      if (Date.now() - waitStart > EAT_QUEUE_WAIT_MS) {
        session.eatCooldownUntil = Date.now() + EAT_RETRY_COOLDOWN_MS
        return
      }
      await sleep(50)
    }
    if (session.ended || current !== session || !needsFood(bot)) return
    session.eatBusy = true
  } finally {
    session.eatQueued = false
  }

  let timer
  try {
    const food = pickFood(bot)
    if (!food) {
      log('UYARI', '[Oto-Yeme] Envanterde yenilebilir yiyecek yok.')
      session.eatCooldownUntil = Date.now() + 30000
      return
    }
    log('BİLGİ', `[Oto-Yeme] Yiyor: ${food.displayName || food.name} (açlık ${bot.food}/20, can ${Math.round(bot.health)}).`)
    const previousSlot = bot.quickBarSlot
    await bot.equip(food, 'hand')
    await Promise.race([
      bot.consume(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Yeme işlemi zaman aşımına uğradı.')), EAT_TIMEOUT_MS)
      })
    ])
    if (previousSlot != null && previousSlot !== bot.quickBarSlot) {
      try { bot.setQuickBarSlot(previousSlot) } catch {}
    }
    log('BİLGİ', `[Oto-Yeme] Yeme tamamlandı (açlık ${bot.food}/20).`)
  } catch (error) {
    session.eatCooldownUntil = Date.now() + EAT_RETRY_COOLDOWN_MS
    log('UYARI', `[Oto-Yeme] Yeme başarısız: ${error && error.message ? error.message : error}`)
    try { bot.deactivateItem() } catch {}
  } finally {
    clearTimeout(timer)
    session.eatBusy = false
    // Hâlâ aç ise bir sonraki yiyeceği kısa süre sonra dene.
    const retry = setTimeout(() => requestEat(session), 500)
    retry.unref()
  }
}

function startAutoEat (session) {
  session.eatTimer = setInterval(() => requestEat(session), EAT_CHECK_INTERVAL_MS)
  session.eatTimer.unref()
  session.bot.on('health', () => requestEat(session))
}

function releaseControls (session) {
  const bot = session.bot
  if (!bot) return
  for (const control of ['forward', 'back', 'left', 'right', 'jump']) {
    try { bot.setControlState(control, false) } catch {}
  }
}

async function antiAfkStep (session, manual = false) {
  const bot = session.bot
  if (session.ended || session.moving || session.depositBusy || session.depositQueued ||
    session.eatBusy || session.eatQueued || session.envoyActive || !bot.entity || (!manual && !cfg.antiAfkEnabled)) return false
  session.moving = true
  publishBotState()
  const previousPhysics = bot.physicsEnabled
  try {
    bot.physicsEnabled = true
    bot.setControlState('jump', true)
    await sleep(AFK_JUMP_MS)
    bot.setControlState('jump', false)

    bot.setControlState('forward', true)
    await sleep(AFK_WALK_MS)
    bot.setControlState('forward', false)

    bot.setControlState('back', true)
    await sleep(AFK_WALK_MS)
    bot.setControlState('back', false)

    if (!session.ended && bot.entity) await bot.look(bot.entity.yaw + 0.5, bot.entity.pitch, true)
    log('BİLGİ', '[Anti-AFK] Hareket tamamlandı.')
  } catch (error) {
    log('UYARI', `Anti-AFK hareketi tamamlanamadı: ${error.message}`)
  } finally {
    releaseControls(session)
    bot.physicsEnabled = previousPhysics
    session.moving = false
    publishBotState()
  }
  return true
}

function scheduleAntiAfk (session) {
  if (session.ended) return
  session.afkTimerAt = Date.now() + AFK_INTERVAL_MS
  session.afkTimer = setTimeout(() => {
    session.afkTimer = null
    session.afkTimerAt = null
    scheduleAntiAfk(session)
    void antiAfkStep(session)
  }, AFK_INTERVAL_MS)
  session.afkTimer.unref()
  publishBotState()
}

async function triggerAntiAfk () {
  const session = current
  if (!session || session.ended || !session.spawned || !session.bot) {
    return { ok: false, status: 409, code: 'ERR_BOT_NOT_CONNECTED', error: 'Bot sunucuya bağlı değil.' }
  }
  if (session.depositBusy || session.depositQueued) {
    return { ok: false, status: 409, code: 'ERR_CHEST_BUSY', error: 'Sandık aktarımı tamamlandıktan sonra Anti-AFK tetiklenebilir.' }
  }
  while (!session.ended && session.moving) await sleep(100)
  if (session.ended || current !== session) {
    return { ok: false, status: 409, code: 'ERR_BOT_NOT_CONNECTED', error: 'Bot hareket beklemesi sırasında bağlantıyı kaybetti.' }
  }
  const moved = await antiAfkStep(session, true)
  if (!moved) {
    return { ok: false, status: 409, code: 'ERR_AFK_UNAVAILABLE', error: 'Anti-AFK hareketi şu anda başlatılamadı.' }
  }
  scheduleAntiAfk(session)
  return { ok: true }
}

// ───────────── Bağlantı / yeniden bağlanma ─────────────
function scheduleReconnect () {
  if (shuttingDown || manuallyDisconnected || reconnectTimer) return
  if (!cfg.reconnectEnabled) {
    log('UYARI', 'Otomatik yeniden bağlanma kapalı (reconnect.enabled = false).')
    return
  }
  log('BİLGİ', `${cfg.reconnectMs / 1000} sn sonra yeniden bağlanılacak.`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    createBot()
  }, cfg.reconnectMs)
}

function teardownSession (session) {
  session.ended = true
  clearTimeout(session.flowTimer)
  clearTimeout(session.afkTimer)
  clearInterval(session.eatTimer)
  session.eatTimer = null
  clearDailyCommandTimer(session)
  clearTimeout(session.windowTimer)
  clearTimeout(session.chestTimer)
  session.chestScheduleGeneration++
  clearTimeout(session.errorTimer)
  session.chestTimer = null
  session.chestTimerAt = null
  releaseControls(session)
  session.activeWindow = null
  if (current === session) {
    current = null
    publishWindow(null)
  }
}

function endSession (session, reason, closeSocket = true) {
  if (session.ended) return
  teardownSession(session)
  if (closeSocket && session.bot) {
    try { session.bot.end() } catch {}
  }
  log('UYARI', reason)
  scheduleReconnect()
  publishBotState()
}

function stopSession (reason) {
  const session = current
  if (!session) return
  teardownSession(session)
  if (session.bot) {
    try { session.bot.quit(reason) } catch (error) {
      log('UYARI', `Bot bağlantısı kapatılamadı: ${error.message}`)
    }
  }
}

function connectPanelBot () {
  manuallyDisconnected = false
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  if (!current || current.ended) createBot()
  publishBotState()
}

function disconnectPanelBot () {
  manuallyDisconnected = true
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  stopSession('Panelden bağlantı kesildi')
  log('BİLGİ', 'Botun sunucu bağlantısı panelden kesildi.')
  publishBotState()
}

function restartPanelBot () {
  manuallyDisconnected = false
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  stopSession('Panelden yeniden başlatılıyor')
  log('BİLGİ', 'Bot panelden yeniden başlatıldı.')
  createBot()
}

// Panelden ayar kaydı: dosyaya yazar, panele yayınlar, bağlantı bilgisi değiştiyse botu yeniden bağlar.
function applyPanelConfig (incoming) {
  const previous = cfg
  cfg = persistConfig(incoming)
  const chestAutomationChanged = previous.chestAutomationEnabled !== cfg.chestAutomationEnabled ||
    previous.chestAutomationIntervalMs !== cfg.chestAutomationIntervalMs ||
    JSON.stringify(previous.chestCoordinates) !== JSON.stringify(cfg.chestCoordinates) ||
    JSON.stringify(previous.chestWhitelist) !== JSON.stringify(cfg.chestWhitelist)
  if (chestAutomationChanged && current && !current.ended) scheduleChestAutomation(current)
  if (current && !current.ended && cfg.flowEnabled && !current.dailyCommandAt && current.phase === 'running') {
    scheduleDailyCommand(current)
  }
  publishConfig()
  log('BİLGİ', 'Panel ayarları kaydedildi.')
  const changed = ['host', 'port', 'username', 'auth', 'version'].some(key => previous[key] !== cfg[key])
  if (changed && current && !current.ended) {
    log('BİLGİ', 'Bağlantı ayarları değişti; bot yeni ayarlarla yeniden bağlanıyor.')
    restartPanelBot()
  } else {
    publishBotState()
  }
  return publicConfig()
}

function createBot () {
  reconnectTimer = null
  if (shuttingDown || manuallyDisconnected) return

  log('BİLGİ', `${cfg.host}:${cfg.port} sunucusuna bağlanılıyor (${cfg.username}, Minecraft ${cfg.version}).`)

  const session = {
    bot: null,
    ended: false,
    spawned: false,
    moving: false,
    phase: 'connecting',
    connectedAt: null,
    flowTimer: null,
    dailyCommandTimer: null,
    dailyCommandAt: null,
    afkTimer: null,
    afkTimerAt: null,
    chestTimer: null,
    chestTimerAt: null,
    chestScheduleGeneration: 0,
    windowTimer: null,
    errorTimer: null,
    clickBusy: false,
    depositBusy: false,
    depositQueued: false,
    taskChain: Promise.resolve(),
    envoyActive: false,
    envoyPending: false,
    envoyLastAt: 0,
    eatBusy: false,
    eatQueued: false,
    eatCooldownUntil: 0,
    eatTimer: null,
    activeWindow: null
  }
  current = session
  publishBotState()

  let bot
  try {
    bot = mineflayer.createBot({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      auth: cfg.auth,
      version: cfg.version,
      viewDistance: 'tiny',
      profilesFolder: path.join(ROOT, 'profiles'),
      onMsaCode: data => {
        pendingMsa = { userCode: data.user_code, verificationUri: data.verification_uri }
        log('BİLGİ', `Microsoft girişi: ${data.verification_uri} kod: ${data.user_code}`)
        io.emit('msa', pendingMsa)
        emitSse('msa', pendingMsa)
      }
    })
  } catch (error) {
    log('HATA', `Bot başlatılamadı: ${error.message}`)
    notifyError(classifyError(error))
    endSession(session, 'Bot başlatılamadığı için yeniden denenecek.', false)
    return
  }
  session.bot = bot
  // Düşük CPU için fizik yalnızca anti-AFK hareketi sırasında açılır.
  bot.physicsEnabled = false

  bot.once('spawn', () => {
    if (session.ended) return
    session.spawned = true
    session.connectedAt = Date.now()
    if (pendingMsa) {
      pendingMsa = null
      io.emit('msa', null)
      emitSse('msa', null)
    }
    log('BİLGİ', 'Sunucuya girildi (spawn).')
    publishBotState()
    beginFlow(session)
    scheduleAntiAfk(session)
    scheduleChestAutomation(session)
    startAutoEat(session)
  })

  // Bot bir pencere (sandık / GUI menüsü) açtığında panele aynalanır.
  bot.on('windowOpen', window => {
    if (session.ended || current !== session) return
    session.activeWindow = window
    window.on('updateSlot', () => {
      if (session.ended || current !== session || session.activeWindow !== window) return
      queueWindowPublish(session)
    })
    publishWindow(window)
  })

  bot.on('windowClose', window => {
    if (session.ended || current !== session) return
    if (window && session.activeWindow && session.activeWindow !== window) return
    session.activeWindow = null
    clearTimeout(session.windowTimer)
    session.windowTimer = null
    publishWindow(null)
  })

  bot.on('login', () => {
    if (!session.spawned) return
    if (session.phase === 'running' && cfg.flowEnabled) {
      log('UYARI', 'Sunucu geçişi algılandı (muhtemelen lobiye alındı); akış baştan başlıyor.')
      waitBeforeSkyblock(session)
    }
  })

  bot.on('messagestr', message => {
    const line = String(message).trim()
    if (!line) return
    const match = line.match(/^<([^>]{1,16})>\s*(.*)$/)
    logToChat(match ? match[1] : '', (match ? match[2] : line).slice(0, 300))
    handleEnvoyChat(session, line)
  })

  bot.on('kicked', reason => {
    const detail = readable(reason) || 'sebep belirtilmedi'
    panelMeta.lastKick = `${new Date().toLocaleTimeString('tr-TR')} · ${detail.slice(0, 300)}`
    log('UYARI', `Sunucudan atıldı: ${detail}`)
    notifyError({ code: 'ERR_KICKED', title: 'Sunucudan atıldı', message: detail.slice(0, 300) })
  })

  bot.on('error', error => {
    log('HATA', `Bağlantı hatası: ${error && error.message ? error.message : error}`)
    notifyError(classifyError(error))
    // Hiç spawn olmadan gelen hata bağlantı başarısızlığıdır; 'end' gelmezse de yeniden dene.
    if (!session.spawned && !session.errorTimer) {
      session.errorTimer = setTimeout(() => endSession(session, 'Bağlantı kurulamadı.'), 2000)
    }
  })

  bot.on('end', reason => {
    const detail = readable(reason)
    if (!session.ended) panelMeta.lastDisconnectReason = detail || 'Bağlantı kapandı'
    endSession(session, `Bağlantı kapandı${detail ? ` (${detail})` : ''}.`, false)
  })
}

// ───────────── Panel sunucusu ─────────────
function authorizePanelRequest (request, response, next) {
  if (isLocalRequest(request.headers, request.socket.remoteAddress)) {
    next()
    return
  }
  const authorization = request.get('authorization') || ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (hasValidPanelToken(token)) {
    next()
    return
  }
  response.status(401).json({ error: 'Panel erişim anahtarı geçersiz veya eksik.' })
}

function sendResult (response, result, extra = {}) {
  if (result.ok) {
    response.json({ ok: true, ...extra })
    return
  }
  response.status(result.status || 400).json({ ok: false, error: result.error, code: result.code })
}

app.get('/events', authorizePanelRequest, (request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  if (request.socket) { request.socket.setKeepAlive(true, 15000); request.socket.setNoDelay(true); request.socket.setTimeout(0) }
  response.write('retry: 2000\n: panel bağlantısı açık\n\n')
  eventClients.add(response)
  writeSse(response, 'config', publicConfig())
  writeSse(response, 'state', { full: true, value: panelStatus() })
  writeSse(response, 'window', current && current.activeWindow ? snapshotWindow(current.activeWindow) : null)
  writeSse(response, 'logs', systemLogs)
  writeSse(response, 'chats', chatMessages)
  if (pendingMsa) writeSse(response, 'msa', pendingMsa)

  const keepAlive = setInterval(() => {
    if (!response.destroyed) response.write(': keepalive\n\n')
  }, 15000)
  response.on('close', () => {
    clearInterval(keepAlive)
    eventClients.delete(response)
  })
})

app.get('/api/config', authorizePanelRequest, (request, response) => {
  response.json(publicConfig())
})

app.get('/api/window', authorizePanelRequest, (request, response) => {
  response.json(current && current.activeWindow ? snapshotWindow(current.activeWindow) : null)
})

app.post('/api/config', authorizePanelRequest, (request, response) => {
  try {
    response.json({ ok: true, config: applyPanelConfig(request.body) })
  } catch (error) {
    log('HATA', `Panel ayarları kaydedilemedi: ${error.message}`)
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.post('/api/chat', authorizePanelRequest, (request, response) => {
  sendResult(response, sendPanelChat(request.body && request.body.text))
})

app.post('/api/click-slot', authorizePanelRequest, async (request, response) => {
  sendResult(response, await clickPanelWindow(request.body))
})

app.post('/api/trigger-deposit', authorizePanelRequest, async (request, response) => {
  const session = current
  const result = await runChestDeposit(session, true)
  sendResult(response, result, { message: result.message, movedCount: result.movedCount })
})

app.post('/api/trigger-daily-command', authorizePanelRequest, (request, response) => {
  sendResult(response, triggerDailyCommand())
})

app.post('/api/envoy/trigger', authorizePanelRequest, (request, response) => {
  let coordinates = null
  try {
    const body = obj(request.body)
    if (body.coordinates !== undefined && body.coordinates !== null) coordinates = normalizeChestCoordinates(body.coordinates)
  } catch (error) {
    sendResult(response, { ok: false, status: 400, code: 'ERR_INVALID_COORDINATES', error: error.message })
    return
  }
  sendResult(response, triggerEnvoy(current, 'panel', coordinates, true))
})

app.post('/api/trigger-anti-afk', authorizePanelRequest, async (request, response) => {
  sendResult(response, await triggerAntiAfk())
})

app.post('/api/connect', authorizePanelRequest, (request, response) => {
  connectPanelBot()
  response.json({ ok: true })
})

app.post('/api/disconnect', authorizePanelRequest, (request, response) => {
  disconnectPanelBot()
  response.json({ ok: true })
})

app.post('/api/restart_bot', authorizePanelRequest, (request, response) => {
  restartPanelBot()
  response.json({ ok: true })
})

app.use((error, request, response, next) => {
  if (response.headersSent) {
    next(error)
    return
  }
  const clientError = error.status && error.status < 500
  if (!clientError) log('HATA', `Panel HTTP isteği başarısız: ${error.message}`)
  response.status(error.status || 500).json({
    ok: false,
    error: clientError ? error.message : 'Panel isteği işlenirken hata oluştu.'
  })
})

io.use((socket, next) => {
  const { headers, address } = socket.handshake
  if (isLocalRequest(headers, address) || hasValidPanelToken(socket.handshake.auth && socket.handshake.auth.token)) {
    next()
    return
  }
  next(new Error('Panel erişim anahtarı geçersiz veya eksik.'))
})

io.on('connection', socket => {
  const reply = (acknowledge, payload) => {
    if (typeof acknowledge === 'function') acknowledge(payload)
  }
  socket.emit('init_config', publicConfig())
  socket.emit('bot_state', panelStatus())
  socket.emit('window_state', current && current.activeWindow ? snapshotWindow(current.activeWindow) : null)
  if (pendingMsa) socket.emit('msa', pendingMsa)
  for (const entry of systemLogs) socket.emit('system_log', entry)
  for (const entry of chatMessages) socket.emit('chat_message', entry)

  socket.on('send_chat', (payload, acknowledge) => {
    const command = typeof payload === 'string' ? payload : payload && (payload.cmd || payload.text)
    reply(acknowledge, sendPanelChat(command))
  })

  socket.on('update_config', (incoming, acknowledge) => {
    try {
      reply(acknowledge, { ok: true, config: applyPanelConfig(incoming) })
    } catch (error) {
      log('HATA', `Panel ayarları kaydedilemedi: ${error.message}`)
      reply(acknowledge, { ok: false, error: error.message })
    }
  })

  socket.on('connect_bot', acknowledge => {
    connectPanelBot()
    reply(acknowledge, { ok: true })
  })

  socket.on('disconnect_bot', acknowledge => {
    disconnectPanelBot()
    reply(acknowledge, { ok: true })
  })

  socket.on('restart_bot', acknowledge => {
    restartPanelBot()
    reply(acknowledge, { ok: true })
  })

  socket.on('click_window', async (payload, acknowledge) => {
    reply(acknowledge, await clickPanelWindow(payload))
  })
})

function openBrowser (url) {
  if (process.platform !== 'win32' || !rawConfig.panel || rawConfig.panel.openBrowser === false || IS_DAEMON) return
  const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.on('error', error => log('UYARI', `Web paneli tarayıcıda açılamadı: ${error.message}`))
  child.unref()
}

function startPanel () {
  if (REMOTE_ACCESS && PANEL_ACCESS_TOKEN.trim().length < 32) {
    throw new ConfigError('Uzaktan panel erişimi için PANEL_ACCESS_TOKEN en az 32 karakter olmalıdır.')
  }
  const basePort = clamp(obj(rawConfig.panel).port, 3000, 1, 65535)
  let port = basePort

  const tryListen = () => {
    const onError = error => {
      if (error.code === 'EADDRINUSE' && port < basePort + 20) {
        port++
        log('UYARI', `Panel portu dolu; ${port} deneniyor.`)
        tryListen()
        return
      }
      log('HATA', `Web paneli başlatılamadı: ${error.message}`)
    }
    server.once('error', onError)
    server.listen(port, PANEL_HOST, () => {
      server.removeListener('error', onError)
      server.on('error', error => log('HATA', `Web paneli hatası: ${error.message}`))
      const address = server.address()
      const actualPort = address && typeof address === 'object' ? address.port : port
      panelUrl = `http://${PANEL_HOST}:${actualPort}`
      log('BİLGİ', `Web paneli hazır: ${panelUrl}`)
      openBrowser(`http://127.0.0.1:${actualPort}/`)
    })
  }
  tryListen()
}

// ───────────── Kapanış ve beklenmeyen hatalar ─────────────
function shutdown () {
  if (shuttingDown) return
  shuttingDown = true
  manuallyDisconnected = true
  clearTimeout(reconnectTimer)
  if (current && current.bot) {
    try { current.bot.quit('Program kapatılıyor') } catch {}
  }
  log('BİLGİ', 'Program kapatılıyor.')
  for (const client of eventClients) { try { client.end() } catch {} }
  io.close()
  setTimeout(() => process.exit(0), 500)
}

function handleUnexpected (label, error) {
  log('HATA', `${label}: ${(error && error.stack) || error}`)
  if (current) endSession(current, 'Beklenmeyen hata nedeniyle bağlantı yenilenecek.')
}

function pauseAndExit (message) {
  console.error(message)
  if (IS_DAEMON) {
    // Arka planda Enter beklenmez; PM2 max_restarts/min_uptime ile döngüye girmesini sınırlar.
    setTimeout(() => process.exit(1), 200)
    return
  }
  console.error('\nKapatmak için Enter tuşuna basın (30 sn sonra kendiliğinden kapanır).')
  const timer = setTimeout(() => process.exit(1), 30000)
  process.stdin.once('data', () => {
    clearTimeout(timer)
    process.exit(1)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGBREAK', shutdown)
// PM2 Windows'ta sinyal yerine "shutdown" mesajı gönderir.
process.on('message', message => { if (message === 'shutdown') shutdown() })
process.on('uncaughtException', error => handleUnexpected('Beklenmeyen hata', error))
process.on('unhandledRejection', reason => handleUnexpected('İşlenmeyen Promise hatası', reason))

function main () {
  try {
    cfg = loadConfig()
    startPanel()
  } catch (error) {
    if (error instanceof ConfigError) {
      pauseAndExit(error.message)
      return
    }
    throw error
  }
  createBot()
}

main()
