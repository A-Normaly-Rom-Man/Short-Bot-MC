const byId = id => document.getElementById(id)
    const panelConnectionStorageKey = 'minecraft-bot-panel-connection'
    let panelConnection = (() => {
      try {
        const saved = JSON.parse(localStorage.getItem(panelConnectionStorageKey) || '{}')
        return {
          url: typeof saved.url === 'string' ? saved.url : (location.protocol === 'capacitor:' ? '' : location.origin),
          token: typeof saved.token === 'string' ? saved.token : ''
        }
      } catch {
        return { url: location.protocol === 'capacitor:' ? '' : location.origin, token: '' }
      }
    })()
    let socket = null
    let windowEventsController = null
    let currentState = {}
    let isBotConnected = false
    let activeWindow = null
    let activeLogFilter = 'all'
    const logEntries = []
    const logLevelNames = { error: 'HATA', warn: 'UYARI', info: 'BİLGİ' }
    const themeStorageKey = 'minecraft-bot-panel-theme'
    const backgroundStorageKey = 'minecraft-bot-panel-custom-background'
    const chatColorStorageKey = 'minecraft-bot-panel-own-chat-color'
    const chatBackgroundStorageKey = 'minecraft-bot-panel-chat-background'
    const chatFontStorageKey = 'minecraft-bot-panel-chat-font'
    const chatPaletteStorageKey = 'minecraft-bot-panel-chat-palette'
    const validThemes = new Set(['navy', 'dark', 'minecraft', 'amber', 'custom'])
    const tabNames = ['live', 'settings', 'version', 'logs']
    let configuredUsername = ''
    let selectedChatColor = 'default'
    const chatColorOptions = [
      ['default', 'Varsayılan (Normal)', ''],
      ['blue', 'Mavi', '#5555ff'],
      ['sky-blue', 'Gökyüzü mavisi', '#55ffff'],
      ['navy-blue', 'Lacivert', '#0000aa'],
      ['cyan', 'Camgöbeği', '#55ffff'],
      ['turquoise', 'Turkuaz', '#00aaaa'],
      ['teal', 'Deniz mavisi', '#00aaaa'],
      ['green', 'Yeşil', '#55ff55'],
      ['lime', 'Fıstık yeşili', '#55ff55'],
      ['mint', 'Nane yeşili', '#55ff55'],
      ['forest', 'Orman yeşili', '#00aa00'],
      ['yellow', 'Sarı', '#ffff55'],
      ['gold', 'Altın', '#ffaa00'],
      ['orange', 'Turuncu', '#ffaa00'],
      ['coral', 'Mercan', '#ff5555'],
      ['red', 'Kırmızı', '#ff5555'],
      ['crimson', 'Koyu kırmızı', '#aa0000'],
      ['pink', 'Pembe', '#ff55ff'],
      ['rose', 'Gül pembesi', '#ff55ff'],
      ['purple', 'Mor', '#aa00aa'],
      ['violet', 'Eflatun', '#aa00aa'],
      ['lavender', 'Lavanta', '#ff55ff'],
      ['white', 'Beyaz', '#ffffff'],
      ['silver', 'Gümüş', '#aaaaaa'],
      ['gray', 'Gri', '#555555']
    ]
    const chatPaletteOptions = {
      minecraft: '',
      white: '#e5e7eb',
      green: '#a7f3d0',
      blue: '#bfdbfe',
      amber: '#fcd34d'
    }
    const chatFontOptions = {
      system: 'system-ui, "Segoe UI", sans-serif',
      monospace: 'Consolas, "Courier New", monospace',
      serif: 'Georgia, "Times New Roman", serif',
      sans: 'Arial, Helvetica, sans-serif'
    }
    for (const [value, label, color] of chatColorOptions) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      if (color) option.style.color = color
      byId('chatOwnColor').append(option)
    }
    // Sekmeler fareyle ve klavyedeki ok, Home, End tuşlarıyla kullanılabilir.
    function activateTab(name, focus = false) {
      if (name === 'live') {
        byId('settingsLiveSlot').append(byId('settingsCard'))
        byId('logsLiveSlot').append(byId('logCard'))
      } else if (name === 'settings') {
        byId('settingsTabSlot').append(byId('settingsCard'))
      } else if (name === 'logs') {
        byId('logsTabSlot').append(byId('logCard'))
      }
      for (const tabName of tabNames) {
        const selected = tabName === name
        const button = byId(`tabButton-${tabName}`)
        button.setAttribute('aria-selected', String(selected))
        button.tabIndex = selected ? 0 : -1
        byId(`tab-${tabName}`).hidden = !selected
      }
      if (focus) byId(`tabButton-${name}`).focus()
    }
    for (const tabName of tabNames) {
      byId(`tabButton-${tabName}`).addEventListener('click', () => activateTab(tabName))
      byId(`tabButton-${tabName}`).addEventListener('keydown', event => {
        const index = tabNames.indexOf(tabName)
        let nextIndex = index
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabNames.length
        else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabNames.length) % tabNames.length
        else if (event.key === 'Home') nextIndex = 0
        else if (event.key === 'End') nextIndex = tabNames.length - 1
        else return
        event.preventDefault()
        activateTab(tabNames[nextIndex], true)
      })
    }
    byId('sidebarCollapse').addEventListener('click', event => {
      const button = event.currentTarget
      const collapsed = document.body.classList.toggle('sidebar-collapsed')
      button.setAttribute('aria-expanded', String(!collapsed))
      button.setAttribute('aria-label', collapsed ? 'Yan menüyü genişlet' : 'Yan menüyü daralt')
      button.title = collapsed ? 'Yan menüyü genişlet' : 'Yan menüyü daralt'
      button.textContent = collapsed ? '›' : '‹'
    })
    document.querySelectorAll('[data-sidebar-target]').forEach(button => {
      button.addEventListener('click', () => {
        const targetId = button.dataset.sidebarTarget
        if (targetId === 'developerOptions') {
          activateTab('settings')
          setDeveloperOptionsVisible(true)
        } else {
          activateTab('live')
        }
        document.querySelectorAll('[data-sidebar-target]').forEach(item => {
          if (item === button) item.setAttribute('aria-current', 'page')
          else item.removeAttribute('aria-current')
        })
        requestAnimationFrame(() => {
          byId(targetId).scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
      })
    })
    function readThemeStorage(key) {
      try { return localStorage.getItem(key) } catch (error) {
        console.warn('Tema tercihi bu tarayıcıda okunamadı:', error)
        return null
      }
    }
    function saveThemeStorage(key, value) {
      try { localStorage.setItem(key, value) } catch (error) {
        console.warn('Tema tercihi bu tarayıcıya kaydedilemedi:', error)
      }
    }
    function resolveCustomBackground(value) {
      const color = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i
      if (color.test(value)) return { type: 'color', value }
      try {
        const url = new URL(value)
        if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
          return { type: 'url', value: url.href }
        }
      } catch {}
      return null
    }
    function applyTheme(theme, backgroundValue, persist = false) {
      if (!validThemes.has(theme)) theme = 'navy'
      document.body.dataset.theme = theme
      document.documentElement.style.removeProperty('--page-image')
      document.documentElement.style.removeProperty('--bg')
      const message = byId('themeMessage')
      if (theme === 'custom') {
        const background = resolveCustomBackground(backgroundValue || '')
        if (!background) {
          message.textContent = 'Geçerli bir # renk kodu veya HTTP(S) adresi girin.'
          message.setAttribute('role', 'alert')
          return false
        }
        if (background.type === 'color') {
          document.documentElement.style.setProperty('--bg', background.value)
        } else {
          document.documentElement.style.setProperty('--page-image', `linear-gradient(#07111f99, #07111f99), url(${JSON.stringify(background.value)})`)
        }
        byId('customBackground').value = backgroundValue
        message.textContent = 'Özel arka plan uygulandı.'
      } else {
        message.textContent = 'Tema tercihiniz bu tarayıcıda saklanır.'
      }
      message.removeAttribute('role')
      byId('themeSelect').value = theme
      byId('customThemeFields').hidden = theme !== 'custom'
      if (persist) {
        saveThemeStorage(themeStorageKey, theme)
        if (theme === 'custom') saveThemeStorage(backgroundStorageKey, backgroundValue)
      }
      return true
    }
    function loadTheme() {
      const savedTheme = readThemeStorage(themeStorageKey) || 'navy'
      const savedBackground = readThemeStorage(backgroundStorageKey) || ''
      if (!applyTheme(savedTheme, savedBackground)) applyTheme('navy', '')
    }
    loadTheme()
    function applyChatColor(value, persist = false) {
      selectedChatColor = chatColorOptions.some(([key]) => key === value) ? value : 'default'
      const [, , color] = chatColorOptions.find(([key]) => key === selectedChatColor)
      if (color) document.documentElement.style.setProperty('--chat-own-color', color)
      else document.documentElement.style.removeProperty('--chat-own-color')
      byId('chatOwnColor').value = selectedChatColor
      for (const line of byId('chatOutput').querySelectorAll('.chat-own')) {
        line.classList.toggle('chat-custom-color', selectedChatColor !== 'default')
      }
      if (persist) saveThemeStorage(chatColorStorageKey, selectedChatColor)
    }
    applyChatColor(readThemeStorage(chatColorStorageKey) || 'default')
    byId('chatOwnColor').addEventListener('change', event => applyChatColor(event.target.value, true))
    function applyChatAppearance({ background, font, palette } = {}, persist = false) {
      const safeBackground = /^#[\da-f]{6}$/i.test(background || '') ? background : '#11111b'
      const safeFont = Object.hasOwn(chatFontOptions, font) ? font : 'monospace'
      const safePalette = Object.hasOwn(chatPaletteOptions, palette) ? palette : 'minecraft'
      document.documentElement.style.setProperty('--chat-output-bg', safeBackground)
      document.documentElement.style.setProperty('--chat-font', chatFontOptions[safeFont])
      if (chatPaletteOptions[safePalette]) {
        document.documentElement.style.setProperty('--chat-palette-color', chatPaletteOptions[safePalette])
        byId('chatOutput').classList.add('chat-palette-custom')
      } else {
        document.documentElement.style.removeProperty('--chat-palette-color')
        byId('chatOutput').classList.remove('chat-palette-custom')
      }
      byId('chatBackgroundColor').value = safeBackground
      byId('chatFont').value = safeFont
      byId('chatPalette').value = safePalette
      if (persist) {
        saveThemeStorage(chatBackgroundStorageKey, safeBackground)
        saveThemeStorage(chatFontStorageKey, safeFont)
        saveThemeStorage(chatPaletteStorageKey, safePalette)
      }
    }
    applyChatAppearance({
      background: readThemeStorage(chatBackgroundStorageKey),
      font: readThemeStorage(chatFontStorageKey),
      palette: readThemeStorage(chatPaletteStorageKey)
    })
    for (const id of ['chatBackgroundColor', 'chatFont', 'chatPalette']) {
      byId(id).addEventListener('change', () => {
        applyChatAppearance({
          background: byId('chatBackgroundColor').value,
          font: byId('chatFont').value,
          palette: byId('chatPalette').value
        }, true)
      })
    }
    byId('themeSelect').addEventListener('change', event => {
      const theme = event.target.value
      if (theme === 'custom') {
        byId('customThemeFields').hidden = false
        byId('customBackground').focus()
        return
      }
      applyTheme(theme, '', true)
    })
    byId('applyCustomTheme').addEventListener('click', () => {
      applyTheme('custom', byId('customBackground').value.trim(), true)
    })
    function displayValue(value, fallback = '—') {
      if (value == null || value === '') return fallback
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { return displayValue(JSON.parse(trimmed), fallback) } catch {}
        }
        return value
      }
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      if (typeof value === 'object') {
        for (const key of ['message', 'reason', 'text', 'translate', 'fallback']) {
          if (typeof value[key] === 'string' && value[key]) return value[key]
        }
        if (Object.hasOwn(value, 'value')) return displayValue(value.value, fallback)
        if (Array.isArray(value.extra)) return displayValue(value.extra, fallback)
        if (Array.isArray(value.with)) return value.with.map(item => displayValue(item, '')).filter(Boolean).join('')
        const children = Object.values(value).map(item => displayValue(item, '')).filter(Boolean)
        return children.length ? children.join(' ') : fallback
      }
      return String(value)
    }
    function text(id, value) { byId(id).textContent = displayValue(value) }
    function dismissToast(toast) {
      if (!toast.isConnected || toast.classList.contains('is-leaving')) return
      toast.classList.add('is-leaving')
      setTimeout(() => toast.remove(), 260)
    }
    function showToast(notice) {
      const toast = document.createElement('section')
      toast.className = 'toast'
      toast.setAttribute('role', 'alert')
      const heading = document.createElement('strong')
      heading.textContent = displayValue(notice && notice.title, 'Bağlantı hatası')
      const code = document.createElement('code')
      code.textContent = displayValue(notice && notice.code, 'ERR_CONNECTION_FAILED')
      const message = document.createElement('p')
      message.textContent = displayValue(notice && (notice.message || notice.reason || notice), 'Bağlantı sırasında beklenmeyen bir hata oluştu.')
      const close = document.createElement('button')
      close.className = 'toast-close'
      close.type = 'button'
      close.setAttribute('aria-label', 'Bildirimi kapat')
      close.textContent = '×'
      close.addEventListener('click', () => dismissToast(toast))
      toast.append(heading, code, message, close)
      byId('toastStack').append(toast)
      while (byId('toastStack').children.length > 4) dismissToast(byId('toastStack').firstElementChild)
      setTimeout(() => dismissToast(toast), 5000)
    }
    function createStatIcons(id, type) {
      const row = byId(id)
      const path = type === 'heart'
        ? 'M2 1h4v2h4V1h4v2h2v5h-2v2h-2v2h-2v2H6v-2H4v-2H2V8H0V3h2z'
        : 'M3 1h4v2h3v2h2v2h2v2h2v4h-2v2h-4v-2H7v-2H5V9H3V7H1V3h2z'
      for (let index = 0; index < 10; index++) {
        const icon = document.createElement('span')
        icon.className = `pixel-icon ${type}`
        icon.setAttribute('aria-hidden', 'true')
        icon.innerHTML = `<svg class="icon-empty" viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"></path></svg><span class="icon-fill"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"></path></svg></span>`
        row.append(icon)
      }
    }
    createStatIcons('healthIcons', 'heart')
    createStatIcons('foodIcons', 'food')
    function updateStatIcons(id, value, label) {
      const row = byId(id)
      const amount = value != null && value !== '' && Number.isFinite(Number(value))
        ? Math.max(0, Math.min(20, Number(value)))
        : null
      row.setAttribute('aria-label', amount == null ? `${label} bilgisi yok` : `${label}: ${amount} / 20`)
      Array.from(row.children).forEach((icon, index) => {
        const filled = amount == null ? 0 : Math.max(0, Math.min(1, (amount - index * 2) / 2))
        icon.querySelector('.icon-fill').style.clipPath = `inset(0 ${(1 - filled) * 100}% 0 0)`
      })
    }
    function setItems(id, items, emptyText) {
      const list = byId(id)
      list.replaceChildren()
      if (!items || items.length === 0) {
        const li = document.createElement('li'); li.className = 'muted'; li.textContent = emptyText; list.append(li); return
      }
      for (const value of items) {
        const li = document.createElement('li'); li.textContent = displayValue(value); list.append(li)
      }
    }
    const minecraftColors = {
      '0': '#000000', '1': '#0000aa', '2': '#00aa00', '3': '#00aaaa',
      '4': '#aa0000', '5': '#aa00aa', '6': '#ffaa00', '7': '#aaaaaa',
      '8': '#555555', '9': '#5555ff', a: '#55ff55', b: '#55ffff',
      c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff'
    }
    const translatedChatFormats = {
      'chat.type.text': ['<', 0, '> ', 1],
      'chat.type.announcement': [0, ': ', 1],
      'chat.type.emote': ['* ', 0, ' ', 1],
      'chat.type.team.text': ['[', 0, '] <', 1, '> ', 2],
      'chat.type.team.sent': ['[', 0, '] <', 1, '> ', 2]
    }
    function safeMinecraftColor(value) {
      if (typeof value !== 'string') return null
      const normalized = value.toLowerCase()
      if (minecraftColors[normalized]) return minecraftColors[normalized]
      const namedColors = {
        black: '#000000', dark_blue: '#0000aa', dark_green: '#00aa00',
        dark_aqua: '#00aaaa', dark_red: '#aa0000', dark_purple: '#aa00aa',
        gold: '#ffaa00', gray: '#aaaaaa', dark_gray: '#555555', blue: '#5555ff',
        green: '#55ff55', aqua: '#55ffff', red: '#ff5555',
        light_purple: '#ff55ff', yellow: '#ffff55', white: '#ffffff'
      }
      if (namedColors[normalized]) return namedColors[normalized]
      return /^#[\da-f]{6}$/i.test(value) ? value : null
    }
    function appendStyledText(parent, value, style) {
      if (!value) return
      const span = document.createElement('span')
      if (style.color) span.style.color = style.color
      if (style.bold) span.style.fontWeight = '700'
      if (style.italic) span.style.fontStyle = 'italic'
      const decorations = []
      if (style.underlined) decorations.push('underline')
      if (style.strikethrough) decorations.push('line-through')
      if (decorations.length) span.style.textDecoration = decorations.join(' ')
      span.textContent = value
      parent.append(span)
    }
    function renderLegacyText(parent, value, inheritedStyle) {
      const pattern = /[§&]([0-9a-fk-or])/gi
      const style = { ...inheritedStyle }
      let cursor = 0
      let match
      while ((match = pattern.exec(value)) !== null) {
        appendStyledText(parent, value.slice(cursor, match.index), style)
        const code = match[1].toLowerCase()
        if (minecraftColors[code]) {
          style.color = minecraftColors[code]
          style.bold = false
          style.italic = false
          style.underlined = false
          style.strikethrough = false
        } else if (code === 'r') {
          for (const property of Object.keys(style)) delete style[property]
          Object.assign(style, inheritedStyle)
        } else if (code === 'l') style.bold = true
        else if (code === 'o') style.italic = true
        else if (code === 'n') style.underlined = true
        else if (code === 'm') style.strikethrough = true
        cursor = pattern.lastIndex
      }
      appendStyledText(parent, value.slice(cursor), style)
    }
    function renderMinecraftComponent(parent, component, inheritedStyle = {}, ownMessageColor = '') {
      if (typeof component === 'string' || typeof component === 'number') {
        const value = String(component)
        if (ownMessageColor) {
          const match = /^(<[^>]+>\s)([\s\S]*)$/.exec(value)
          if (match) renderLegacyText(parent, match[1], inheritedStyle)
          const messagePart = document.createElement('span')
          messagePart.className = 'chat-message-text'
          renderLegacyText(messagePart, match ? match[2] : value, { ...inheritedStyle, color: ownMessageColor })
          parent.append(messagePart)
        } else {
          renderLegacyText(parent, value, inheritedStyle)
        }
        return
      }
      if (Array.isArray(component)) {
        for (const child of component) renderMinecraftComponent(parent, child, inheritedStyle, ownMessageColor)
        return
      }
      if (!component || typeof component !== 'object') return
      if (Object.hasOwn(component, 'value') && typeof component.type === 'string') {
        renderMinecraftComponent(parent, component.value, inheritedStyle, ownMessageColor)
        return
      }
      const style = { ...inheritedStyle }
      const color = safeMinecraftColor(component.color)
      if (color) style.color = color
      for (const property of ['bold', 'italic', 'underlined', 'strikethrough']) {
        if (typeof component[property] === 'boolean') style[property] = component[property]
      }
      if (typeof component.text === 'string') {
        renderLegacyText(parent, component.text, style)
      } else if (typeof component.translate === 'string') {
        const args = Array.isArray(component.with) ? component.with : []
        const format = translatedChatFormats[component.translate]
        if (format) {
          for (const part of format) {
            if (typeof part === 'number') {
              const isMessagePart = (component.translate === 'chat.type.team.text' || component.translate === 'chat.type.team.sent')
                ? part === 2
                : part === 1
              const argumentStyle = isMessagePart && ownMessageColor ? { ...style, color: ownMessageColor } : style
              const messagePart = isMessagePart && ownMessageColor
              const target = messagePart ? document.createElement('span') : parent
              if (messagePart) target.className = 'chat-message-text'
              renderMinecraftComponent(target, args[part], argumentStyle)
              if (messagePart) parent.append(target)
            }
            else renderLegacyText(parent, part, style)
          }
        } else if (typeof component.fallback === 'string') {
          if (ownMessageColor) {
            const messagePart = document.createElement('span')
            messagePart.className = 'chat-message-text'
            renderLegacyText(messagePart, component.fallback, { ...style, color: ownMessageColor })
            parent.append(messagePart)
          } else {
            renderLegacyText(parent, component.fallback, style)
          }
        } else {
          if (args.length === 0) renderLegacyText(parent, component.translate, style)
          args.forEach((argument, index) => {
            if (index > 0) renderLegacyText(parent, ' ', style)
            renderMinecraftComponent(parent, argument, style, ownMessageColor)
          })
        }
      } else if (typeof component.selector === 'string') {
        renderLegacyText(parent, component.selector, ownMessageColor ? { ...style, color: ownMessageColor } : style)
      } else if (component.score && typeof component.score.value === 'string') {
        renderLegacyText(parent, component.score.value, ownMessageColor ? { ...style, color: ownMessageColor } : style)
      } else {
        for (const value of Object.values(component)) {
          renderMinecraftComponent(parent, value, style, ownMessageColor)
        }
      }
      if (Array.isArray(component.extra)) {
        for (const child of component.extra) renderMinecraftComponent(parent, child, style, ownMessageColor)
      }
    }
    function showChatOutput(entry, shouldScroll = true) {
      const line = document.createElement('div')
      const time = document.createElement('span')
      time.className = 'muted'
      time.textContent = `[${displayValue(entry.time, '')}] `
      line.append(time)
      const content = document.createElement('span')
      content.className = 'chat-content'
      let component = entry.component
      if (typeof component === 'string') {
        try {
          const parsed = JSON.parse(component)
          if (parsed && typeof parsed === 'object') component = parsed
        } catch {}
      }
      if (!component && typeof entry.text === 'string') {
        try {
          const parsed = JSON.parse(entry.text)
          if (parsed && typeof parsed === 'object') component = parsed
        } catch {}
      }
      const sender = typeof entry.sender === 'string' ? entry.sender : ''
      const isOwnMessage = entry.isOwn === true || Boolean(configuredUsername && sender.toLowerCase() === configuredUsername.toLowerCase())
      const [, , ownColor] = chatColorOptions.find(([key]) => key === selectedChatColor)
      renderMinecraftComponent(content, component || entry.text || '', {}, isOwnMessage ? ownColor : '')
      line.classList.toggle('chat-own', isOwnMessage)
      line.classList.toggle('chat-custom-color', isOwnMessage && selectedChatColor !== 'default')
      line.append(content)
      const output = byId('chatOutput')
      output.append(line)
      while (output.children.length > 100) output.firstElementChild.remove()
      if (shouldScroll) output.scrollTop = output.scrollHeight
    }
    function showOutput(id, entry, prefix, shouldScroll = true, category = '') {
      const line = document.createElement('div')
      const level = category || (typeof entry.level === 'string' ? entry.level.toLowerCase() : '')
      if (level) line.classList.add(`log-${level}`)
      const outputText = displayValue(entry.text ?? entry.message ?? entry)
      if (outputText.includes('[TEST ')) line.classList.add('log-test')
      line.textContent = `[${displayValue(entry.time, '')}] ${prefix}${outputText}`
      const output = byId(id); output.append(line)
      while (output.children.length > 500) output.firstElementChild.remove()
      if (shouldScroll) output.scrollTop = output.scrollHeight
    }
    function appendLogEntry(entry, category) {
      logEntries.push({ entry, category })
      if (logEntries.length > 500) logEntries.shift()
      if (activeLogFilter === 'all' || activeLogFilter === category) {
        const prefix = category === 'chat'
          ? 'SOHBET: '
          : `${logLevelNames[category] || category.toUpperCase()}: `
        showOutput('logOutput', entry, prefix, true, category)
      }
    }
    function renderFilteredLogs() {
      const output = byId('logOutput')
      output.replaceChildren()
      for (const { entry, category } of logEntries) {
        if (activeLogFilter !== 'all' && activeLogFilter !== category) continue
        const prefix = category === 'chat'
          ? 'SOHBET: '
          : `${logLevelNames[category] || category.toUpperCase()}: `
        showOutput('logOutput', entry, prefix, false, category)
      }
      output.scrollTop = output.scrollHeight
      document.querySelectorAll('[data-log-filter]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.logFilter === activeLogFilter))
      })
    }
    document.querySelectorAll('[data-log-filter]').forEach(button => {
      button.addEventListener('click', () => {
        activeLogFilter = button.dataset.logFilter
        renderFilteredLogs()
      })
    })
    function duration(seconds) {
      const n = Math.max(0, Number(seconds) || 0)
      return [Math.floor(n / 3600), Math.floor((n % 3600) / 60), n % 60].map(x => String(x).padStart(2, '0')).join(':')
    }
    function updateChatControls() {
      byId('chatInput').disabled = false
      byId('chatSend').disabled = false
    }
    function updateChestAutomation(state = {}) {
      const nextRunAt = Number(state.nextRunAt)
      const secondsRemaining = Number.isFinite(nextRunAt) && nextRunAt > 0
        ? Math.max(0, Math.ceil((nextRunAt - Date.now()) / 1000))
        : null
      const countdown = state.busy
        ? 'Aktarım sürüyor…'
        : state.queued
          ? 'Hareket/pencere bekleniyor…'
        : !state.enabled
          ? 'Döngü kapalı'
          : !isBotConnected
            ? 'Bot bağlantısı bekleniyor'
            : secondsRemaining == null
              ? 'Sonraki çalışma hazırlanıyor…'
              : `Sonraki çalışma: ${duration(secondsRemaining)}`
      text('chestAutomationCountdown', countdown)
      text('chestAutomationMessage', state.status || 'Sandık otomasyonu hazır.')
      byId('triggerChestDeposit').disabled = !isBotConnected || Boolean(state.busy || state.queued)
      byId('inventoryGrid').querySelectorAll('button[data-slot]').forEach(button => {
        button.disabled = Boolean(state.busy)
      })
    }
    function updateDailyCommand(state = {}) {
      const nextRunAt = Number(state.nextRunAt)
      const secondsRemaining = Number.isFinite(nextRunAt) && nextRunAt > 0
        ? Math.max(0, Math.ceil((nextRunAt - Date.now()) / 1000))
        : null
      const countdown = !state.enabled
        ? 'Otomatik komut kapalı'
        : !isBotConnected
          ? 'Bot bağlantısı bekleniyor'
          : secondsRemaining == null
            ? 'Zamanlayıcı hazırlanıyor…'
            : `Sonraki komut: ${duration(secondsRemaining)}`
      text('dailyCommandCountdown', countdown)
      byId('triggerDailyCommand').disabled = !isBotConnected
    }
    function updateAntiAfk(state = {}) {
      const nextRunAt = Number(state.nextRunAt)
      const secondsRemaining = Number.isFinite(nextRunAt) && nextRunAt > 0
        ? Math.max(0, Math.ceil((nextRunAt - Date.now()) / 1000))
        : null
      const countdown = state.busy
        ? 'Hareket ediliyor…'
        : !isBotConnected
          ? 'Bot bağlantısı bekleniyor'
          : !state.enabled
            ? 'Otomatik Anti-AFK kapalı'
            : secondsRemaining == null
              ? 'Zamanlayıcı hazırlanıyor…'
              : `Sonraki hareket: ${duration(secondsRemaining)}`
      text('antiAfkCountdown', countdown)
      byId('triggerAntiAfk').disabled = !isBotConnected || Boolean(state.busy)
    }
    function updateState(incoming) {
      currentState = { ...currentState, ...incoming }
      const s = currentState
      isBotConnected = typeof s.connected === 'boolean'
        ? s.connected
        : ['Giriş yapıldı', 'Bağlı'].includes(s.status)
      text('status', s.status || 'Bilinmiyor')
      byId('statusDot').className = 'dot ' + (s.status === 'Bağlı' ? 'connected' : (s.status || '').includes('kesildi') ? 'disconnected' : '')
      const connectionInProgress = ['Bağlanıyor', 'Giriş yapıldı', 'Bağlı', 'Bağlantı kesiliyor'].includes(s.status)
      byId('connect').hidden = connectionInProgress
      byId('disconnect').hidden = !connectionInProgress
      updateChatControls()
      updateDailyCommand(s.dailyCommand)
      updateAntiAfk(s.antiAfk)
      const roundedHealth = s.health == null ? null : Math.round(Number(s.health))
      text('health', roundedHealth == null ? '—' : `${roundedHealth} / 20`)
      const roundedFood = s.food == null ? null : Math.round(Number(s.food))
      text('food', roundedFood == null ? '—' : `${roundedFood} / 20`)
      updateStatIcons('healthIcons', roundedHealth, 'Can')
      updateStatIcons('foodIcons', roundedFood, 'Açlık')
      text('saturation', s.saturation == null ? '—' : Number(s.saturation).toFixed(1))
      text('experience', s.experience)
      text('position', s.position ? `${s.position.x}, ${s.position.y}, ${s.position.z}` : '—')
      text('dimension', s.dimension)
      text('ping', s.ping == null ? '—' : `${s.ping} ms`)
      text('uptime', duration(s.uptimeSeconds))
      text('gameTime', s.gameTime)
      text('playerCount', (s.players || []).length)
      text('heldItem', s.heldItem ? `${s.heldItem.name} ×${s.heldItem.count}` : '—')
      text('disconnectReason', s.lastDisconnectReason)
      text('lastErrorCode', s.lastErrorCode)
      byId('healthWarning').classList.toggle('show', Boolean(s.lowHealth))
      updateChestAutomation(s.chestAutomation)
      setItems('players', s.players || [], 'Oyuncu bulunmuyor.')
      setItems('hotbar', (s.hotbar || []).map((item, index) => `${index + 1}: ${item ? `${item.name} ×${item.count}` : 'Boş'}`), 'Eşya bilgisi yok.')
      if (s.lastKick && s.lastKick !== 'Veri yok' && s.lastKick !== '—') text('lastKick', s.lastKick)
    }
    setInterval(() => {
      updateChestAutomation(currentState.chestAutomation)
      updateDailyCommand(currentState.dailyCommand)
      updateAntiAfk(currentState.antiAfk)
    }, 1000)
    function itemTextureUrl(name, category = 'items') {
      const itemName = String(name || '').toLowerCase().replace(/^minecraft:/, '')
      if (!/^[a-z0-9_]+$/.test(itemName)) return null
      return `https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master/data/1.21.4/${category}/${itemName}.png`
    }
    function createSlotButton(item, slot) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'inventory-slot'
      button.dataset.slot = String(slot)
      button.setAttribute('role', 'gridcell')
      if (!item) {
        button.classList.add('empty')
        button.setAttribute('aria-label', `Slot ${slot}, boş`)
        button.title = `Slot ${slot}, boş`
        return button
      }
      const name = String(item.displayName || item.name || 'Bilinmeyen eşya')
      button.dataset.searchText = `${name} ${item.name || ''} ${item.id ?? ''}`.toLocaleLowerCase('tr-TR')
      const id = String(item.id)
      const lore = Array.isArray(item.lore) ? item.lore : []
      button.setAttribute('aria-label', `Slot ${slot}, ${name}, miktar ${item.count}`)
      button.title = [`${name} (${item.name || 'unknown'}, ID: ${id}) ×${item.count}`, ...lore].join('\n')
      const iconUrl = itemTextureUrl(item.name)
      if (iconUrl) {
        const icon = document.createElement('img')
        icon.className = 'inventory-slot-icon'
        icon.alt = ''
        icon.draggable = false
        icon.loading = 'lazy'
        icon.decoding = 'async'
        icon.dataset.textureCategory = 'items'
        icon.addEventListener('error', () => {
          if (icon.dataset.textureCategory === 'items') {
            icon.dataset.textureCategory = 'blocks'
            icon.src = itemTextureUrl(item.name, 'blocks')
          } else {
            icon.remove()
          }
        })
        icon.src = iconUrl
        button.append(icon)
      }
      const itemName = document.createElement('span')
      itemName.className = 'inventory-slot-name'
      itemName.textContent = name
      button.append(itemName)
      if (Number.isInteger(item.count) && item.count > 0) {
        const count = document.createElement('span')
        count.className = 'inventory-slot-count'
        count.textContent = String(item.count)
        button.append(count)
      }
      return button
    }
    function createSlotSection(title, slots, from, to, columns, extraClass) {
      const section = document.createElement('div')
      if (title) {
        const heading = document.createElement('h3')
        heading.className = 'inventory-section-title'
        heading.textContent = title
        section.append(heading)
      }
      const gridElement = document.createElement('div')
      gridElement.className = `inventory-grid${extraClass ? ` ${extraClass}` : ''}`
      gridElement.style.setProperty('--cols', String(columns))
      for (let slot = from; slot < to; slot++) gridElement.append(createSlotButton(slots[slot], slot))
      section.append(gridElement)
      return section
    }
    function applyInventorySearch() {
      const query = byId('inventorySearch').value.trim().toLocaleLowerCase('tr-TR')
      const slots = Array.from(byId('inventoryGrid').querySelectorAll('button[data-slot]'))
      let visibleItems = 0
      for (const slot of slots) {
        const matches = !query || Boolean(slot.dataset.searchText && slot.dataset.searchText.includes(query))
        slot.hidden = !matches
        if (matches && slot.dataset.searchText) visibleItems++
      }
      text('inventorySearchStatus', query
        ? `${visibleItems} eşleşen eşya bulundu.`
        : '')
    }
    function renderWindow(windowState) {
      activeWindow = windowState && Array.isArray(windowState.slots) ? windowState : null
      const grid = byId('inventoryGrid')
      grid.replaceChildren()
      if (!activeWindow) {
        text('inventoryTitle', 'Minecraft envanteri / sandık')
        text('inventoryStatus', 'Bot bir pencere açtığında slotlar burada görüntülenir.')
        applyInventorySearch()
        return
      }

      const total = activeWindow.slots.length
      const start = Math.min(Math.max(Number(activeWindow.inventoryStart) || 0, 0), total)
      const columns = Math.min(Math.max(Number(activeWindow.columns) || 9, 1), 9)
      text('inventoryTitle', activeWindow.title || 'Minecraft penceresi')
      text('inventoryStatus', `${activeWindow.type || 'Pencere'} · ${start} pencere slotu + ${total - start} envanter slotu · Slota tıklayarak oyundaki pencereyi kullanın.`)

      const container = document.createElement('div')
      container.className = 'inventory-window'
      if (start > 0) container.append(createSlotSection('Pencere', activeWindow.slots, 0, start, columns))
      if (total > start) {
        const playerCount = total - start
        const player = document.createElement('div')
        const mainEnd = playerCount >= 9 ? total - 9 : total
        player.append(createSlotSection('Oyuncu envanteri', activeWindow.slots, start, mainEnd, 9))
        if (playerCount >= 9) player.append(createSlotSection('', activeWindow.slots, mainEnd, total, 9, 'hotbar'))
        container.append(player)
      }
      grid.append(container)
      applyInventorySearch()
    }
    let developerOptionsTimer = null
    function setDeveloperOptionsVisible(visible) {
      const options = byId('developerOptions')
      clearTimeout(developerOptionsTimer)
      if (visible) {
        options.hidden = false
        options.inert = false
        requestAnimationFrame(() => options.classList.add('is-visible'))
        return
      }
      options.inert = true
      options.classList.remove('is-visible')
      developerOptionsTimer = setTimeout(() => { options.hidden = true }, 250)
    }
    function toggleDeveloperOptions() {
      const options = byId('developerOptions')
      setDeveloperOptionsVisible(options.hidden || !options.classList.contains('is-visible'))
    }
    function handleDeveloperKeyword(input, onClear = () => {}) {
      if (input.value.trim().toLocaleUpperCase('tr-TR') !== 'DEL') return false
      toggleDeveloperOptions()
      input.value = ''
      onClear()
      return true
    }
    function connectWindowEvents() {
      if (windowEventsController) windowEventsController.abort()
      if (!panelConnection.url) return

      const controller = new AbortController()
      windowEventsController = controller
      const headers = { Accept: 'text/event-stream' }
      if (panelConnection.token) headers.Authorization = `Bearer ${panelConnection.token}`
      let failureNotified = false
      let attemptController = null
      let failures = 0
      const reportFailure = (title, message) => {
        if (failureNotified) return
        failureNotified = true
        showToast({ code: 'ERR_WINDOW_EVENTS', title, message })
      }
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      // Sunucu 15 sn'de bir keepalive yollar; 45 sn sessizlik = ölü bağlantı (iPadOS arka plan / ağ değişimi).
      const STALE_MS = 45000

      // Safari'de sekme arka plandan dönünce veya ağ geri gelince akışı hemen yenile.
      const forceReconnect = () => {
        if (controller.signal.aborted) return
        if (attemptController) attemptController.abort()
        if (socket && !socket.connected) socket.connect()
      }
      const onVisible = () => { if (document.visibilityState === 'visible') forceReconnect() }
      document.addEventListener('visibilitychange', onVisible)
      window.addEventListener('online', forceReconnect)
      window.addEventListener('pageshow', forceReconnect)
      controller.signal.addEventListener('abort', () => {
        document.removeEventListener('visibilitychange', onVisible)
        window.removeEventListener('online', forceReconnect)
        window.removeEventListener('pageshow', forceReconnect)
        if (attemptController) attemptController.abort()
      })

      const readEvents = async () => {
        while (!controller.signal.aborted) {
          let reader
          let watchdog = null
          const attempt = new AbortController()
          attemptController = attempt
          try {
            let lastByteAt = Date.now()
            watchdog = setInterval(() => {
              if (Date.now() - lastByteAt > STALE_MS) attempt.abort()
            }, 5000)
            const response = await fetch(`${panelConnection.url}/events`, {
              headers,
              cache: 'no-store',
              signal: attempt.signal
            })
            if (!response.ok) {
              reportFailure('Envanter akışı açılamadı', `SSE isteği HTTP ${response.status} yanıtı verdi; yeniden denenecek.`)
              throw new Error(`HTTP ${response.status}`)
            }
            if (!response.body) throw new Error('Tarayıcı SSE yanıt akışını desteklemiyor.')

            reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            let dataLines = []
            let streamEnded = false
            failures = 0
            while (!streamEnded && !controller.signal.aborted) {
              const { value, done } = await reader.read()
              lastByteAt = Date.now()
              streamEnded = done
              buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
              const lines = buffer.split(/\r?\n/)
              buffer = lines.pop()
              for (const line of lines) {
                if (!line) {
                  if (dataLines.length) {
                    try {
                      const message = JSON.parse(dataLines.join('\n'))
                      if (!controller.signal.aborted && message.type === 'window') {
                        failureNotified = false
                        renderWindow(message.data)
                      }
                    } catch {}
                    dataLines = []
                  }
                } else if (line.startsWith('data:')) {
                  dataLines.push(line.slice(5).trimStart())
                }
              }
            }
          } catch (error) {
            if (controller.signal.aborted) return
            failures++
            if (!attempt.signal.aborted) reportFailure('Envanter akışı kesildi', error.message)
          } finally {
            clearInterval(watchdog)
            if (reader) { try { reader.cancel() } catch {} try { reader.releaseLock() } catch {} }
          }
          if (controller.signal.aborted) return
          // Üstel geri çekilme: 1 sn → en fazla 15 sn; yeniden bağlanma anında (forceReconnect) beklemeyi atlar.
          await wait(Math.min(15000, 1000 * 2 ** Math.min(failures, 4)))
        }
      }
      readEvents()
    }
    function renderMsa(code) {
      const box = byId('msaBox')
      box.classList.toggle('show', Boolean(code && code.userCode))
      if (!code || !code.userCode) return
      const link = byId('msaLink')
      try {
        const url = new URL(code.verificationUri)
        link.href = url.protocol === 'https:' ? url.href : '#'
      } catch { link.href = '#' }
      byId('msaCode').textContent = code.userCode
    }
    function applyConfig(c) {
      configuredUsername = c.account.username
      byId('host').value = c.server.host
      byId('serverPort').value = c.server.port
      byId('username').value = c.account.username
      byId('auth').value = c.account.auth
      byId('minecraftVersion').value = c.minecraftVersion || c.runtime?.minecraft || '1.21.4'
      byId('serverCommand').value = ''
      byId('serverCommand').placeholder = c.account.hasServerCommand ? 'Kayıtlı komut mevcut; değiştirmek için yeni komut yazın' : 'İsteğe bağlı /login veya /register komutu'
      byId('clearCommand').checked = false
      byId('antiEnabled').checked = c.antiAfk.enabled
      byId('afkMin').value = c.antiAfk.minSeconds
      byId('afkMax').value = c.antiAfk.maxSeconds
      byId('reconnectEnabled').checked = c.reconnect.enabled
      byId('reconnectInitial').value = c.reconnect.initialSeconds
      byId('reconnectMax').value = c.reconnect.maxSeconds
      byId('eatEnabled').checked = c.autoEat.enabled
      byId('eatThreshold').value = c.autoEat.hungerThreshold
      byId('sequentialFlowEnabled').checked = c.sequentialFlow.enabled
      byId('firstServerCommand').value = '/skyblock'
      byId('autoClickerEnabled').checked = c.autoClicker.enabled
      byId('autoClickerCommand').value = c.autoClicker.command
      byId('autoClickerSlots').value = c.autoClicker.slots.join(', ')
      byId('autoClickerInterval').value = c.autoClicker.intervalHours
      const chestAutomation = c.chestAutomation || {
        enabled: true,
        intervalMinutes: 5,
        coordinates: null,
        whitelist: ['cooked_beef', 'steak', 'biftek']
      }
      byId('chestAutomationEnabled').checked = chestAutomation.enabled !== false
      byId('chestIntervalMinutes').value = chestAutomation.intervalMinutes || 5
      byId('chestCoordinateX').value = chestAutomation.coordinates ? chestAutomation.coordinates.x : ''
      byId('chestCoordinateY').value = chestAutomation.coordinates ? chestAutomation.coordinates.y : ''
      byId('chestCoordinateZ').value = chestAutomation.coordinates ? chestAutomation.coordinates.z : ''
      byId('chestWhitelist').value = Array.isArray(chestAutomation.whitelist) ? chestAutomation.whitelist.join('\n') : 'cooked_beef\nsteak\nbiftek'
      byId('autoResponderEnabled').checked = c.autoResponder.enabled
      byId('autoResponderRules').value = c.autoResponder.rules.map(rule => `${rule.keyword} => ${rule.response}`).join('\n')
      byId('discordWebhook').value = ''
      byId('discordWebhook').placeholder = c.discord.hasWebhook ? 'Webhook ayarlı; değiştirmek için yeni URL girin' : 'Webhook ayarlı değil'
      byId('clearDiscordWebhook').checked = false
      const envoyConfig = c.envoy || { enabled: true, keywords: ['envoy'], coordinates: null }
      byId('envoyEnabled').checked = envoyConfig.enabled !== false
      byId('envoyKeywords').value = (envoyConfig.keywords || []).join('\n')
      byId('envoyCoordinateX').value = envoyConfig.coordinates ? envoyConfig.coordinates.x : ''
      byId('envoyCoordinateY').value = envoyConfig.coordinates ? envoyConfig.coordinates.y : ''
      byId('envoyCoordinateZ').value = envoyConfig.coordinates ? envoyConfig.coordinates.z : ''
      byId('apiKeyInput').value = ''
      byId('clearApiKey').checked = false
      const apiKeyInfo = c.apiKeyInfo || { configured: false, hint: '' }
      byId('apiKeyInput').placeholder = apiKeyInfo.configured ? `API anahtarı ayarlı (${apiKeyInfo.hint}); değiştirmek için yenisini girin` : 'API anahtarı ayarlı değil'
      byId('logLevel').value = c.logLevel
      byId('panelPort').value = c.panel.port
      byId('openBrowser').checked = c.panel.openBrowser
      if (c.runtime) {
        text('nodeVersion', c.runtime.node)
        text('versionMinecraft', c.runtime.minecraft)
        text('headerMinecraftVersion', c.runtime.minecraft)
      }
    }
    function connectPanel() {
      if (socket) socket.disconnect()
      if (windowEventsController) windowEventsController.abort()
      renderWindow(null)
      if (!panelConnection.url) {
        text('status', 'Bot paneli adresini girin')
        return
      }
      socket = window.io(panelConnection.url, {
        auth: { token: panelConnection.token },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
        timeout: 20000
      })
      connectWindowEvents()
      socket.on('connect', () => {
        if (!currentState.status) text('status', 'Panel bağlı')
      })
      socket.on('connect_error', error => {
        text('status', `Panel bağlantısı başarısız: ${error.message}`)
      })
      socket.on('init_config', applyConfig)
      socket.on('bot_state', updateState)
      socket.on('msa', renderMsa)
      socket.on('system_log', entry => {
        const level = displayValue(entry.level, 'info').toLowerCase()
        appendLogEntry(entry, level)
      })
      socket.on('chat_message', entry => {
        showChatOutput(entry)
        const text = entry.sender ? `${entry.sender}: ${entry.text}` : entry.text
        appendLogEntry({ ...entry, text }, 'chat')
      })
      socket.on('errorNotice', showToast)
    }
    byId('panelUrl').value = panelConnection.url
    byId('panelToken').value = panelConnection.token
    byId('savePanelConnection').addEventListener('click', () => {
      let parsed
      try {
        parsed = new URL(byId('panelUrl').value.trim())
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
          throw new Error('Adres http:// veya https:// ile başlamalı; kullanıcı adı, parola, sorgu ve parça içeremez.')
        }
      } catch (error) {
        showToast({ code: 'ERR_PANEL_URL', title: 'Panel adresi geçersiz', message: error.message })
        return
      }
      panelConnection = { url: parsed.origin, token: byId('panelToken').value.trim() }
      try {
        localStorage.setItem(panelConnectionStorageKey, JSON.stringify(panelConnection))
      } catch (error) {
        showToast({ code: 'ERR_PANEL_STORAGE', title: 'Bağlantı ayarı saklanamadı', message: error.message })
        return
      }
      currentState = {}
      connectPanel()
    })
    connectPanel()
    byId('inventorySearch').addEventListener('input', event => {
      const input = event.currentTarget
      if (handleDeveloperKeyword(input, applyInventorySearch)) return
      applyInventorySearch()
    })
    byId('closeDeveloperOptions').addEventListener('click', toggleDeveloperOptions)
    let developerKeySequence = ''
    let developerKeySequenceAt = 0
    document.addEventListener('keydown', event => {
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return
      const target = event.target
      if (target instanceof HTMLElement &&
        (target.isContentEditable || target.matches('input, textarea, select'))) return
      const now = Date.now()
      if (now - developerKeySequenceAt > 1500) developerKeySequence = ''
      developerKeySequenceAt = now
      if (event.key.length !== 1 || !/[a-z]/i.test(event.key)) {
        developerKeySequence = ''
        return
      }
      developerKeySequence = `${developerKeySequence}${event.key.toLocaleUpperCase('tr-TR')}`.slice(-3)
      if (developerKeySequence === 'DEL') {
        toggleDeveloperOptions()
        developerKeySequence = ''
      }
    })
    byId('inventoryGrid').addEventListener('click', async event => {
      const button = event.target.closest('button[data-slot]')
      if (!button || !activeWindow) return
      const slot = Number(button.dataset.slot)
      const windowId = activeWindow.windowId
      button.disabled = true
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)
      try {
        const headers = { 'Content-Type': 'application/json' }
        if (panelConnection.token) headers.Authorization = `Bearer ${panelConnection.token}`
        const response = await fetch(`${panelConnection.url}/api/click-slot`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ windowId, slot }),
          signal: controller.signal
        })
        const result = await response.json()
        if (!response.ok || !result || result.ok !== true) {
          throw new Error(result && result.error ? result.error : `Slot tıklaması başarısız (HTTP ${response.status}).`)
        }
      } catch (error) {
        showToast({
          code: 'ERR_WINDOW_CLICK',
          title: 'Slot tıklanamadı',
          message: controller.signal.aborted ? 'Panel isteği zaman aşımına uğradı.' : error.message
        })
      } finally {
        clearTimeout(timeout)
        if (button.isConnected) button.disabled = false
      }
    })
    byId('triggerChestDeposit').addEventListener('click', async event => {
      const button = event.currentTarget
      button.disabled = true
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 60000)
      try {
        const headers = { 'Content-Type': 'application/json' }
        if (panelConnection.token) headers.Authorization = `Bearer ${panelConnection.token}`
        const response = await fetch(`${panelConnection.url}/api/trigger-deposit`, {
          method: 'POST',
          headers,
          body: '{}',
          signal: controller.signal
        })
        const result = await response.json()
        if (!response.ok || !result || result.ok !== true) {
          throw new Error(result && result.error ? result.error : `Sandık aktarımı başarısız (HTTP ${response.status}).`)
        }
        text('chestAutomationMessage', result.message || 'Sandık aktarımı tamamlandı.')
      } catch (error) {
        showToast({
          code: error.code || 'ERR_CHEST_DEPOSIT',
          title: 'Sandığa eşya konamadı',
          message: controller.signal.aborted ? 'Sandık aktarım isteği zaman aşımına uğradı.' : error.message
        })
      } finally {
        clearTimeout(timeout)
        button.disabled = !isBotConnected
      }
    })
    byId('triggerEnvoy').addEventListener('click', async event => {
      const button = event.currentTarget
      button.disabled = true
      try {
        const headers = { 'Content-Type': 'application/json' }
        if (panelConnection.token) headers.Authorization = `Bearer ${panelConnection.token}`
        const inputs = ['envoyCoordinateX', 'envoyCoordinateY', 'envoyCoordinateZ'].map(id => byId(id).value.trim())
        const values = inputs.map(Number)
        const body = inputs.every(Boolean) && values.every(Number.isInteger)
          ? { coordinates: { x: values[0], y: values[1], z: values[2] } }
          : {}
        const response = await fetch(`${panelConnection.url}/api/envoy/trigger`, { method: 'POST', headers, body: JSON.stringify(body) })
        const result = await response.json()
        if (!response.ok || !result || result.ok !== true) {
          throw new Error(result && result.error ? result.error : `Envoy tetiklenemedi (HTTP ${response.status}).`)
        }
      } catch (error) {
        showToast({ code: error.code || 'ERR_ENVOY', title: 'Envoy tetiklenemedi', message: error.message })
      } finally {
        button.disabled = false
      }
    })
    byId('triggerDailyCommand').addEventListener('click', async event => {
      const button = event.currentTarget
      button.disabled = true
      try {
        const headers = { 'Content-Type': 'application/json' }
        if (panelConnection.token) headers.Authorization = `Bearer ${panelConnection.token}`
        const response = await fetch(`${panelConnection.url}/api/trigger-daily-command`, {
          method: 'POST',
          headers,
          body: '{}'
        })
        const result = await response.json()
        if (!response.ok || !result || result.ok !== true) {
          throw new Error(result && result.error ? result.error : `Komut gönderilemedi (HTTP ${response.status}).`)
        }
      } catch (error) {
        showToast({
          code: error.code || 'ERR_DAILY_COMMAND',
          title: 'Komut gönderilemedi',
          message: error.message
        })
      } finally {
        button.disabled = !isBotConnected
      }
    })
    byId('triggerAntiAfk').addEventListener('click', async event => {
      const button = event.currentTarget
      button.disabled = true
      try {
        const headers = { 'Content-Type': 'application/json' }
        if (panelConnection.token) headers.Authorization = `Bearer ${panelConnection.token}`
        const response = await fetch(`${panelConnection.url}/api/trigger-anti-afk`, {
          method: 'POST',
          headers,
          body: '{}'
        })
        const result = await response.json()
        if (!response.ok || !result || result.ok !== true) {
          throw new Error(result && result.error ? result.error : `Anti-AFK tetiklenemedi (HTTP ${response.status}).`)
        }
      } catch (error) {
        showToast({
          code: error.code || 'ERR_AFK_TRIGGER',
          title: 'Anti-AFK tetiklenemedi',
          message: error.message
        })
      } finally {
        button.disabled = !isBotConnected
      }
    })
    async function post(url, data = {}) {
      const requests = {
        '/api/connect': ['connect_bot', {}],
        '/api/disconnect': ['disconnect_bot', {}],
        '/api/config': ['update_config', data],
        '/api/chat': ['send_chat', { cmd: data.text }],
        '/api/restart_bot': ['restart_bot', {}]
      }
      const request = requests[url]
      if (!request) throw new Error('Desteklenmeyen panel isteği.')
      if (!socket || !socket.connected) throw new Error('Web paneli sunucusuna bağlı değil.')
      const [eventName, payload] = request
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Panel yanıt vermedi.')), 10000)
        socket.emit(eventName, payload, response => {
          clearTimeout(timeout)
          if (!response || response.ok !== true) {
            reject(new Error(response && response.error ? response.error : 'İstek başarısız.'))
            return
          }
          resolve(response)
        })
      })
      return url === '/api/config' ? { config: result.config } : result
    }
    byId('connect').addEventListener('click', async () => {
      try { await post('/api/connect') } catch (error) { showToast({ code: 'ERR_PANEL_REQUEST', title: 'Bağlanma isteği başarısız', message: error.message }) }
    })
    byId('disconnect').addEventListener('click', async () => {
      try { await post('/api/disconnect') } catch (error) { showToast({ code: 'ERR_PANEL_REQUEST', title: 'Bağlantıyı kesme isteği başarısız', message: error.message }) }
    })
    byId('restartBot').addEventListener('click', async event => {
      const button = event.currentTarget
      button.disabled = true
      try {
        await post('/api/restart_bot')
      } catch (error) {
        showToast({ code: 'ERR_PANEL_REQUEST', title: 'Bot yeniden başlatılamadı', message: error.message })
      } finally {
        button.disabled = false
      }
    })
    byId('settings').addEventListener('submit', async event => {
      event.preventDefault()
      const command = byId('serverCommand').value
      const firstServerCommand = byId('firstServerCommand').value.trim()
      if (firstServerCommand.length > 256 || /[\r\n]/.test(firstServerCommand)) {
        text('saveMessage', 'İlk sunucu komutu en fazla 256 karakter olmalı ve satır sonu içermemelidir.')
        byId('firstServerCommand').focus()
        return
      }
      const autoClickerEnabled = byId('autoClickerEnabled').checked
      const autoClickerCommand = byId('autoClickerCommand').value.trim()
      const slotText = byId('autoClickerSlots').value.trim()
      if (autoClickerEnabled && (!autoClickerCommand || autoClickerCommand.length > 256 || /[\r\n]/.test(autoClickerCommand))) {
        text('saveMessage', 'Otomatik komut 1-256 karakter olmalı ve satır sonu içermemelidir.')
        byId('autoClickerCommand').focus()
        return
      }
      if (!/^\d+(?:\s*,\s*\d+)*$/.test(slotText)) {
        text('saveMessage', 'Tıklanacak slotları virgülle ayrılmış sayılar olarak girin.')
        byId('autoClickerSlots').focus()
        return
      }
      const autoClickerSlots = slotText.split(',').map(slot => Number(slot.trim()))
      if (autoClickerSlots.some(slot => !Number.isInteger(slot) || slot < 0 || slot > 53) || new Set(autoClickerSlots).size !== autoClickerSlots.length) {
        text('saveMessage', 'Slotlar 0-53 arasında, tekrarsız sayılar olmalıdır.')
        byId('autoClickerSlots').focus()
        return
      }
      const autoClickerInterval = Number(byId('autoClickerInterval').value)
      if (!Number.isInteger(autoClickerInterval) || autoClickerInterval !== 24) {
        text('saveMessage', 'Günlük komut aralığı sabit olarak 24 saattir.')
        byId('autoClickerInterval').focus()
        return
      }
      const chestIntervalMinutes = Number(byId('chestIntervalMinutes').value)
      if (!Number.isInteger(chestIntervalMinutes) || chestIntervalMinutes < 1 || chestIntervalMinutes > 1440) {
        text('saveMessage', 'Sandık aktarım aralığı 1-1440 dakika arasında tam sayı olmalıdır.')
        byId('chestIntervalMinutes').focus()
        return
      }
      const chestCoordinateInputs = [
        byId('chestCoordinateX').value.trim(),
        byId('chestCoordinateY').value.trim(),
        byId('chestCoordinateZ').value.trim()
      ]
      let chestCoordinates = null
      if (chestCoordinateInputs.some(Boolean)) {
        const values = chestCoordinateInputs.map(Number)
        if (chestCoordinateInputs.some(value => value === '') ||
          values.some(value => !Number.isInteger(value)) ||
          Math.abs(values[0]) > 30000000 || Math.abs(values[2]) > 30000000 || values[1] < -2048 || values[1] > 4096) {
          text('saveMessage', 'Sandık koordinatlarında X/Y/Z için tam sayı ve izin verilen aralığı kullanın.')
          byId('chestCoordinateX').focus()
          return
        }
        chestCoordinates = { x: values[0], y: values[1], z: values[2] }
      }
      const envoyCoordinateInputs = [
        byId('envoyCoordinateX').value.trim(),
        byId('envoyCoordinateY').value.trim(),
        byId('envoyCoordinateZ').value.trim()
      ]
      let envoyCoordinates = null
      if (envoyCoordinateInputs.some(Boolean)) {
        const values = envoyCoordinateInputs.map(Number)
        if (envoyCoordinateInputs.some(value => value === '') ||
          values.some(value => !Number.isInteger(value)) ||
          Math.abs(values[0]) > 30000000 || Math.abs(values[2]) > 30000000 || values[1] < -2048 || values[1] > 4096) {
          text('saveMessage', 'Envoy koordinatlarında X/Y/Z için tam sayı ve izin verilen aralığı kullanın.')
          byId('envoyCoordinateX').focus()
          return
        }
        envoyCoordinates = { x: values[0], y: values[1], z: values[2] }
      }
      const envoyKeywords = byId('envoyKeywords').value.split(/[,\r\n]+/).map(item => item.trim()).filter(Boolean)
      const whitelistText = byId('chestWhitelist').value.trim()
      const chestWhitelist = whitelistText ? whitelistText.split(/[,\r\n]+/).map(name => name.trim()).filter(Boolean) : []
      if (chestWhitelist.length > 47 || chestWhitelist.some(name =>
        name.length > 64 || !/^(?:minecraft:)?[a-zA-Z0-9_\s-]+$/.test(name))) {
        text('saveMessage', 'Biftek koruması dahil en fazla 50 eşya adı kaydedilebilir (en fazla 47 ek ad).')
        byId('chestWhitelist').focus()
        return
      }
      const afkMinSeconds = Number(byId('afkMin').value)
      const afkMaxSeconds = Number(byId('afkMax').value)
      if (!Number.isInteger(afkMinSeconds) || !Number.isInteger(afkMaxSeconds) ||
        afkMinSeconds !== 30 || afkMaxSeconds !== 30) {
        text('saveMessage', 'Anti-AFK aralığı sabit olarak 30 saniyedir.')
        byId('afkMin').focus()
        return
      }
      const reconnectInitialSeconds = Number(byId('reconnectInitial').value)
      const reconnectMaxSeconds = Number(byId('reconnectMax').value)
      if (reconnectInitialSeconds !== 5 || reconnectMaxSeconds !== 5) {
        text('saveMessage', 'Yeniden bağlanma süresi sabit olarak 5 saniyedir.')
        byId('reconnectInitial').focus()
        return
      }
      const autoResponderRules = []
      for (const [index, line] of byId('autoResponderRules').value.split(/\r?\n/).entries()) {
        const trimmedLine = line.trim()
        if (!trimmedLine) continue
        const separatorIndex = trimmedLine.indexOf('=>')
        if (separatorIndex === -1) {
          text('saveMessage', `Oto-yanıt ${index + 1}. satırında "kelime => yanıt" biçimini kullanın.`)
          byId('autoResponderRules').focus()
          return
        }
        const keyword = trimmedLine.slice(0, separatorIndex).trim()
        const response = trimmedLine.slice(separatorIndex + 2).trim()
        if (!keyword || keyword.length > 80 || !response || response.length > 256 || /[\r\n]/.test(response)) {
          text('saveMessage', `Oto-yanıt ${index + 1}. satırında kelime en fazla 80, yanıt 1-256 karakter olmalıdır.`)
          byId('autoResponderRules').focus()
          return
        }
        autoResponderRules.push({ keyword, response })
      }
      if (autoResponderRules.length > 20) {
        text('saveMessage', 'En fazla 20 oto-yanıt kuralı ekleyebilirsiniz.')
        byId('autoResponderRules').focus()
        return
      }
      const responderKeywords = autoResponderRules.map(rule => rule.keyword.toLocaleLowerCase('tr-TR'))
      if (new Set(responderKeywords).size !== responderKeywords.length) {
        text('saveMessage', 'Oto-yanıt anahtar kelimeleri tekrarsız olmalıdır.')
        byId('autoResponderRules').focus()
        return
      }
      const data = {
        server: { host: byId('host').value, port: Number(byId('serverPort').value) },
        account: { username: byId('username').value, auth: byId('auth').value, serverCommand: command, clearServerCommand: byId('clearCommand').checked },
        sequentialFlow: {
          enabled: byId('sequentialFlowEnabled').checked,
          firstCommand: firstServerCommand
        },
        antiAfk: { enabled: byId('antiEnabled').checked, minSeconds: afkMinSeconds, maxSeconds: afkMaxSeconds },
        reconnect: { enabled: byId('reconnectEnabled').checked, initialSeconds: reconnectInitialSeconds, maxSeconds: reconnectMaxSeconds },
        autoEat: { enabled: byId('eatEnabled').checked, hungerThreshold: Number(byId('eatThreshold').value) },
        autoClicker: {
          enabled: autoClickerEnabled,
          command: autoClickerCommand,
          slots: autoClickerSlots,
          intervalHours: autoClickerInterval
        },
        chestAutomation: {
          enabled: byId('chestAutomationEnabled').checked,
          intervalMinutes: chestIntervalMinutes,
          coordinates: chestCoordinates,
          whitelist: chestWhitelist
        },
        autoResponder: {
          enabled: byId('autoResponderEnabled').checked,
          rules: autoResponderRules
        },
        discord: {
          webhookUrl: byId('discordWebhook').value.trim(),
          clearWebhook: byId('clearDiscordWebhook').checked
        },
        envoy: { enabled: byId('envoyEnabled').checked, keywords: envoyKeywords, coordinates: envoyCoordinates },
        apiKey: byId('apiKeyInput').value.trim(),
        clearApiKey: byId('clearApiKey').checked,
        minecraftVersion: byId('minecraftVersion').value,
        logLevel: byId('logLevel').value,
        panel: { port: Number(byId('panelPort').value), openBrowser: byId('openBrowser').checked }
      }
      try {
        const result = await post('/api/config', data)
        applyConfig(result.config)
        text('saveMessage', 'Ayarlar kaydedildi.')
        setTimeout(() => text('saveMessage', ''), 3000)
      } catch (error) { text('saveMessage', error.message) }
    })
    byId('chatForm').addEventListener('submit', event => {
      event.preventDefault()
      const input = byId('chatInput')
      const message = input.value.trim()
      if (!message) return
      input.value = ''
      setTimeout(() => input.focus(), 50)
      post('/api/chat', { text: message, color: selectedChatColor }).catch(error => {
        showToast({
          code: error.code || 'ERR_CHAT_SEND',
          title: error.code === 'ERR_BOT_NOT_CONNECTED' ? 'Bot sunucuya bağlı değil' : 'Mesaj gönderilemedi',
          message: error.message
        })
      })
      byId('chatInput').addEventListener('input', event => {
        handleDeveloperKeyword(event.currentTarget)
      })
    })
    const updateSequentialFlowStatus = () => {
      const enabled = byId('sequentialFlowEnabled').checked
      text('sequentialFlowStatus', enabled
        ? 'AKTİF · giriş komutundan sonra 20 sn → /skyblock → 20 sn ada yüklemesi → oyun içi komut → Anti-AFK.'
        : 'PASİF · Otomatik giriş ve komut zinciri çalışmaz.')
      byId('sequentialFlowStatus').classList.toggle('sequence-status', enabled)
      byId('sequentialFlowStatus').classList.toggle('is-off', !enabled)
    }
    byId('sequentialFlowEnabled').addEventListener('change', updateSequentialFlowStatus)
    updateSequentialFlowStatus()