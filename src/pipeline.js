import 'dotenv/config'
import { fetchRecentMessages, fetchSelfMessages } from './whatsappClient.js'
import { extractTasks } from './taskExtractor.js'
import { findAgentForTask, createAgentForTask } from './agentManager.js'
import { addRunToHistory } from './runHistory.js'

const HOURS_LOOKBACK = parseInt(process.env.HOURS_LOOKBACK || '12')

// Fontes configuradas: 2 grupos de escola, 1 de igreja, esposa, pastor e o próprio usuário
function getSources() {
  return [
    { envKey: 'GROUP_ESCOLA_1',   label: 'Grupo Escola (Ecilda Ramos)',       default: 'Ecilda Ramos 2026' },
    { envKey: 'GROUP_ESCOLA_2',   label: 'Grupo Escola (Professores)',         default: 'Professores - Tiradentes' },
    { envKey: 'GROUP_IGREJA',     label: 'Grupo Igreja',                       default: 'Ministro e Obreiros IIGD BV' },
    { envKey: 'CONTACT_ESPOSA',   label: 'Esposa (Rafaelly)',                  default: 'Rafaelly' },
    { envKey: 'CONTACT_PASTOR',   label: 'PR Josehilton',                      default: 'PR Josehilton' },
    { envKey: 'CONTACT_EU',       label: 'Meus recados',                       default: '__self__' },
  ]
}

export async function runPipeline() {
  console.log(`\n[Pipeline] Iniciando execução — ${new Date().toLocaleString('pt-BR')}`)

  const summary = {
    timestamp: new Date().toISOString(),
    sources: [],
    totalTasks: 0,
    newAgents: [],
    existingAgents: [],
  }

  for (const source of getSources()) {
    const chatName = process.env[source.envKey] || source.default
    const isSelf = chatName === '__self__'
    console.log(`[Pipeline] Lendo "${isSelf ? 'Meus recados' : chatName}"...`)

    let messages = []
    try {
      messages = isSelf
        ? await fetchSelfMessages(HOURS_LOOKBACK)
        : await fetchRecentMessages(chatName, HOURS_LOOKBACK)
      console.log(`[Pipeline] ${messages.length} mensagens encontradas em "${isSelf ? 'Meus recados' : chatName}"`)
    } catch (err) {
      console.warn(`[Pipeline] Erro ao ler "${chatName}":`, err.message)
      summary.sources.push({ name: chatName, error: err.message, tasks: [] })
      continue
    }

    if (!messages.length) {
      summary.sources.push({ name: isSelf ? 'Meus recados' : chatName, tasks: [] })
      continue
    }

    const tasks = await extractTasks(messages, source.label)
    console.log(`[Pipeline] ${tasks.length} tarefas extraídas de "${chatName}"`)

    const sourceSummary = { name: isSelf ? 'Meus recados' : chatName, tasks: [] }

    for (const task of tasks) {
      summary.totalTasks++
      const existing = findAgentForTask(task)

      if (existing) {
        console.log(`[Pipeline] Agente existente para "${task.titulo}": ${existing.name}`)
        sourceSummary.tasks.push({ ...task, agent_status: 'existing', agent_name: existing.name })
        summary.existingAgents.push({ task: task.titulo, agent: existing.name })
      } else {
        console.log(`[Pipeline] Criando novo agente para "${task.titulo}"...`)
        const newAgent = await createAgentForTask(task)
        if (newAgent) {
          sourceSummary.tasks.push({ ...task, agent_status: 'created', agent_name: newAgent.name })
          summary.newAgents.push({ task: task.titulo, agent: newAgent.name, file: newAgent.file })
        } else {
          sourceSummary.tasks.push({ ...task, agent_status: 'failed' })
        }
      }
    }

    summary.sources.push(sourceSummary)
  }

  await addRunToHistory(summary)
  await sendTelegramSummary(summary)

  console.log(`[Pipeline] Concluído. ${summary.totalTasks} tarefas | ${summary.newAgents.length} agentes criados`)
  return summary
}

async function sendTelegramSummary(summary) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return

  const newAgentLines = summary.newAgents.map(a => `  🆕 "${a.task}" → agente criado: ${a.agent}`).join('\n')
  const existingLines = summary.existingAgents.map(a => `  ✅ "${a.task}" → ${a.agent}`).join('\n')

  const text = `📋 *Resumo WhatsApp Monitor*
${new Date(summary.timestamp).toLocaleString('pt-BR')}

*Total de tarefas:* ${summary.totalTasks}
*Agentes criados:* ${summary.newAgents.length}
*Agentes existentes usados:* ${summary.existingAgents.length}

${summary.newAgents.length ? `*Novos agentes:*\n${newAgentLines}` : ''}
${summary.existingAgents.length ? `*Tratados por agentes existentes:*\n${existingLines}` : ''}
${summary.totalTasks === 0 ? '_Nenhuma tarefa encontrada neste período_' : ''}`

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  }).catch(err => console.warn('[Pipeline] Erro ao enviar Telegram:', err.message))
}
