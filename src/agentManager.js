import fs from 'fs'
import path from 'path'
import { generateAgentForTask } from './taskExtractor.js'
import { restoreDirectory, saveTextFile } from './persistence.js'

const AGENTS_DIR = path.resolve('generated-agents')

export function ensureAgentsDir() {
  if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true })
}

export async function restoreAgentsDir() {
  ensureAgentsDir()
  await restoreDirectory(AGENTS_DIR, 'generated-agents')
}

export function listExistingAgents() {
  ensureAgentsDir()
  return fs.readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'))
        return { file: f, ...data }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/**
 * Verifica se já existe um agente que cobre uma tarefa pelo tipo/descrição
 */
export function findAgentForTask(task) {
  const agents = listExistingAgents()
  const keywords = [task.tipo, task.titulo, task.agente_sugerido]
    .filter(Boolean)
    .map(k => k.toLowerCase())

  return agents.find(agent => {
    const agentText = `${agent.name} ${agent.summary} ${agent.prompt}`.toLowerCase()
    return keywords.some(kw => agentText.includes(kw.split(' ')[0]))
  }) || null
}

/**
 * Cria e salva um novo agente para uma tarefa
 */
export async function createAgentForTask(task) {
  const config = await generateAgentForTask(task)
  if (!config) return null

  const slug = config.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const filename = `${slug}-${Date.now()}.json`
  const filepath = path.join(AGENTS_DIR, filename)

  const fullConfig = {
    ...config,
    created_at: new Date().toISOString(),
    created_from: task.titulo,
    fonte: task.fonte,
  }

  fs.writeFileSync(filepath, JSON.stringify(fullConfig, null, 2))
  await saveTextFile(`generated-agents/${filename}`, JSON.stringify(fullConfig, null, 2))
  console.log(`[AgentManager] Novo agente criado: ${filename}`)
  return { file: filename, ...fullConfig }
}
