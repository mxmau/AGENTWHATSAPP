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

  initialized = true
  console.log('[Persistence] Banco conectado')
  return true
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

