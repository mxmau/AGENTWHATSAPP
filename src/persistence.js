import fs from 'fs'
import path from 'path'
import { Pool } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    })
  : null

let initialized = false

export function isPersistenceEnabled() {
  return Boolean(pool)
}

export async function initPersistence() {
  if (!pool || initialized) return false

  await pool.query(`
    create table if not exists app_files (
      key text primary key,
      content text not null,
      updated_at timestamptz not null default now()
    )
  `)

  await pool.query(`
    create table if not exists app_logs (
      id bigserial primary key,
      created_at timestamptz not null default now(),
      recife_date date not null,
      recife_time text not null,
      level text not null,
      source text,
      message text not null,
      metadata jsonb not null default '{}'::jsonb
    )
  `)

  await pool.query(`
    create table if not exists whatsapp_messages (
      id text primary key,
      chat_id text not null,
      chat_name text,
      sender text,
      body text not null,
      timestamp_ms bigint not null,
      timestamp_at timestamptz not null,
      created_at timestamptz not null default now()
    )
  `)

  await pool.query(`
    create index if not exists whatsapp_messages_chat_timestamp_idx
    on whatsapp_messages (chat_id, timestamp_ms)
  `)

  await pool.query(`
    create index if not exists whatsapp_messages_timestamp_idx
    on whatsapp_messages (timestamp_ms)
  `)

  await pool.query(`
    create index if not exists app_logs_recife_date_idx
    on app_logs (recife_date, created_at)
  `)

  initialized = true
  console.log('[Persistence] Banco conectado')
  return true
}

export async function saveLogEntry({ level = 'info', source = null, message, metadata = {} }) {
  if (!pool || !message) return false
  await initPersistence()

  const now = new Date()
  const recifeParts = getRecifeParts(now)

  await pool.query(
    `insert into app_logs (created_at, recife_date, recife_time, level, source, message, metadata)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [now.toISOString(), recifeParts.date, recifeParts.time, level, source, message, JSON.stringify(metadata)],
  )

  return true
}

export async function listLogsByRecifeDate(date, { limit = 1000 } = {}) {
  if (!pool) return []
  await initPersistence()

  const result = await pool.query(
    `select created_at, recife_date, recife_time, level, source, message, metadata
     from app_logs
     where recife_date = $1
     order by created_at asc
     limit $2`,
    [date, limit],
  )

  return result.rows
}

function getRecifeParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Recife',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
  }
}

export async function saveTextFile(key, content) {
  if (!pool) return false
  await initPersistence()
  await pool.query(
    `insert into app_files (key, content, updated_at)
     values ($1, $2, now())
     on conflict (key) do update set content = excluded.content, updated_at = now()`,
    [key, content],
  )
  return true
}

export async function loadTextFile(key) {
  if (!pool) return null
  await initPersistence()
  const result = await pool.query('select content from app_files where key = $1', [key])
  return result.rows[0]?.content ?? null
}

export async function saveDirectory(dirPath, namespace) {
  if (!pool || !fs.existsSync(dirPath)) return false
  await initPersistence()

  const files = fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)

  await Promise.all(files.map(async (filename) => {
    const filePath = path.join(dirPath, filename)
    const content = fs.readFileSync(filePath, 'utf8')
    await saveTextFile(`${namespace}/${filename}`, content)
  }))

  return true
}

export async function restoreDirectory(dirPath, namespace) {
  if (!pool) return false
  await initPersistence()

  const result = await pool.query('select key, content from app_files where key like $1', [`${namespace}/%`])
  if (!result.rows.length) return false

  fs.mkdirSync(dirPath, { recursive: true })
  for (const row of result.rows) {
    const filename = row.key.replace(`${namespace}/`, '')
    if (!filename || filename.includes('/') || filename.includes('..')) continue
    fs.writeFileSync(path.join(dirPath, filename), row.content)
  }

  console.log(`[Persistence] ${result.rows.length} arquivos restaurados de ${namespace}`)
  return true
}

export async function saveWhatsAppMessages(messages = []) {
  if (!pool || !messages.length) return 0
  await initPersistence()

  let saved = 0
  for (const message of messages) {
    if (!message?.id || !message?.chatId || !message?.body || !message?.timestampMs) continue
    await pool.query(
      `insert into whatsapp_messages (id, chat_id, chat_name, sender, body, timestamp_ms, timestamp_at)
       values ($1, $2, $3, $4, $5, $6, to_timestamp($6 / 1000.0))
       on conflict (id) do update set
         chat_name = coalesce(excluded.chat_name, whatsapp_messages.chat_name),
         sender = coalesce(excluded.sender, whatsapp_messages.sender),
         body = excluded.body`,
      [message.id, message.chatId, message.chatName || null, message.sender || null, message.body, message.timestampMs],
    )
    saved++
  }

  return saved
}

export async function listWhatsAppMessages(chatIds = [], cutoffTimestampMs = 0) {
  if (!pool || !chatIds.length) return []
  await initPersistence()

  const result = await pool.query(
    `select id, chat_id, chat_name, sender, body, timestamp_ms
     from whatsapp_messages
     where chat_id = any($1::text[])
       and timestamp_ms > $2
       and body <> ''
     order by timestamp_ms asc`,
    [chatIds, cutoffTimestampMs],
  )

  return result.rows.map(row => ({
    id: row.id,
    chatId: row.chat_id,
    chatName: row.chat_name,
    from: row.sender || 'desconhecido',
    body: row.body,
    timestampMs: Number(row.timestamp_ms),
    timestamp: new Date(Number(row.timestamp_ms)).toLocaleString('pt-BR', { timeZone: 'America/Recife' }),
  }))
}

export async function getWhatsAppMessageStats(chatIds = []) {
  if (!pool || !chatIds.length) return new Map()
  await initPersistence()

  const result = await pool.query(
    `select chat_id, count(*)::int as message_count, max(timestamp_ms)::bigint as last_timestamp_ms
     from whatsapp_messages
     where chat_id = any($1::text[])
     group by chat_id`,
    [chatIds],
  )

  return new Map(result.rows.map(row => [row.chat_id, {
    messageCount: Number(row.message_count || 0),
    lastMessageAt: row.last_timestamp_ms ? new Date(Number(row.last_timestamp_ms)).toISOString() : null,
  }]))
}
