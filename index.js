'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const mineflayer = require('mineflayer')

const ROOT = process.pkg ? path.dirname(process.execPath) : __dirname
const CONFIG_PATH = path.join(ROOT, 'config.json')
const PAGE_PATH = path.join(__dirname, 'public', 'index.html')
const MAX_RING = 500
const STATUS_INTERVAL_MS = 1000
const UI_BATCH_INTERVAL_MS = 250
const UI_BATCH_SIZE = 100
const MINECRAFT_VERSIONS = ['1.21.4', '1.21.1', '1.20.4', '1.20.1']
const DEFAULT_CONFIG = {
  server: { host: '', port: 25565 },
  account: { username: 'AFKBot', auth: 'offline', serverCommand: '' },
  minecraftVersion: '1.21.4',
  antiAfk: { enabled: true, minSeconds: 30, maxSeconds: 90 },
  reconnect: { enabled: true, initialSeconds: 5, maxSeconds: 300 },
  autoEat: { enabled: false, hungerThreshold: 14 },
  logLevel: 'info',
  panel: { port: 3000, openBrowser: true }
}

let config = loadConfig()
const page = fs.readFileSync(PAGE_PATH)
const logs = []
const chatLines = []
const pendingLogBatch = []
const pendingChatBatch = []
const pendingOwnChatEchoes = []
const clients = new Set()
let bot = null
let status = 'Bağlı değil'
let connectedAt = null
let lastDisconnectReason = 'Bilgi yok'
let lastKick = 'Bilgi yok'
let lastErrorCode = null
let latestMsaCode = null
let reconnectTimer = null
let afkTimer = null
let statusTimer = null
let uiBatchTimer = null
let reconnectDelayMs = config.reconnect.initialSeconds * 1000
let chatQueue = Promise.resolve()
// Elle durdurma işareti, kopma olayının otomatik yeniden bağlanmayı başlatmasını önler.
let isUserDisconnected = true
let generation = 0
let eating = false
let lastSnapshot = null
let server = null
let shuttingDown = false
const bindHost = process.env.PANEL_HOST || '127.0.0.1'
const panelAccessToken = process.env.PANEL_ACCESS_TOKEN || ''
const remoteAccessEnabled = !['127.0.0.1', 'localhost', '::1'].includes(bindHost)
const allowedOrigins = new Set([
  'capacitor://localhost',
  'http://localhost',
  'https://localhost',
  ...(process.env.PANEL_ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean)
])

const levelWeight = { error: 0, warn: 1, info: 2 }
const harmlessFood = new Set([
  'apple', 'baked_potato', 'beetroot', 'beetroot_soup', 'bread', 'carrot',
  'cooked_beef', 'cooked_chicken', 'cooked_cod', 'cooked_mutton',
  'cooked_porkchop', 'cooked_rabbit', 'cooked_salmon', 'cookie',
  'glow_berries', 'golden_apple', 'golden_carrot', 'melon_slice',
  'mushroom_stew', 'pumpkin_pie', 'rabbit_stew',
  'sweet_berries', 'dried_kelp'
])

function clampInteger (value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function normalizeConfig (value) {
  const source = value && typeof value === 'object' ? value : {}
  const serverConfig = source.server || {}
  const account = source.account || {}
  const antiAfk = source.antiAfk || {}
  const reconnect = source.reconnect || {}
  const autoEat = source.autoEat || {}
  const panel = source.panel || {}
  const minSeconds = clampInteger(antiAfk.minSeconds, 30, 5, 3600)
  const maxSeconds = clampInteger(antiAfk.maxSeconds, 90, minSeconds, 3600)
  const initialSeconds = clampInteger(reconnect.initialSeconds, 5, 1, 300)

  return {
    server: {
      host: typeof serverConfig.host === 'string' ? serverConfig.host.trim().slice(0, 255) : '',
      port: clampInteger(serverConfig.port, 25565, 1, 65535)
    },
    account: {
      username: typeof account.username === 'string' ? account.username.trim().slice(0, 16) : 'AFKBot',
      auth: account.auth === 'microsoft' ? 'microsoft' : 'offline',
      serverCommand: typeof account.serverCommand === 'string' ? account.serverCommand.slice(0, 256) : ''
    },
    minecraftVersion: MINECRAFT_VERSIONS.includes(source.minecraftVersion) ? source.minecraftVersion : '1.21.4',
    antiAfk: {
      enabled: antiAfk.enabled !== false,
      minSeconds,
      maxSeconds
    },
    reconnect: {
      enabled: reconnect.enabled !== false,
      initialSeconds,
      maxSeconds: clampInteger(reconnect.maxSeconds, 300, initialSeconds, 300)
    },
    autoEat: {
      enabled: autoEat.enabled === true,
      hungerThreshold: clampInteger(autoEat.hungerThreshold, 14, 1, 20)
    },
    logLevel: ['error', 'warn', 'info'].includes(source.logLevel) ? source.logLevel : 'info',
    panel: {
      port: clampInteger(panel.port, 3000, 1, 65535),
      openBrowser: panel.openBrowser !== false
    }
  }
}

function loadConfig () {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      const bundledConfigPath = path.join(__dirname, 'config.json')
      const initial = process.pkg && fs.existsSync(bundledConfigPath)
        ? normalizeConfig(JSON.parse(fs.readFileSync(bundledConfigPath, 'utf8')))
        : normalizeConfig(DEFAULT_CONFIG)
      fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(initial, null, 2)}\n`, 'utf8')
      return initial
    }
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')))
  } catch (error) {
    console.error(`Ayar dosyası okunamadı; varsayılan ayarlar kullanılacak: ${error.message}`)
    const initial = normalizeConfig(DEFAULT_CONFIG)
    try {
      fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(initial, null, 2)}\n`, 'utf8')
    } catch (writeError) {
      console.error(`Varsayılan ayar dosyası yazılamadı: ${writeError.message}`)
    }
    return initial
  }
}

function saveConfig () {
  // Aynı klasörde geçici dosya kullanmak atomik yeniden adlandırmayı sağlar.
  const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(temporaryPath, CONFIG_PATH)
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath)
    } catch (cleanupError) {
      console.error(`Geçici ayar dosyası temizlenemedi: ${cleanupError.message}`)
    }
    throw error
  }
}

function safeSend (response, payload) {
  if (!response.destroyed) response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function emit (type, data) {
  for (const response of clients) safeSend(response, { type, data })
}

function queueUiBatch (queue, entry) {
  if (clients.size === 0) return
  addRing(queue, entry)
  if (uiBatchTimer) return
  uiBatchTimer = setTimeout(flushUiBatches, UI_BATCH_INTERVAL_MS)
}

function emitPendingBatch (type, queue) {
  if (queue.length) emit(type, queue.splice(0, UI_BATCH_SIZE))
}

function flushUiBatches () {
  uiBatchTimer = null
  if (clients.size === 0) {
    pendingLogBatch.length = 0
    pendingChatBatch.length = 0
    return
  }
  emitPendingBatch('logsBatch', pendingLogBatch)
  emitPendingBatch('chatsBatch', pendingChatBatch)
  if (pendingLogBatch.length || pendingChatBatch.length) {
    uiBatchTimer = setTimeout(flushUiBatches, UI_BATCH_INTERVAL_MS)
  }
}

function flushBatchesBeforeClientConnect () {
  if (uiBatchTimer) clearTimeout(uiBatchTimer)
  uiBatchTimer = null
  if (clients.size === 0) {
    pendingLogBatch.length = 0
    pendingChatBatch.length = 0
    return
  }
  while (pendingLogBatch.length || pendingChatBatch.length) {
    emitPendingBatch('logsBatch', pendingLogBatch)
    emitPendingBatch('chatsBatch', pendingChatBatch)
  }
}

function addRing (ring, value) {
  // Yeni öğeden önce yer açarak tamponun her durumda 100 satırı aşmasını önle.
  while (ring.length >= MAX_RING) ring.shift()
  ring.push(value)
}

function log (level, message) {
  if (levelWeight[level] > levelWeight[config.logLevel]) return
  const entry = { time: new Date().toLocaleTimeString('tr-TR'), level, message }
  addRing(logs, entry)
  const levelName = { error: 'HATA', warn: 'UYARI', info: 'BİLGİ' }[level] || level.toUpperCase()
  console.log(`[${entry.time}] ${levelName}: ${message}`)
  queueUiBatch(pendingLogBatch, entry)
}

function stringifyReason (reason) {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object') {
    const readable = extractReadableText(reason)
    if (readable) return readable
    if (typeof reason.toAnsi === 'function') {
      try {
        const ansiText = reason.toAnsi()
        if (typeof ansiText === 'string' && ansiText) {
          return ansiText.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
        }
      } catch (error) {
        log('warn', `Hata açıklaması biçimlendirilemedi: ${error.message}`)
      }
    }
    if (typeof reason.toString === 'function' && reason.toString !== Object.prototype.toString) {
      try {
        const stringValue = reason.toString()
        if (typeof stringValue === 'string' && stringValue && stringValue !== '[object Object]') {
          return extractReadableText(stringValue)
        }
      } catch (error) {
        log('warn', `Hata açıklaması metne dönüştürülemedi: ${error.message}`)
      }
    }
    return 'Açıklama içermeyen nesne'
  }
  if (reason != null) return String(reason)
  return 'Sebep belirtilmedi'
}

function extractReadableText (value, seen = new Set()) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return extractReadableText(JSON.parse(trimmed), seen)
      } catch {}
    }
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (!value || typeof value !== 'object' || seen.has(value)) return ''
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map(item => extractReadableText(item, seen)).filter(Boolean).join('')
  }
  for (const key of ['message', 'reason', 'text', 'fallback']) {
    if (typeof value[key] === 'string' && value[key]) return value[key]
  }
  if (Array.isArray(value.extra)) return extractReadableText(value.extra, seen)
  if (Array.isArray(value.with)) return value.with.map(item => extractReadableText(item, seen)).filter(Boolean).join('')
  if (Object.hasOwn(value, 'value')) return extractReadableText(value.value, seen)
  if (typeof value.translate === 'string') return value.translate
  return Object.values(value).map(item => extractReadableText(item, seen)).filter(Boolean).join(' ')
}

// Yaygın ağ ve giriş hatalarını panelde anlamlı, sabit kodlarla göster.
function classifyConnectionError (error) {
  const code = error && typeof error.code === 'string' ? error.code.toUpperCase() : ''
  const message = stringifyReason(error).toLowerCase()
  if (['ECONNREFUSED', 'ERR_CONNECTION_REFUSED'].includes(code) || /connection refused|bağlantı reddedildi/.test(message)) {
    return { code: 'ERR_CONNECTION_REFUSED', title: 'Sunucu bağlantıyı reddetti', message: 'Sunucu kapalı olabilir veya adres/port yanlış olabilir.' }
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'ERR_NAME_NOT_RESOLVED'].includes(code) || /getaddrinfo|name or service not known|enotfound/.test(message)) {
    return { code: 'ERR_SERVER_NOT_FOUND', title: 'Sunucu adresi bulunamadı', message: 'Sunucu adresini ve internet bağlantınızı kontrol edin.' }
  }
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code) || /timed? ?out|zaman aşım/.test(message)) {
    return { code: 'ERR_CONNECTION_TIMEOUT', title: 'Bağlantı zaman aşımına uğradı', message: 'Sunucu yanıt vermedi; adresi, portu ve ağ bağlantısını kontrol edin.' }
  }
  if (/sunucu adresi ve kullanıcı adı girilmelidir/.test(message)) {
    return { code: 'ERR_CONFIGURATION', title: 'Bağlantı ayarları eksik', message: 'Sunucu adresi ve kullanıcı adını Ayarlar sekmesinden girin.' }
  }
  if (code === 'ERR_AUTH_FAILED' || /auth|authentication|login|invalid session|invalid username|verify username|failed to verify|not authenticated|unauthori[sz]ed|yetkisiz|giriş/.test(message)) {
    return { code: 'ERR_AUTH_FAILED', title: 'Kimlik doğrulama başarısız', message: 'Giriş türünü ve hesap bilgilerini kontrol edin.' }
  }
  return { code: 'ERR_CONNECTION_FAILED', title: 'Minecraft bağlantı hatası', message: stringifyReason(error) }
}

function notifyConnectionError (error, title = null) {
  const notice = classifyConnectionError(error)
  lastErrorCode = notice.code
  emit('errorNotice', {
    code: notice.code,
    title: title || notice.title,
    message: redactCommand(notice.message),
    detail: redactCommand(stringifyReason(error))
  })
}

function redactCommand (text) {
  const secret = config.account.serverCommand
  return secret ? text.split(secret).join('[gizli komut]') : text
}

function redactComponent (value) {
  if (typeof value === 'string') return redactCommand(value)
  if (Array.isArray(value)) return value.map(redactComponent)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactComponent(child)]))
}

function componentText (component) {
  if (typeof component === 'string' || typeof component === 'number') return String(component)
  if (Array.isArray(component)) return component.map(componentText).join('')
  if (!component || typeof component !== 'object') return ''
  if (Object.hasOwn(component, 'value')) return componentText(component.value)
  const ownText = typeof component.text === 'string'
    ? component.text
    : Array.isArray(component.with) ? component.with.map(componentText).join('') : ''
  const extraText = Array.isArray(component.extra)
    ? component.extra.map(componentText).join('')
    : ''
  return ownText + extraText || Object.values(component).map(componentText).join('')
}

function chatSender (component, fallbackText) {
  if (component && typeof component === 'object' && !Array.isArray(component)) {
    if (Object.hasOwn(component, 'value')) return chatSender(component.value, fallbackText)
    const translation = component.translate
    if (typeof translation === 'string' && translation.startsWith('chat.type.') && Array.isArray(component.with)) {
      const senderIndex = translation === 'chat.type.team.text' || translation === 'chat.type.team.sent' ? 1 : 0
      const sender = componentText(component.with[senderIndex]).trim()
      if (sender) return sender
    }
  }
  const match = /^<([^>]+)>\s/.exec(fallbackText)
  return match ? match[1] : null
}

function chatMessageContent (component, fallbackText) {
  if (component && typeof component === 'object' && !Array.isArray(component)) {
    if (Object.hasOwn(component, 'value')) return chatMessageContent(component.value, fallbackText)
    const translation = component.translate
    const argumentsList = component.with
    if (Array.isArray(argumentsList)) {
      if (translation === 'chat.type.text' && argumentsList.length > 1) return componentText(argumentsList[1]).trim()
      if ((translation === 'chat.type.team.text' || translation === 'chat.type.team.sent') && argumentsList.length > 2) {
        return componentText(argumentsList[2]).trim()
      }
    }
  }
  const match = /^<[^>]+>\s([\s\S]*)$/.exec(fallbackText)
  return match ? match[1].trim() : null
}

function cleanChatMessage (text) {
  return text.replace(/[§&][0-9a-fk-or]/gi, '').replace(/§/g, '')
}

function stopStatusLoop () {
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = null
}

function startStatusLoop () {
  if (statusTimer || clients.size === 0) return
  statusTimer = setTimeout(statusTick, STATUS_INTERVAL_MS)
}

function statusTick () {
  statusTimer = null
  if (clients.size === 0) return
  const current = createSnapshot()
  const changed = {}
  if (lastSnapshot === null) {
    emit('state', { full: true, value: current })
  } else {
    for (const [key, value] of Object.entries(current)) {
      if (JSON.stringify(lastSnapshot[key]) !== JSON.stringify(value)) changed[key] = value
    }
    if (Object.keys(changed).length > 0) emit('state', { full: false, value: changed })
  }
  lastSnapshot = current
  startStatusLoop()
}

function createSnapshot () {
  const active = bot
  const entity = active && active.entity
  const position = entity && entity.position
  const players = active ? Object.keys(active.players || {}).filter(name => name !== active.username).sort() : []
  const hotbar = active && active.inventory
    ? active.inventory.slots.slice(36, 45).map(item => item ? { name: item.displayName || item.name, count: item.count } : null)
    : []
  const rawTime = active && active.time ? Number(active.time.timeOfDay) : null

  return {
    status,
    connected: Boolean(active && ['Giriş yapıldı', 'Bağlı'].includes(status)),
    connectedAt,
    uptimeSeconds: connectedAt ? Math.max(0, Math.floor((Date.now() - connectedAt) / 1000)) : 0,
    health: active && Number.isFinite(active.health) ? Math.round(active.health) : null,
    food: active && Number.isFinite(active.food) ? Math.round(active.food) : null,
    saturation: active && Number.isFinite(active.foodSaturation) ? active.foodSaturation : null,
    experience: active && active.experience ? active.experience.level : null,
    position: position ? { x: round(position.x), y: round(position.y), z: round(position.z) } : null,
    dimension: active && active.game ? dimensionName(active.game.dimension) : '—',
    ping: active && active.player && Number.isFinite(active.player.ping) ? active.player.ping : null,
    players,
    gameTime: Number.isFinite(rawTime) ? formatGameTime(rawTime) : '—',
    hotbar,
    heldItem: active && active.heldItem ? { name: active.heldItem.displayName || active.heldItem.name, count: active.heldItem.count } : null,
    lastDisconnectReason,
    lastKick,
    lastErrorCode,
    lowHealth: Boolean(active && Number.isFinite(active.health) && active.health <= 6)
  }
}

function round (number) {
  return Math.round(number * 100) / 100
}

function dimensionName (dimension) {
  if (typeof dimension !== 'string') return '—'
  if (dimension.includes('nether')) return 'Nether'
  if (dimension.includes('end')) return 'End'
  return 'Üst Dünya'
}

function formatGameTime (ticks) {
  const hour = Math.floor(((ticks + 6000) % 24000) / 1000) % 24
  const minute = Math.floor((((ticks + 6000) % 1000) * 60) / 1000)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function scheduleAntiAfk (active) {
  if (afkTimer) clearTimeout(afkTimer)
  afkTimer = null
  if (!config.antiAfk.enabled || !active || active !== bot || status !== 'Bağlı') return
  const range = config.antiAfk.maxSeconds - config.antiAfk.minSeconds
  const delay = (config.antiAfk.minSeconds + Math.random() * range) * 1000
  afkTimer = setTimeout(() => {
    afkTimer = null
    if (active !== bot || status !== 'Bağlı' || !active.entity) return
    const yaw = active.entity.yaw + (Math.random() < 0.5 ? -1 : 1) * (0.08 + Math.random() * 0.12)
    const pitch = Math.max(-1.45, Math.min(1.45, active.entity.pitch + (Math.random() - 0.5) * 0.08))
    active.look(yaw, pitch, true).catch(error => log('warn', `Küçük kamera hareketi başarısız: ${error.message}`))
    scheduleAntiAfk(active)
  }, delay)
}

function sendChat (active, text, delayMs = 0, trackOwnEcho = false) {
  const queuedSend = chatQueue.then(async () => {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    if (active !== bot || !['Giriş yapıldı', 'Bağlı'].includes(status) || typeof active.chat !== 'function') {
      const error = new Error('Bot bağlı değil. Önce sunucuya bağlanın.')
      error.statusCode = 409
      error.code = 'ERR_BOT_NOT_CONNECTED'
      throw error
    }
    let pendingEcho = null
    if (trackOwnEcho) {
      const now = Date.now()
      while (pendingOwnChatEchoes.length && pendingOwnChatEchoes[0].expiresAt <= now) pendingOwnChatEchoes.shift()
      pendingEcho = { text, expiresAt: now + 10000 }
      pendingOwnChatEchoes.push(pendingEcho)
      while (pendingOwnChatEchoes.length > 100) pendingOwnChatEchoes.shift()
    }
    try {
      active.chat(text)
    } catch (error) {
      if (pendingEcho) {
        const index = pendingOwnChatEchoes.indexOf(pendingEcho)
        if (index !== -1) pendingOwnChatEchoes.splice(index, 1)
      }
      throw error
    }
  })
  chatQueue = queuedSend.then(
    () => new Promise(resolve => setTimeout(resolve, 750)),
    () => undefined
  )
  return queuedSend
}

async function tryAutoEat (active) {
  if (!config.autoEat.enabled || eating || active !== bot || status !== 'Bağlı') return
  // Ayarlanan eşik dahildir; yalnızca izin verilen yiyecek listesinden seçim yapılır.
  if (!Number.isFinite(active.food) || active.food > config.autoEat.hungerThreshold) return
  if (!active.inventory || typeof active.inventory.items !== 'function') return
  const foodItem = active.inventory.items().find(item => harmlessFood.has(item.name))
  if (!foodItem) return
  eating = true
  try {
    await active.equip(foodItem, 'hand')
    await active.consume()
  } catch (error) {
    log('warn', `Otomatik yeme başarısız: ${error.message}`)
  } finally {
    eating = false
  }
}

function clearReconnect () {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
}

function scheduleReconnect (reason) {
  if (shuttingDown || isUserDisconnected || !config.reconnect.enabled || reconnectTimer) return
  const waitMs = reconnectDelayMs
  reconnectDelayMs = Math.min(config.reconnect.maxSeconds * 1000, Math.max(waitMs * 2, 1000))
  status = 'Yeniden bağlanacak'
  log('info', `${reason}; ${Math.ceil(waitMs / 1000)} saniye sonra yeniden bağlanılacak.`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!isUserDisconnected && !shuttingDown && config.reconnect.enabled) connectBot()
  }, waitMs)
}

function connectBot () {
  clearReconnect()
  if (shuttingDown) return
  if (!config.server.host || !config.account.username) {
    status = 'Ayar gerekli'
    lastDisconnectReason = 'Sunucu adresi ve kullanıcı adı girilmelidir.'
    notifyConnectionError(new Error(lastDisconnectReason))
    log('warn', lastDisconnectReason)
    refreshStateForClients()
    return
  }
  if (bot) {
    const previous = bot
    bot = null
    try { previous.quit('Yeni bağlantı') } catch (error) { log('warn', `Önceki bağlantı kapatılamadı: ${error.message}`) }
  }
  isUserDisconnected = false
  generation++
  const thisGeneration = generation
  status = 'Bağlanıyor'
  connectedAt = null
  log('info', `${config.server.host}:${config.server.port} sunucusuna bağlanılıyor.`)
  refreshStateForClients()

  const profilesFolder = path.join(ROOT, 'profiles')
  const options = {
    host: config.server.host,
    port: config.server.port,
    username: config.account.username,
    auth: config.account.auth,
    version: config.minecraftVersion,
    viewDistance: 'tiny',
    profilesFolder,
    onMsaCode: data => {
      const deviceCode = {
        verificationUri: data.verification_uri || data.verificationUri || '',
        userCode: data.user_code || data.userCode || ''
      }
      latestMsaCode = deviceCode
      log('info', `Microsoft girişi: ${deviceCode.verificationUri} kod: ${deviceCode.userCode}`)
      emit('msa', deviceCode)
    }
  }

  try {
    if (config.account.auth === 'microsoft') fs.mkdirSync(profilesFolder, { recursive: true })
    const active = mineflayer.createBot(options)
    bot = active
    // En düşük izleme mesafesi ve kapalı yerel fizik, gereksiz dünya/konum işlerini azaltır.
    active.physicsEnabled = false
    active.on('login', () => {
      if (active !== bot || thisGeneration !== generation) return
      status = 'Giriş yapıldı'
      refreshStateForClients()
    })
    active.on('spawn', () => {
      if (active !== bot || thisGeneration !== generation) return
      status = 'Bağlı'
      connectedAt = Date.now()
      lastErrorCode = null
      reconnectDelayMs = config.reconnect.initialSeconds * 1000
      lastDisconnectReason = '—'
      log('info', 'Sunucuya bağlandı.')
      refreshStateForClients()
      scheduleAntiAfk(active)
      tryAutoEat(active).catch(error => log('warn', `Otomatik yeme kontrolü başarısız: ${error.message}`))
      const serverCommand = config.account.serverCommand.trim()
      if (serverCommand) {
        sendChat(active, serverCommand, 1500).catch(error => {
          if (error.statusCode !== 409) log('warn', `Sunucu komutu gönderilemedi: ${error.message}`)
        })
      }
    })
    active.on('health', () => {
      if (active !== bot) return
      refreshStateForClients()
      tryAutoEat(active).catch(error => log('warn', `Açlık kontrolü başarısız: ${error.message}`))
    })
    active.on('death', () => {
      if (active !== bot) return
      log('warn', 'Bot öldü; yeniden doğma deneniyor.')
      setTimeout(() => {
        if (active === bot && active.isDead) active.respawn()
      }, 1000)
    })
    active.on('kicked', reason => {
      if (active !== bot) return
      lastKick = redactCommand(stringifyReason(reason))
      lastDisconnectReason = `Sunucudan atıldı: ${lastKick}`
      notifyConnectionError(reason, 'Sunucudan bağlantı kesildi')
      log('warn', lastDisconnectReason)
      refreshStateForClients()
    })
    active.on('message', message => {
      const component = message && typeof message === 'object' && message.json
        ? redactComponent(message.json)
        : null
      const messageText = redactCommand(stringifyReason(message))
      const sender = chatSender(component, messageText)
      const isOwn = Boolean(sender && sender.toLowerCase() === active.username.toLowerCase())
      if (isOwn) {
        const content = chatMessageContent(component, messageText)
        const pendingIndex = pendingOwnChatEchoes.findIndex(item =>
          item.text === content && item.expiresAt > Date.now())
        if (pendingIndex !== -1) {
          pendingOwnChatEchoes.splice(pendingIndex, 1)
          return
        }
      }
      const line = {
        time: new Date().toLocaleTimeString('tr-TR'),
        text: messageText,
        component,
        sender,
        isOwn
      }
      addRing(chatLines, line)
      queueUiBatch(pendingChatBatch, line)
    })
    active.on('error', error => {
      if (active !== bot) return
      lastDisconnectReason = redactCommand(error.message || 'Bağlantı hatası')
      status = 'Bağlantı hatası'
      notifyConnectionError(error)
      log('warn', `Bağlantı hatası: ${lastDisconnectReason}`)
      refreshStateForClients()
    })
    active.on('end', reason => {
      if (active !== bot) return
      bot = null
      connectedAt = null
      if (afkTimer) clearTimeout(afkTimer)
      afkTimer = null
      status = 'Bağlantı kesildi'
      if (reason) lastDisconnectReason = redactCommand(stringifyReason(reason))
      log('warn', `Bağlantı kapandı${lastDisconnectReason !== '—' ? `: ${lastDisconnectReason}` : '.'}`)
      refreshStateForClients()
      scheduleReconnect('Bağlantı koptu')
    })
  } catch (error) {
    bot = null
    status = 'Bağlantı hatası'
    lastDisconnectReason = redactCommand(error.message)
    notifyConnectionError(error, 'Bot başlatılamadı')
    log('error', `Bot başlatılamadı: ${lastDisconnectReason}`)
    refreshStateForClients()
    scheduleReconnect('Bot başlatılamadı')
  }
}

function refreshStateForClients () {
  startStatusLoop()
}

function disconnectBot () {
  isUserDisconnected = true
  clearReconnect()
  if (afkTimer) clearTimeout(afkTimer)
  afkTimer = null
  connectedAt = null
  const active = bot
  if (!active) {
    status = 'Bağlantı kesildi'
    refreshStateForClients()
    log('info', 'Bot bağlantısı kapalı.')
    return
  }
  status = 'Bağlantı kesiliyor'
  lastDisconnectReason = 'Panelden bağlantı kesildi.'
  refreshStateForClients()
  try {
    active.quit('Panelden bağlantı kesildi')
  } catch (error) {
    bot = null
    status = 'Bağlantı kesildi'
    log('warn', `Bağlantı kapatılamadı: ${error.message}`)
    refreshStateForClients()
  }
}

function publicConfig () {
  return {
    server: { ...config.server },
    account: { username: config.account.username, auth: config.account.auth, hasServerCommand: Boolean(config.account.serverCommand) },
    minecraftVersion: config.minecraftVersion,
    antiAfk: { ...config.antiAfk },
    reconnect: { ...config.reconnect },
    autoEat: { ...config.autoEat },
    logLevel: config.logLevel,
    panel: { ...config.panel },
    runtime: { node: process.version, minecraft: config.minecraftVersion }
  }
}

function sendJson (response, statusCode, data) {
  const body = JSON.stringify(data)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(body)
}

function applyCorsHeaders (request, response) {
  const origin = request.headers.origin
  if (!origin) return true
  if (!allowedOrigins.has(origin)) {
    response.writeHead(403).end('Bu kaynak için erişime izin verilmiyor.')
    return false
  }
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  response.setHeader('Access-Control-Max-Age', '600')
  response.setHeader('Vary', 'Origin')
  return true
}

function isAuthorized (request) {
  if (!remoteAccessEnabled) return true
  const authorization = request.headers.authorization || ''
  const suppliedToken = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : ''
  const expected = Buffer.from(panelAccessToken)
  const supplied = Buffer.from(suppliedToken)
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)
}

function readBody (request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      body += chunk
      if (body.length > 16384) {
        reject(new Error('İstek boyutu çok büyük.'))
        request.destroy()
      }
    })
    request.on('end', () => {
      try { resolve(JSON.parse(body)) } catch { reject(new Error('Geçersiz JSON isteği.')) }
    })
    request.on('error', reject)
  })
}

function handleRequest (request, response) {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (!applyCorsHeaders(request, response)) return
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end()
    return
  }
  if (!remoteAccessEnabled) {
    const hostHeader = request.headers.host || ''
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(hostHeader) && !/^localhost(?::\d+)?$/i.test(hostHeader)) {
      response.writeHead(403).end('Yalnızca yerel erişim.')
      return
    }
  } else if (!(request.method === 'GET' && url.pathname === '/') && !isAuthorized(request)) {
    sendJson(response, 401, { error: 'Geçersiz veya eksik panel erişim anahtarı.' })
    return
  }
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': page.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' https: http:; object-src 'none'; base-uri 'none'"
    })
    response.end(page)
    return
  }
  if (request.method === 'GET' && url.pathname === '/events') {
    flushBatchesBeforeClientConnect()
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    response.write(': panel bağlantısı açık\n\n')
    clients.add(response)
    safeSend(response, { type: 'config', data: publicConfig() })
    const initialState = createSnapshot()
    if (lastSnapshot === null) lastSnapshot = initialState
    safeSend(response, { type: 'state', data: { full: true, value: initialState } })
    safeSend(response, { type: 'logs', data: logs })
    safeSend(response, { type: 'chats', data: chatLines })
    if (latestMsaCode) safeSend(response, { type: 'msa', data: latestMsaCode })
    startStatusLoop()
    response.on('close', () => {
      clients.delete(response)
      if (clients.size === 0) {
        stopStatusLoop()
        lastSnapshot = null
      }
    })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/config') {
    sendJson(response, 200, publicConfig())
    return
  }
  if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
    readBody(request).then(async body => {
      if (url.pathname === '/api/config') {
        const previousCommand = config.account.serverCommand
        const previousMinecraftVersion = config.minecraftVersion
        const previousConfig = config
        const updatedConfig = normalizeConfig(body)
        if (typeof body.account?.serverCommand === 'string' && body.account.serverCommand.trim()) {
          updatedConfig.account.serverCommand = body.account.serverCommand.trim()
        } else if (body.account?.clearServerCommand !== true) {
          updatedConfig.account.serverCommand = previousCommand
        } else if (body.account?.clearServerCommand === true) {
          updatedConfig.account.serverCommand = ''
        }
        config = updatedConfig
        try {
          saveConfig()
        } catch (error) {
          config = previousConfig
          throw error
        }
        if (!config.reconnect.enabled) clearReconnect()
        if (bot) {
          scheduleAntiAfk(bot)
          tryAutoEat(bot).catch(error => log('warn', `Otomatik yeme kontrolü başarısız: ${error.message}`))
        }
        reconnectDelayMs = config.reconnect.initialSeconds * 1000
        sendJson(response, 200, { ok: true, config: publicConfig() })
        emit('config', publicConfig())
        log('info', 'Ayarlar kaydedildi.')
        if (previousMinecraftVersion !== config.minecraftVersion && bot && !isUserDisconnected) {
          log('info', 'Minecraft sürümü değişti; yeni sürümle yeniden bağlanılıyor.')
          connectBot()
        }
        return
      }
      if (url.pathname === '/api/connect') {
        if (['Bağlanıyor', 'Giriş yapıldı', 'Bağlı', 'Bağlantı kesiliyor'].includes(status)) {
          sendJson(response, 200, { ok: true, state: status })
          return
        }
        isUserDisconnected = false
        connectBot()
        sendJson(response, 200, { ok: true })
        return
      }
      if (url.pathname === '/api/disconnect') {
        disconnectBot()
        sendJson(response, 200, { ok: true })
        return
      }
      if (url.pathname === '/api/chat') {
        const text = typeof body.text === 'string' ? cleanChatMessage(body.text).trim() : ''
        if (!text || text.length > 256) {
          sendJson(response, 400, { error: 'Mesaj 1-256 karakter olmalıdır.' })
          return
        }
        const activeBot = bot
        if (!activeBot || !['Giriş yapıldı', 'Bağlı'].includes(status) || typeof activeBot.chat !== 'function') {
          const message = 'Bot sunucuya bağlı değil. Sohbet mesajı gönderilemedi.'
          log('warn', message)
          sendJson(response, 409, { code: 'ERR_BOT_NOT_CONNECTED', error: message })
          return
        }
        await sendChat(activeBot, text, 0, true)
        const visibleText = redactCommand(text)
        const sentLine = {
          time: new Date().toLocaleTimeString('tr-TR'),
          text: `<${activeBot.username}> ${visibleText}`,
          component: { translate: 'chat.type.text', with: [{ text: activeBot.username }, { text: visibleText }] },
          sender: activeBot.username,
          isOwn: true
        }
        addRing(chatLines, sentLine)
        queueUiBatch(pendingChatBatch, sentLine)
        sendJson(response, 200, { ok: true })
        return
      }
      sendJson(response, 404, { error: 'Adres bulunamadı.' })
    }).catch(error => {
      if (url.pathname === '/api/chat') log('warn', `Sohbet mesajı gönderilemedi: ${error.message}`)
      if (!response.destroyed && !response.headersSent) {
        sendJson(response, error.statusCode || 400, { code: error.code, error: error.message })
      }
    })
    return
  }
  response.writeHead(404).end('Bulunamadı.')
}

function openBrowser () {
  if (process.platform !== 'win32' || !config.panel.openBrowser) return
  const address = `http://127.0.0.1:${config.panel.port}/`
  const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', address], { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', error => log('warn', `Tarayıcı otomatik açılamadı: ${error.message}`))
  child.unref()
}

function start () {
  if (remoteAccessEnabled && panelAccessToken.length < 32) {
    console.error('Uzaktan panel erişimi başlatılamadı: PANEL_ACCESS_TOKEN en az 32 karakter olmalıdır.')
    process.exitCode = 1
    return
  }
  if (process.platform === 'win32') {
    try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch (error) {
      log('warn', `Düşük süreç önceliği ayarlanamadı: ${error.message}`)
    }
  }
  server = http.createServer(handleRequest)
  const configuredPort = config.panel.port
  let portAttempt = 0
  let ephemeralAttempted = false
  server.on('error', error => {
    if (error.code === 'EADDRINUSE' && !ephemeralAttempted) {
      if (portAttempt < 20) {
        portAttempt++
        const fallbackPort = configuredPort + portAttempt
        if (fallbackPort <= 65535) {
          log('warn', `Panel portu ${fallbackPort - 1} kullanımda; ${fallbackPort} portu deneniyor.`)
          server.listen(fallbackPort, bindHost)
          return
        }
      }
      ephemeralAttempted = true
      log('warn', 'Panel için boş sabit port bulunamadı; işletim sisteminden boş port isteniyor.')
      server.listen(0, bindHost)
      return
    }
    log('error', `Panel sunucusu açılamadı: ${error.message}`)
    shutdown(1)
  })
  server.on('listening', () => {
    const address = server.address()
    if (address && typeof address === 'object') {
      config.panel.port = address.port
      if (address.port !== configuredPort) {
        log('warn', `Panel port çakışması giderildi. Panel ${address.port} portunda çalışıyor.`)
        emit('config', publicConfig())
      }
    }
    log('info', `Yerel kontrol paneli: http://127.0.0.1:${config.panel.port}`)
    openBrowser()
  })
  server.listen(configuredPort, bindHost)
}

function shutdown (exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  isUserDisconnected = true
  clearReconnect()
  stopStatusLoop()
  if (afkTimer) clearTimeout(afkTimer)
  if (bot) {
    const active = bot
    bot = null
    try { active.quit('Program kapatılıyor') } catch (error) { console.error(`Bot kapatılamadı: ${error.message}`) }
  }
  if (server) server.close()
  for (const client of clients) client.end()
  clients.clear()
  log('info', 'Program kapatılıyor.')
  setTimeout(() => process.exit(exitCode), 100)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('uncaughtException', error => {
  log('error', `Beklenmeyen hata: ${error.stack || error.message}`)
  if (bot) {
    const active = bot
    bot = null
    try { active.quit('Beklenmeyen hata') } catch (closeError) { console.error(`Bot bağlantısı kapatılamadı: ${closeError.message}`) }
  }
  status = 'Uygulama hatası'
  lastDisconnectReason = 'Uygulama içinde beklenmeyen hata oluştu.'
  if (!isUserDisconnected && config.reconnect.enabled) scheduleReconnect('Uygulama hatası')
  refreshStateForClients()
})
process.on('unhandledRejection', reason => {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  log('error', `İşlenmeyen Promise hatası: ${error.stack || error.message}`)
  if (bot) {
    const active = bot
    bot = null
    try { active.quit('İşlenmeyen hata') } catch (closeError) { console.error(`Bot bağlantısı kapatılamadı: ${closeError.message}`) }
  }
  status = 'Uygulama hatası'
  lastDisconnectReason = 'İşlenmeyen bir işlem hatası oluştu.'
  if (!isUserDisconnected && config.reconnect.enabled) scheduleReconnect('İşlenmeyen hata')
  refreshStateForClients()
})

start()
