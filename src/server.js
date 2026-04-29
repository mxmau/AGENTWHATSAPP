import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { Server as SocketIO } from 'socket.io'
import cron from 'node-cron'
import { initWhatsApp, getQR, getStatus, clientEvents, listKnownChats, diagnoseChatCandidates, refreshGroupCache } from './whatsappClient.js'
import { runPipeline } from './pipeline.js'
import { listExistingAgents } from './agentManager.js'
import { loadHistoryAsync } from './runHistory.js'
import { ensureAgentsDir, restoreAgentsDir } from './agentManager.js'
import { initPersistence, isPersistenceEnabled, listLogsByRecifeDate, saveLogEntry } from './persistence.js'

const app = express()
const httpServer = createServer(app)
const io = new SocketIO(httpServer)
const PORT = process.env.PORT || 3000

ensureAgentsDir()

// ── Dashboard HTML ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(/* html */`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhatsApp Agent Monitor</title>
<script src="/socket.io/socket.io.js"></script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@300;400;500;600&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#080810;--surface:#0f0f1a;--border:#1e1e2e;--accent:#7c3aed;--accent2:#06b6d4;--text:#e2e8f0;--muted:#64748b;--green:#4ade80;--yellow:#fbbf24;--red:#f87171}
  body{background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;min-height:100vh}
  header{border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;gap:12px}
  .logo{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:16px}
  .logo-text{font-family:'Space Mono',monospace;font-weight:700;font-size:14px}
  .badge{font-size:11px;padding:2px 8px;border-radius:99px;background:var(--surface);border:1px solid var(--border);color:var(--muted);font-family:'Space Mono',monospace}
  main{max-width:900px;margin:0 auto;padding:32px 24px;display:flex;flex-direction:column;gap:24px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px}
  .card-title{font-family:'Space Mono',monospace;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--accent);margin-bottom:16px}
  .status-row{display:flex;align-items:center;gap:10px}
  .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .dot.ready{background:var(--green);box-shadow:0 0 8px var(--green)}
  .dot.qr{background:var(--yellow);box-shadow:0 0 8px var(--yellow)}
  .dot.connecting,.dot.initializing,.dot.authenticated{background:var(--yellow)}
  .dot.disconnected{background:var(--red)}
  #status-text{font-size:14px}
  #qr-section{text-align:center;padding:16px 0}
  #qr-section p{color:var(--muted);font-size:13px;margin-top:12px}
  #qr-img{border-radius:12px;border:4px solid var(--border)}
  .hidden{display:none!important}
  .btn{padding:10px 20px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-family:'DM Sans',sans-serif;font-weight:500;transition:all .2s}
  .btn-primary{background:linear-gradient(135deg,var(--accent),var(--accent2));color:white}
  .btn-ghost{background:var(--surface);border:1px solid var(--border);color:var(--muted)}
  .btn:disabled{opacity:0.4;cursor:not-allowed}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .stat{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px}
  .stat-val{font-family:'Space Mono',monospace;font-size:24px;font-weight:700;color:var(--text)}
  .stat-label{font-size:12px;color:var(--muted);margin-top:4px}
  .run-item{padding:12px;border-radius:8px;background:var(--bg);border:1px solid var(--border);margin-bottom:8px;font-size:13px}
  .run-item .run-time{font-family:'Space Mono',monospace;font-size:11px;color:var(--muted)}
  .run-item .run-tasks{color:var(--accent2);font-weight:500}
  .agent-item{padding:10px 14px;border-radius:8px;background:var(--bg);border:1px solid var(--border);margin-bottom:6px;font-size:13px}
  .agent-name{font-weight:500}
  .agent-src{font-size:11px;color:var(--muted);font-family:'Space Mono',monospace;margin-top:2px}
  .tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:'Space Mono',monospace}
  .tag-new{background:rgba(124,58,237,.15);color:#a78bfa;border:1px solid rgba(124,58,237,.3)}
  .tag-existing{background:rgba(6,182,212,.1);color:#67e8f9;border:1px solid rgba(6,182,212,.25)}
  #log{font-family:'Space Mono',monospace;font-size:11px;color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;height:140px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
  @keyframes spin{to{transform:rotate(360deg)}}
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
</style>
</head>
<body>
<header>
  <div class="logo">🤖</div>
  <span class="logo-text">whatsapp_agent_monitor</span>
  <span class="badge" id="status-badge">carregando...</span>
</header>

<main>
  <!-- Status -->
  <div class="card">
    <div class="card-title">conexão whatsapp</div>
    <div class="status-row">
      <div class="dot connecting" id="status-dot"></div>
      <span id="status-text">inicializando...</span>
    </div>
    <div id="qr-section" class="hidden">
      <img id="qr-img" width="220" height="220" alt="QR Code" />
      <p>abra o WhatsApp no celular → Dispositivos conectados → Conectar dispositivo</p>
    </div>
    <div style="margin-top:14px;display:flex;gap:8px">
      <button class="btn btn-primary" id="run-btn" onclick="triggerRun()">▶ executar agora</button>
      <button class="btn btn-ghost" onclick="location.reload()">↻ atualizar</button>
    </div>
  </div>

  <!-- Stats grid -->
  <div class="grid-2">
    <div class="stat">
      <div class="stat-val" id="stat-runs">0</div>
      <div class="stat-label">execuções realizadas</div>
    </div>
    <div class="stat">
      <div class="stat-val" id="stat-agents">0</div>
      <div class="stat-label">agentes gerados</div>
    </div>
  </div>

  <!-- Agentes gerados -->
  <div class="card">
    <div class="card-title">agentes gerados</div>
    <div id="agents-list"><span style="color:var(--muted);font-size:13px">nenhum agente gerado ainda</span></div>
  </div>

  <!-- Histórico de execuções -->
  <div class="card">
    <div class="card-title">últimas execuções</div>
    <div id="run-history"><span style="color:var(--muted);font-size:13px">nenhuma execução ainda</span></div>
  </div>

  <!-- Log em tempo real -->
  <div class="card">
    <div class="card-title">log em tempo real</div>
    <div id="log"></div>
  </div>
</main>

<script>
const socket = io()
let running = false

socket.on('status', updateStatus)
socket.on('qr', (url) => {
  document.getElementById('qr-section').classList.remove('hidden')
  document.getElementById('qr-img').src = url
})
socket.on('log', (msg) => {
  const log = document.getElementById('log')
  log.textContent += msg + '\\n'
  log.scrollTop = log.scrollHeight
})
socket.on('data', renderData)

function updateStatus(s) {
  const dot = document.getElementById('status-dot')
  const text = document.getElementById('status-text')
  const badge = document.getElementById('status-badge')
  dot.className = 'dot ' + s
  const labels = {initializing:'inicializando...',qr:'aguardando QR scan',authenticated:'autenticando...',ready:'conectado ✓',disconnected:'desconectado'}
  text.textContent = labels[s] || s
  badge.textContent = s
  if (s === 'ready') document.getElementById('qr-section').classList.add('hidden')
}

function renderData({ history, agents }) {
  document.getElementById('stat-runs').textContent = history.length
  document.getElementById('stat-agents').textContent = agents.length

  const agentsList = document.getElementById('agents-list')
  if (agents.length) {
    agentsList.innerHTML = agents.map(a => \`
      <div class="agent-item">
        <div class="agent-name">\${a.name || a.file}</div>
        <div class="agent-src">\${a.created_from || ''} · \${a.fonte || ''}</div>
      </div>\`).join('')
  }

  const histEl = document.getElementById('run-history')
  if (history.length) {
    histEl.innerHTML = history.slice(0, 10).map(r => \`
      <div class="run-item">
        <div class="run-time">\${new Date(r.timestamp).toLocaleString('pt-BR')}</div>
        <div class="run-tasks">\${r.totalTasks} tarefas · \${r.newAgents?.length || 0} agentes criados</div>
      </div>\`).join('')
  }
}

async function triggerRun() {
  if (running) return
  running = true
  const btn = document.getElementById('run-btn')
  btn.innerHTML = '<span class="spinner"></span> executando...'
  btn.disabled = true
  try {
    const res = await fetch('/run', { method: 'POST' })
    const data = await res.json()
    socket.emit('refresh')
  } catch(e) {
    alert('Erro ao executar: ' + e.message)
  } finally {
    running = false
    btn.innerHTML = '▶ executar agora'
    btn.disabled = false
  }
}

// Polling leve para atualizar dados
setInterval(() => socket.emit('refresh'), 15000)
socket.emit('refresh')
</script>
</body>
</html>`)
})

// ── API ───────────────────────────────────────────────────────────────────────
app.use(express.json())

app.post('/run', async (req, res) => {
  try {
    const summary = await runPipeline()
    res.json({ ok: true, summary })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/agents', (req, res) => {
  res.json(listExistingAgents())
})

app.get('/history', async (req, res) => {
  res.json(await loadHistoryAsync())
})

app.get('/logs', async (req, res) => {
  const date = req.query.date || getTodayRecifeDate()
  const limit = Math.min(parseInt(req.query.limit || '1000'), 5000)
  res.json({ date, logs: await listLogsByRecifeDate(date, { limit }) })
})

app.get('/debug/chats', async (req, res) => {
  try {
    const query = String(req.query.query || '')
    const limit = Math.min(parseInt(req.query.limit || '30'), 100)
    const includeMessages = ['1', 'true', 'yes', 'sim'].includes(String(req.query.messages || '').toLowerCase())
    const hoursBack = Math.min(parseInt(req.query.hours || process.env.HOURS_LOOKBACK || '12'), 72)
    await refreshGroupCache()
    res.json({
      query,
      hoursBack,
      chats: listKnownChats({ query, limit, includeMessages, hoursBack }),
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/debug/source', async (req, res) => {
  try {
    const query = String(req.query.query || '')
    const hoursBack = Math.min(parseInt(req.query.hours || process.env.HOURS_LOOKBACK || '12'), 72)
    if (!query.trim()) {
      res.status(400).json({ ok: false, error: 'informe ?query=nome-do-chat' })
      return
    }

    const diagnosis = await diagnoseChatCandidates(query, hoursBack)
    res.json({ ok: true, hoursBack, ...diagnosis })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/debug/sources', (req, res) => {
  const sourceKeys = [
    ['GROUP_ESCOLA_1', 'GROUP_ESCOLA_1_ID', 'Ecilda Ramos 2026'],
    ['GROUP_ESCOLA_2', 'GROUP_ESCOLA_2_ID', 'Professores - Tiradentes'],
    ['GROUP_IGREJA', 'GROUP_IGREJA_ID', 'Ministro e Obreiros IIGD BV'],
    ['CONTACT_ESPOSA', 'CONTACT_ESPOSA_ID', 'Rafaelly'],
    ['CONTACT_PASTOR', 'CONTACT_PASTOR_ID', 'PR Josehilton'],
    ['CONTACT_EU', 'CONTACT_EU_ID', '__self__'],
  ]

  res.json({
    sources: sourceKeys.map(([nameKey, idKey, defaultName]) => ({
      nameKey,
      name: process.env[nameKey] || defaultName,
      idKey,
      idConfigured: Boolean(process.env[idKey]),
      id: process.env[idKey] || null,
    })),
  })
})

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('status', getStatus())
  const qr = getQR()
  if (qr) socket.emit('qr', qr)

  socket.on('refresh', () => {
    loadHistoryAsync().then(history => {
      socket.emit('data', { history, agents: listExistingAgents() })
    })
    socket.emit('status', getStatus())
  })
})

// Forward events to all clients
clientEvents.on('qr', (url) => io.emit('qr', url))
clientEvents.on('ready', () => io.emit('status', 'ready'))
clientEvents.on('disconnected', () => io.emit('status', 'disconnected'))

// Patch console.log/warn/error to also push to socket and persistent storage
const _log = console.log.bind(console)
const _warn = console.warn.bind(console)
const _error = console.error.bind(console)

console.log = (...args) => {
  _log(...args)
  emitAndPersistLog('info', args)
}

console.warn = (...args) => {
  _warn(...args)
  emitAndPersistLog('warn', args)
}

console.error = (...args) => {
  _error(...args)
  emitAndPersistLog('error', args)
}

function emitAndPersistLog(level, args) {
  const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')
  io.emit('log', message)
  saveLogEntry({ level, source: detectLogSource(message), message }).catch(() => {})
}

function detectLogSource(message) {
  const match = message.match(/^\[([^\]]+)\]/)
  return match?.[1] || 'System'
}

function getTodayRecifeDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Recife',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

// ── Cron: 8h e 20h (America/Recife) ──────────────────────────────────────────
cron.schedule('0 8,20 * * *', async () => {
  console.log('[Cron] Iniciando execução agendada...')
  if (getStatus() !== 'ready') {
    console.warn('[Cron] WhatsApp não conectado, pulando execução')
    return
  }
  await runPipeline()
}, { timezone: 'America/Recife' })

// ── Keep-alive (evita spindown no Render free tier) ───────────────────────────
const APP_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL
if (APP_URL) {
  setInterval(() => {
    fetch(`${APP_URL}/health`).catch(() => {})
  }, 14 * 60 * 1000) // a cada 14 min
}

app.get('/health', (req, res) => res.json({
  status: 'ok',
  wa: getStatus(),
  persistence: isPersistenceEnabled() ? 'database' : 'local',
}))

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', async () => {
  console.log(`[Server] Rodando em http://localhost:${PORT}`)
  try {
    await initPersistence()
    await restoreAgentsDir()
    await initWhatsApp()
  } catch (err) {
    console.error('[Server] Erro ao inicializar:', err.message)
  }
})
