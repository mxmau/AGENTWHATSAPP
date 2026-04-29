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

  const prompt = `Você é um classificador rigoroso de tarefas em conversas de WhatsApp.
Seu trabalho é transformar mensagens em tarefas acionáveis para um sistema que cria ou aciona agentes automáticos.
Responda SOMENTE com JSON válido, sem texto antes ou depois.

CRITÉRIOS PARA EXTRAIR UMA TAREFA:
1. Extraia quando houver pedido, intenção, ordem, lembrete, compromisso, problema a resolver ou algo que exija próxima ação.
2. Extraia mesmo que não exista prazo explícito.
3. Extraia mensagens escritas pelo próprio usuário para si mesmo, pois elas geralmente são comandos ou lembretes.
4. Extraia pedidos de criação de agentes, automações, materiais, respostas, designs, documentos, aulas, listas, pesquisas ou análises.
5. Se a mensagem disser "preciso", "preciso preparar", "tenho que", "vou precisar", "quero", "criar", "fazer", "resolver", "lembrar", "avisar", "preparar", "montar", "gerar", "analisar", "responder", "comprar", "marcar" ou equivalente, trate como tarefa.
6. Em grupos, extraia tarefas que pareçam relevantes para o usuário, escola, igreja, família ou trabalho.
7. Quando alguém expressar uma necessidade, extraia a tarefa implícita e sugira um agente que facilitaria aquilo, mesmo que a pessoa não peça explicitamente "crie um agente".
8. Não extraia saudações, agradecimentos, conversas soltas, memes, confirmações sem ação ou mensagens puramente informativas sem necessidade de acompanhamento.

EXEMPLOS DO QUE DEVE VIRAR TAREFA:
- "criar um agente de design" -> tarefa tipo "criar_agente", prioridade média, agente_sugerido "Agente de Design".
- "me lembre de levar o material amanhã" -> tarefa tipo "lembrete".
- "precisamos mandar a atividade até sexta" -> tarefa tipo "acao" com prazo sexta.
- "faz uma arte para o culto" -> tarefa tipo "design".
- "responder a professora sobre a reunião" -> tarefa tipo "resposta".
- "preciso preparar uma atividade sobre frações" -> tarefa tipo "aula", agente_sugerido "Agente Preparador de Atividades".
- "vou precisar organizar a escala dos obreiros" -> tarefa tipo "documento", agente_sugerido "Agente Organizador de Escalas".
- "quero montar uma apresentação para domingo" -> tarefa tipo "design" ou "documento", agente_sugerido "Agente de Apresentações".
- "tenho que analisar essas mensagens depois" -> tarefa tipo "analise", agente_sugerido "Agente Analista de Mensagens".

EXEMPLOS DO QUE NÃO DEVE VIRAR TAREFA:
- "bom dia".
- "ok".
- "kkkk".
- "obrigado".
- notícia sem pedido de ação.

Analise as mensagens abaixo do "${sourceLabel}" e extraia todas as tarefas acionáveis.

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
      "tipo": "criar_agente|design|lembrete|resposta|acao|evento|compra|documento|aula|pesquisa|analise|outro",
      "agente_sugerido": "nome descritivo de um agente que poderia resolver isso automaticamente",
      "evidencia": "trecho curto da mensagem que justificou a tarefa"
    }
  ]
}

Se tiver dúvida entre extrair ou ignorar, extraia quando houver verbo de ação ou intenção clara.
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
