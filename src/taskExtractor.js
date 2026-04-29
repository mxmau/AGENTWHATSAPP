import { GoogleGenerativeAI } from '@google/generative-ai'

function getModel() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  return genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
}

function parseJSON(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/)
  const raw = match ? (match[1] || match[0]) : text
  return JSON.parse(raw.trim())
}

/**
 * Extrai tarefas de mensagens usando Gemini
 */
export async function extractTasks(messages, sourceLabel) {
  if (!messages.length) return []

  const transcript = messages
    .map(m => `[${m.timestamp}] ${m.from}: ${m.body}`)
    .join('\n')

  const prompt = `Você é um assistente especializado em identificar tarefas, compromissos, pedidos e ações necessárias em conversas de WhatsApp.
Analise as mensagens e extraia apenas itens que requerem ação concreta.
Responda SOMENTE com JSON válido, sem texto antes ou depois.

Analise as mensagens abaixo do "${sourceLabel}" e extraia todas as tarefas, compromissos, pedidos e ações necessárias.

MENSAGENS:
${transcript}

Responda com JSON no formato:
{
  "tasks": [
    {
      "titulo": "título curto da tarefa",
      "descricao": "descrição detalhada do que precisa ser feito",
      "prioridade": "alta|media|baixa",
      "prazo": "data/hora se mencionado, ou null",
      "origem": "nome de quem pediu ou mencionou",
      "tipo": "lembrete|resposta|acao|evento|compra|outro",
      "agente_sugerido": "nome descritivo de um agente que poderia resolver isso automaticamente"
    }
  ]
}

Se não houver tarefas, retorne {"tasks": []}.`

  try {
    const model = getModel()
    const result = await model.generateContent(prompt)
    const text = result.response.text()
    const parsed = parseJSON(text)
    return (parsed.tasks || []).map(t => ({ ...t, fonte: sourceLabel }))
  } catch (e) {
    console.error('[TaskExtractor] Erro ao extrair tarefas:', e.message)
    return []
  }
}

/**
 * Gera configuração de um novo agente para uma tarefa usando Gemini
 */
export async function generateAgentForTask(task) {
  const prompt = `Você é um arquiteto de automações do Bud. Gere configurações completas e prontas para uso.
Responda SOMENTE com JSON válido, sem texto antes ou depois.

Crie um agente de automação para resolver a seguinte tarefa recorrente:

Tarefa: ${task.titulo}
Descrição: ${task.descricao}
Tipo: ${task.tipo}
Prioridade: ${task.prioridade}
Fonte: ${task.fonte}

Gere um agente no formato:
{
  "name": "nome do agente",
  "summary": "o que este agente faz em uma linha",
  "prompt": "instrução detalhada para o agente executar esta tarefa automaticamente",
  "schedule": "cron expression sugerida (ex: 0 9 * * 1-5)",
  "timezone": "America/Recife",
  "delivery": ["telegram"],
  "reasoning": "por que este agente é útil para esta tarefa"
}`

  try {
    const model = getModel()
    const result = await model.generateContent(prompt)
    const text = result.response.text()
    return parseJSON(text)
  } catch (e) {
    console.error('[TaskExtractor] Erro ao gerar agente:', e.message)
    return null
  }
}
