import { GoogleGenerativeAI } from '@google/generative-ai'

function parseJSON(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/)
  const raw = match ? (match[1] || match[0]) : text
  return JSON.parse(raw.trim())
}

function isRetryableLLMError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  const status = Number(error?.status || error?.statusCode || error?.cause?.status || 0)
  return status === 429
    || status === 408
    || status >= 500
    || message.includes('429')
    || message.includes('quota')
    || message.includes('rate limit')
    || message.includes('resource_exhausted')
    || message.includes('temporarily')
    || message.includes('overloaded')
}

function getLLMProviders() {
  return [
    {
      name: 'gemini',
      enabled: Boolean(process.env.GEMINI_API_KEY),
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      generate: generateWithGemini,
    },
    {
      name: 'groq',
      enabled: Boolean(process.env.GROQ_API_KEY),
      model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
      generate: prompt => generateOpenAICompatible({
        providerName: 'groq',
        apiKey: process.env.GROQ_API_KEY,
        baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
        model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
        prompt,
      }),
    },
    {
      name: 'openrouter',
      enabled: Boolean(process.env.OPENROUTER_API_KEY),
      model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free',
      generate: prompt => generateOpenAICompatible({
        providerName: 'openrouter',
        apiKey: process.env.OPENROUTER_API_KEY,
        baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
        model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free',
        prompt,
        headers: {
          'HTTP-Referer': process.env.APP_URL || 'https://agentwhatsapp.onrender.com',
          'X-Title': 'AGENTWHATSAPP',
        },
      }),
    },
    {
      name: 'openai',
      enabled: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      generate: prompt => generateOpenAICompatible({
        providerName: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: 'https://api.openai.com/v1/chat/completions',
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        prompt,
      }),
    },
  ].filter(provider => provider.enabled)
}

async function generateWithGemini(prompt) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' })
  const result = await model.generateContent(prompt)
  return result.response.text()
}

async function generateOpenAICompatible({ providerName, apiKey, baseUrl, model, prompt, headers = {} }) {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'responda somente com JSON válido, sem markdown e sem comentários' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  })

  const body = await response.text()
  if (!response.ok) {
    const error = new Error(`${providerName} retornou ${response.status}: ${body.slice(0, 500)}`)
    error.status = response.status
    throw error
  }

  const parsed = JSON.parse(body)
  return parsed.choices?.[0]?.message?.content || ''
}

async function generateWithFallback(prompt, purpose) {
  const providers = getLLMProviders()
  if (!providers.length) {
    throw new Error('nenhuma chave de LLM configurada')
  }

  const errors = []
  for (const provider of providers) {
    try {
      console.log(`[LLM] Tentando ${purpose} com ${provider.name}/${provider.model}`)
      const text = await provider.generate(prompt)
      console.log(`[LLM] ${purpose} concluído com ${provider.name}/${provider.model}`)
      return { text, provider: provider.name, model: provider.model }
    } catch (error) {
      const retryable = isRetryableLLMError(error)
      const message = error?.message || String(error)
      console.warn(`[LLM] Falha em ${provider.name}/${provider.model}: ${message}`)
      errors.push(`${provider.name}: ${message}`)
      if (!retryable) {
        console.warn(`[LLM] Erro não temporário em ${provider.name}; tentando próximo provedor configurado mesmo assim`)
      }
    }
  }

  throw new Error(`todos os provedores de LLM falharam: ${errors.join(' | ')}`)
}

function buildTaskExtractionPrompt(messages, sourceLabel) {
  const transcript = messages
    .map(m => `[${m.timestamp}] ${m.from}: ${m.body}`)
    .join('\n')

  return `Você é um classificador rigoroso de tarefas em conversas de WhatsApp.
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
8. Quando alguém declarar uma dor, dificuldade, desorganização, incômodo, gargalo ou desejo de melhorar algo, transforme isso em uma tarefa implícita e sugira um agente de apoio.
9. Frases como "está uma bagunça", "não estou dando conta", "seria bom", "preciso melhorar", "queria um jeito", "tá difícil", "não consigo organizar", "estou perdido" indicam necessidade e devem virar tarefa.
10. Não extraia saudações, agradecimentos, conversas soltas, memes, confirmações sem ação ou mensagens puramente informativas sem necessidade de acompanhamento.
11. Se alguém disser que falta um material, post, aula, documento, resposta ou entrega, isso é tarefa mesmo sem usar a palavra "faça".

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
- "meu horário tá uma bagunça, seria bom que eu pudesse organizar ele" -> tarefa tipo "organização", agente_sugerido "Agente Organizador de Horários".
- "não estou dando conta das tarefas da escola" -> tarefa tipo "organização", agente_sugerido "Agente Gestor de Tarefas Escolares".
- "queria um jeito de controlar melhor os compromissos da igreja" -> tarefa tipo "organização", agente_sugerido "Agente de Compromissos da Igreja".
- "Falta o post da quarta feira igreja de joelhos família de pé" -> tarefa tipo "design", agente_sugerido "Agente de Posts da Igreja".
- "Falta da sexta feira curso fé" -> tarefa tipo "design", agente_sugerido "Agente de Posts da Igreja".

EXEMPLOS DO QUE NÃO DEVE VIRAR TAREFA:
- "bom dia".
- "ok".
- "kkkk".
- "obrigado".
- notícia sem pedido de ação.
- "Tem outros detalhes", "Mas depois lhe conto", "Peguei o aeroporto agora", "Estamos indo pra macaxeira", "Tá certo", "Te amo".

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
      "tipo": "criar_agente|design|lembrete|resposta|acao|evento|compra|documento|aula|pesquisa|analise|organizacao|outro",
      "agente_sugerido": "nome descritivo de um agente que poderia resolver isso automaticamente",
      "evidencia": "trecho curto da mensagem que justificou a tarefa"
    }
  ]
}

Se tiver dúvida entre extrair ou ignorar, extraia quando houver verbo de ação ou intenção clara.
Se não houver tarefas, retorne {"tasks": []}.`
}

/**
 * Extrai tarefas de mensagens usando provedores LLM com fallback.
 */
export async function extractTasks(messages, sourceLabel) {
  if (!messages.length) return []

  const prompt = buildTaskExtractionPrompt(messages, sourceLabel)

  try {
    const result = await generateWithFallback(prompt, 'extração de tarefas')
    const parsed = parseJSON(result.text)
    return (parsed.tasks || []).map(t => ({ ...t, fonte: sourceLabel, llm_provider: result.provider, llm_model: result.model }))
  } catch (e) {
    console.error('[TaskExtractor] Erro ao extrair tarefas:', e.message)
    return []
  }
}

/**
 * Gera configuração de um novo agente para uma tarefa usando provedores LLM com fallback.
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
    const result = await generateWithFallback(prompt, 'geração de agente')
    return parseJSON(result.text)
  } catch (e) {
    console.error('[TaskExtractor] Erro ao gerar agente:', e.message)
    return null
  }
}
