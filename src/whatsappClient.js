import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode'
import { EventEmitter } from 'events'
import path from 'path'
import pino from 'pino'
import { getWhatsAppMessageStats, listWhatsAppMessages, restoreDirectory, saveDirectory, saveWhatsAppMessages } from './persistence.js'

export const clientEvents = new EventEmitter()

const AUTH_DIR = path.resolve('auth_info_baileys')
const logger = pino({ level: 'silent' })
const MAX_MESSAGES_PER_CHAT = 500

let sock = null
let clientStatus = 'initializing'
let qrDataUrl = null
let readyAt = null
const chats = new Map()
const contacts = new Map()
const messagesByChat = new Map()

export function getQR() { return qrDataUrl }
export function getStatus() { return clientStatus }

export async function initWhatsApp() {
  await restoreDirectory(AUTH_DIR, 'baileys-auth')

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    browser: ['Agent Monitor', 'Chrome', '120.0'],
    syncFullHistory: true,
    getMessage: async () => undefined,
  })

  bindStoreEvents(sock)

  sock.ev.on('creds.update', async () => {
    await saveCreds()
    await saveDirectory(AUTH_DIR, 'baileys-auth')
  })

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      clientStatus = 'qr'
      qrDataUrl = await qrcode.toDataURL(qr)
      clientEvents.emit('qr', qrDataUrl)
      console.log('[WhatsApp] QR code gerado')
    }

    if (connection === 'open') {
      clientStatus = 'ready'
      readyAt = Date.now()
      qrDataUrl = null
      clientEvents.emit('ready')
      await refreshGroupCache()
      await saveDirectory(AUTH_DIR, 'baileys-auth')
      console.log('[WhatsApp] Conectado e pronto')
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true

      if (shouldReconnect) {
        clientStatus = 'reconnecting'
        console.log('[WhatsApp] Reconectando...')
        setTimeout(() => initWhatsApp(), 5000)
      } else {
        clientStatus = 'disconnected'
        clientEvents.emit('disconnected', 'logged out')
        console.warn('[WhatsApp] Desconectado (logout). Escaneie o QR novamente.')
      }
    }
  })

  return sock
}

export async function refreshGroupCache() {
  if (!sock?.groupFetchAllParticipating) return

  try {
    const groups = await sock.groupFetchAllParticipating()
    const groupChats = Object.values(groups || {}).map(group => ({
      id: group.id,
      name: group.subject,
      subject: group.subject,
    }))
    upsertChats(groupChats)
    console.log(`[WhatsApp] Cache de grupos atualizado: ${groupChats.length} grupos`)
  } catch (err) {
    console.warn('[WhatsApp] Não foi possível atualizar cache de grupos:', err.message)
  }
}

function bindStoreEvents(socket) {
  socket.ev.on('messaging-history.set', ({ chats: historyChats, contacts: historyContacts, messages }) => {
    upsertChats(historyChats)
    upsertContacts(historyContacts)
    upsertMessages(messages)
    console.log(`[WhatsApp] Histórico sincronizado: ${historyChats?.length || 0} chats, ${messages?.length || 0} mensagens`)
  })

  socket.ev.on('chats.upsert', upsertChats)
  socket.ev.on('chats.update', upsertChats)
  socket.ev.on('contacts.upsert', upsertContacts)
  socket.ev.on('contacts.update', upsertContacts)
  socket.ev.on('messages.upsert', ({ messages }) => upsertMessages(messages))
}

function upsertChats(items = []) {
  for (const chat of items) {
    if (!chat?.id) continue
    const existing = chats.get(chat.id) || {}
    chats.set(chat.id, { ...existing, ...chat })
  }
}

function upsertContacts(items = []) {
  for (const contact of items) {
    if (!contact?.id) continue
    const existing = contacts.get(contact.id) || {}
    contacts.set(contact.id, { ...existing, ...contact })
  }
}

function upsertMessages(items = []) {
  const normalizedMessages = []

  for (const message of items) {
    const chatId = message?.key?.remoteJid
    if (!chatId) continue

    upsertMessageContact(message)

    const list = messagesByChat.get(chatId) || []
    const messageId = message.key?.id
    if (!messageId || !list.some(item => item.key?.id === messageId)) {
      list.push(message)
      list.sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0))
      if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT)
      messagesByChat.set(chatId, list)
    }

    if (!chats.has(chatId)) chats.set(chatId, { id: chatId })

    const normalizedMessage = normalizeMessageForPersistence(message)
    if (normalizedMessage) normalizedMessages.push(normalizedMessage)
  }

  if (normalizedMessages.length) {
    saveWhatsAppMessages(normalizedMessages)
      .then(count => console.log(`[WhatsApp] ${count} mensagens persistidas no banco`))
      .catch(err => console.warn('[WhatsApp] Erro ao persistir mensagens:', err.message))
  }
}


function normalizeMessageForPersistence(message) {
  const chatId = message?.key?.remoteJid
  const messageId = message?.key?.id
  const body = getMessageBody(message).trim()
  const timestampMs = Number(message?.messageTimestamp || 0) * 1000
  if (!chatId || !messageId || !body || !timestampMs) return null

  return {
    id: `${chatId}:${messageId}`,
    chatId,
    chatName: getChatDisplayName(chats.get(chatId) || { id: chatId }),
    sender: getSenderName(message),
    body,
    timestampMs,
  }
}

function upsertMessageContact(message) {
  const remoteJid = message?.key?.remoteJid
  const participant = message?.key?.participant
  const pushName = String(message?.pushName || '').trim()
  if (!pushName) return

  for (const id of [remoteJid, participant].filter(Boolean)) {
    if (id.endsWith('@g.us')) continue
    const existing = contacts.get(id) || { id }
    contacts.set(id, { ...existing, name: existing.name || pushName, notify: existing.notify || pushName })
  }
}

const WARMUP_MS = 8000

async function waitForWarmup() {
  if (!readyAt) throw new Error('WhatsApp não está conectado')
  const elapsed = Date.now() - readyAt
  if (elapsed < WARMUP_MS) {
    const wait = WARMUP_MS - elapsed
    console.log(`[WhatsApp] Aguardando warmup (${Math.ceil(wait / 1000)}s)...`)
    await new Promise(r => setTimeout(r, wait))
  }
}

/**
 * Busca mensagens recentes por id exato do chat. Esta é a forma oficial e segura.
 */
export async function fetchRecentMessagesById(chatId, sourceName, hoursBack = 12) {
  if (!sock || clientStatus !== 'ready') {
    throw new Error('WhatsApp não está conectado')
  }

  await waitForWarmup()

  const normalizedChatId = String(chatId || '').trim()
  const cutoff = Math.floor((Date.now() - hoursBack * 3600 * 1000) / 1000)
  const candidate = getChatCandidateById(normalizedChatId)

  if (!candidate) {
    console.warn(`[WhatsApp] Chat id não encontrado para "${sourceName}": ${normalizedChatId}`)
    return {
      messages: [],
      status: 'id_not_found',
      source: sourceName,
      matchedChat: null,
      chatId: normalizedChatId,
      candidates: [],
    }
  }

  const messages = await extractMessagesForChat(candidate.id, cutoff, candidate.displayName)
  console.log(`[WhatsApp] Chat lido por id para "${sourceName}": "${candidate.displayName}" | mensagens ${messages.length} | id ${candidate.id}`)
  logCandidateMessages(sourceName, candidate.displayName, messages)

  return {
    messages,
    status: messages.length ? 'ok' : 'empty_window',
    source: sourceName,
    matchedChat: candidate.displayName,
    chatId: candidate.id,
    matchMode: 'id',
  }
}

/**
 * Busca mensagens recentes pelo nome somente quando o resultado é claramente único.
 */
export async function fetchRecentMessages(chatName, hoursBack = 12) {
  if (!sock || clientStatus !== 'ready') {
    throw new Error('WhatsApp não está conectado')
  }

  await waitForWarmup()

  const cutoff = Math.floor((Date.now() - hoursBack * 3600 * 1000) / 1000)
  const match = findChatByName(chatName)
  const selected = match?.selectedCandidate

  if (!selected) {
    const status = match?.ambiguous ? 'ambiguous' : 'not_found'
    const reason = match?.ambiguous ? 'candidatos ambíguos' : 'chat não encontrado'
    console.warn(`[WhatsApp] ${reason}: "${chatName}"`)
    console.warn(`[WhatsApp] Candidatos para "${chatName}": ${formatChatCandidates(match?.candidates || [])}`)

    const diagnosticCandidates = await readDiagnosticCandidateMessages(chatName, match?.candidates || [], cutoff)
    return {
      messages: [],
      status,
      source: chatName,
      matchedChat: null,
      chatId: null,
      candidates: match?.candidates || [],
      scannedCandidates: diagnosticCandidates,
      reason,
    }
  }

  const messages = await extractMessagesForChat(selected.id, cutoff, selected.displayName)
  console.log(`[WhatsApp] Chat lido para "${chatName}": "${selected.displayName}" | score ${selected.score} | mensagens ${messages.length} | id ${selected.id}`)
  logCandidateMessages(chatName, selected.displayName, messages)

  return {
    messages,
    status: messages.length ? 'ok' : 'empty_window',
    source: chatName,
    matchedChat: selected.displayName,
    chatId: selected.id,
    score: selected.score,
    matchMode: 'safe-name',
    candidates: match.candidates,
    scannedCandidates: [{
      name: selected.displayName,
      id: selected.id,
      score: selected.score,
      messages: messages.length,
    }],
  }
}

export async function diagnoseChatCandidates(chatName, hoursBack = 12) {
  if (!sock || clientStatus !== 'ready') {
    throw new Error('WhatsApp não está conectado')
  }

  await waitForWarmup()

  const cutoff = Math.floor((Date.now() - hoursBack * 3600 * 1000) / 1000)
  const match = findChatByName(chatName)
  return {
    query: chatName,
    candidates: await readDiagnosticCandidateMessages(chatName, match?.candidates || [], cutoff),
  }
}

export async function listKnownChats({ query = '', limit = 30, includeMessages = false, hoursBack = 12 } = {}) {
  const needle = normalizeSearchText(query)
  const cutoff = Math.floor((Date.now() - hoursBack * 3600 * 1000) / 1000)
  const candidates = buildChatSearchCandidates()
  const stats = await getWhatsAppMessageStats(candidates.map(candidate => candidate.id))
  const allCandidates = candidates
    .map(candidate => {
      const memoryCount = (messagesByChat.get(candidate.id) || []).length
      const persistedStats = stats.get(candidate.id) || {}
      return {
        id: candidate.id,
        name: candidate.displayName,
        isGroup: candidate.id.includes('@g.us'),
        messageCount: Math.max(memoryCount, persistedStats.messageCount || 0),
        lastMessageAt: persistedStats.lastMessageAt || getLastMessageAt(candidate.id),
        score: needle ? scoreChatCandidate(needle, tokenizeSearchText(query), candidate) : 0,
      }
    })
    .filter(candidate => !needle || candidate.score > 0)
    .sort((a, b) => (b.score - a.score) || (new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0)))
    .slice(0, Number(limit) || 30)

  if (!includeMessages) return allCandidates

  return Promise.all(allCandidates.map(async candidate => ({
    ...candidate,
    recentMessages: (await extractMessagesForChat(candidate.id, cutoff, candidate.name)).slice(-10),
  })))
}

function logCandidateMessages(sourceName, candidateName, messages) {
  if (!messages.length) {
    console.log(`[Mensagem/Candidato] ${sourceName} | ${candidateName} | nenhuma mensagem dentro da janela`)
    return
  }

  const limit = parseInt(process.env.LOG_CANDIDATE_MESSAGE_LIMIT || '20')
  for (const message of messages.slice(0, limit)) {
    const body = String(message.body || '').replace(/\s+/g, ' ').trim()
    const preview = body.length > 240 ? `${body.slice(0, 240)}...` : body
    console.log(`[Mensagem/Candidato] ${sourceName} | ${candidateName} | ${message.timestamp} | ${message.from}: ${preview}`)
  }

  if (messages.length > limit) {
    console.log(`[Mensagem/Candidato] ${sourceName} | ${candidateName} | mais ${messages.length - limit} mensagens ocultas no preview`)
  }
}

/**
 * Busca mensagens do próprio usuário (Recados / Salvos)
 */
export async function fetchSelfMessages(hoursBack = 12) {
  if (!sock || clientStatus !== 'ready') {
    throw new Error('WhatsApp não está conectado')
  }

  await waitForWarmup()

  const cutoff = Math.floor((Date.now() - hoursBack * 3600 * 1000) / 1000)
  const selfCandidates = getSelfChatCandidates()
  const messagesByCandidate = await Promise.all(selfCandidates.map(candidate => extractMessagesForChat(candidate.id, cutoff, candidate.name)))
  const messages = messagesByCandidate.flat()

  const uniqueMessages = new Map()
  for (const message of messages) {
    uniqueMessages.set(`${message.timestamp}:${message.from}:${message.body}`, message)
  }

  if (!uniqueMessages.size) {
    console.warn(`[WhatsApp] Nenhuma mensagem encontrada em Meus recados. Candidatos testados: ${selfCandidates.map(candidate => candidate.id).join(', ') || 'nenhum'}`)
  }

  const dedupedMessages = [...uniqueMessages.values()].sort((a, b) => a.timestampMs - b.timestampMs)
  return {
    messages: dedupedMessages,
    status: dedupedMessages.length ? 'ok' : 'empty_window',
    source: 'Meus recados',
    matchedChat: selfCandidates.map(candidate => candidate.name).filter(Boolean).join(', ') || 'Meus recados',
    chatId: selfCandidates.map(candidate => candidate.id).join(', '),
  }
}

function getSelfChatCandidates() {
  const candidates = new Map()
  const userId = sock.user?.id
  const lid = sock.user?.lid
  const jid = sock.user?.jid
  const decodedUser = userId?.split(':')[0]?.split('@')[0]

  function addCandidate(id, name = 'Meus recados') {
    if (id) candidates.set(id, { id, name })
  }

  for (const id of [userId, lid, jid, decodedUser && `${decodedUser}@s.whatsapp.net`]) {
    addCandidate(id)
  }

  for (const chat of chats.values()) {
    const displayName = getChatDisplayName(chat).toLowerCase()
    const isSelfByName = ['recados', 'meus recados', 'message yourself', 'you', 'você'].some(label => displayName.includes(label))
    const isSelfById = [userId, lid, jid].filter(Boolean).includes(chat.id)
    const hasOwnNumber = decodedUser && chat.id.includes(decodedUser)

    if (isSelfByName || isSelfById || hasOwnNumber) {
      addCandidate(chat.id, getChatDisplayName(chat) || 'Meus recados')
    }
  }

  for (const contact of contacts.values()) {
    const displayName = getContactDisplayName(contact).toLowerCase()
    const isSelfByName = ['recados', 'meus recados', 'message yourself', 'you', 'você'].some(label => displayName.includes(label))
    const isSelfById = [userId, lid, jid].filter(Boolean).includes(contact.id)
    const hasOwnNumber = decodedUser && contact.id.includes(decodedUser)

    if (isSelfByName || isSelfById || hasOwnNumber) {
      addCandidate(contact.id, getContactDisplayName(contact) || 'Meus recados')
    }
  }

  for (const chatId of messagesByChat.keys()) {
    const isSelfById = [userId, lid, jid].filter(Boolean).includes(chatId)
    const hasOwnNumber = decodedUser && chatId.includes(decodedUser)

    if (isSelfById || hasOwnNumber) {
      addCandidate(chatId)
    }
  }

  return [...candidates.values()]
}


function getChatCandidateById(chatId) {
  if (!chatId) return null
  const chat = chats.get(chatId)
  const contact = contacts.get(chatId)
  const hasMessages = messagesByChat.has(chatId)

  if (!chat && !contact && !hasMessages) return null

  const displayName = getChatDisplayName(chat || {}) || getContactDisplayName(contact || {}) || chatId
  return {
    id: chatId,
    chat: chat || { id: chatId },
    displayName,
    searchable: buildSearchableText(displayName, chatId),
  }
}

async function readDiagnosticCandidateMessages(sourceName, candidates, cutoff) {
  const limit = parseInt(process.env.DIAGNOSTIC_CANDIDATE_LIMIT || '8')

  return Promise.all(candidates.slice(0, limit).map(async candidate => {
    const messages = await extractMessagesForChat(candidate.id, cutoff, candidate.name)
    console.log(`[WhatsApp/Diagnóstico] ${sourceName} | candidato "${candidate.name}" | score ${candidate.score} | mensagens ${messages.length} | id ${candidate.id}`)
    logCandidateMessages(sourceName, candidate.name, messages)
    return {
      name: candidate.name,
      id: candidate.id,
      score: candidate.score,
      messages: messages.length,
      recentMessages: messages.slice(-10),
    }
  }))
}

function getLastMessageAt(chatId) {
  const list = messagesByChat.get(chatId) || []
  const last = list[list.length - 1]
  if (!last?.messageTimestamp) return null
  return new Date(Number(last.messageTimestamp) * 1000).toISOString()
}

function findChatByName(chatName) {
  const needle = normalizeSearchText(chatName)
  const needleTokens = tokenizeSearchText(chatName)
  const candidates = buildChatSearchCandidates()
    .map(candidate => ({ ...candidate, score: scoreChatCandidate(needle, needleTokens, candidate) }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score)

  const best = candidates[0]
  const second = candidates[1]
  const minimumScore = 90
  const isExact = best && normalizeSearchText(best.displayName) === needle
  const isClearWinner = best?.score >= minimumScore && (!second || best.score - second.score >= 40)
  const selectedCandidate = (isExact || isClearWinner) ? best : null

  return {
    chat: selectedCandidate?.chat || null,
    score: best?.score || 0,
    selectedCandidate,
    ambiguous: Boolean(best && !selectedCandidate),
    candidates: candidates.slice(0, 8).map(candidate => ({
      name: candidate.displayName,
      id: candidate.id,
      score: candidate.score,
      isGroup: candidate.id.includes('@g.us'),
    })),
  }
}

function buildChatSearchCandidates() {
  const byId = new Map()

  for (const chat of chats.values()) {
    const displayName = getChatDisplayName(chat)
    byId.set(chat.id, { id: chat.id, chat, displayName, searchable: buildSearchableText(displayName, chat.id) })
  }

  for (const contact of contacts.values()) {
    const existing = byId.get(contact.id) || { id: contact.id, chat: { id: contact.id }, displayName: '', searchable: '' }
    const displayName = existing.displayName || getContactDisplayName(contact)
    byId.set(contact.id, {
      ...existing,
      displayName,
      searchable: buildSearchableText(displayName, contact.id),
    })
  }

  for (const chatId of messagesByChat.keys()) {
    if (!byId.has(chatId)) {
      byId.set(chatId, { id: chatId, chat: { id: chatId }, displayName: chatId, searchable: buildSearchableText(chatId, chatId) })
    }
  }

  return [...byId.values()].filter(candidate => candidate.displayName)
}

function scoreChatCandidate(needle, needleTokens, candidate) {
  const haystack = candidate.searchable
  const haystackTokens = tokenizeSearchText(candidate.displayName)
  let score = 0

  if (!needle || !haystack) return 0
  if (haystack === needle) score += 120
  if (haystack.includes(needle)) score += 90
  if (needle.includes(haystack)) score += 70

  const matchedTokens = needleTokens.filter(token => haystackTokens.includes(token) || haystack.includes(token))
  score += matchedTokens.length * 45

  if (matchedTokens.length > 0) score += 25

  if (needleTokens.length && matchedTokens.length === needleTokens.length) score += 35
  if (needleTokens.length > 1 && matchedTokens.length >= Math.ceil(needleTokens.length / 2)) score += 20
  if (candidate.id.includes('@g.us')) score += 5

  return score
}

function formatChatCandidates(candidates) {
  if (!candidates.length) return 'nenhum candidato encontrado no cache de chats'
  return candidates.map(candidate => `"${candidate.name}" (${candidate.score})`).join('; ')
}

function buildSearchableText(...values) {
  return values.map(normalizeSearchText).filter(Boolean).join(' ')
}

function tokenizeSearchText(value) {
  return normalizeSearchText(value).split(' ').filter(token => token.length >= 2 || /^\d+$/.test(token))
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getChatDisplayName(chat) {
  if (!chat) return ''
  const contact = contacts.get(chat.id)
  return chat.name || chat.subject || getContactDisplayName(contact) || chat.id || ''
}

function getContactDisplayName(contact) {
  if (!contact) return ''
  return contact.name || contact.notify || contact.verifiedName || contact.id || ''
}

function extractMessagesFromStore(chatId, cutoffTimestamp, chatName) {
  const msgs = messagesByChat.get(chatId) || []

  return msgs
    .filter(message => {
      const ts = Number(message.messageTimestamp || 0)
      const body = getMessageBody(message)
      return ts > cutoffTimestamp && body.trim()
    })
    .map(message => ({
      from: getSenderName(message),
      body: getMessageBody(message),
      timestampMs: Number(message.messageTimestamp) * 1000,
      timestamp: new Date(Number(message.messageTimestamp) * 1000).toLocaleString('pt-BR', { timeZone: 'America/Recife' }),
      chatName,
    }))
}

async function extractMessagesForChat(chatId, cutoffTimestamp, chatName) {
  const cutoffTimestampMs = cutoffTimestamp * 1000
  const persistedMessages = await listWhatsAppMessages([chatId], cutoffTimestampMs)
  const memoryMessages = extractMessagesFromStore(chatId, cutoffTimestamp, chatName)
  const uniqueMessages = new Map()

  for (const message of [...persistedMessages, ...memoryMessages]) {
    uniqueMessages.set(`${message.timestampMs}:${message.from}:${message.body}`, {
      ...message,
      chatName: message.chatName || chatName,
    })
  }

  return [...uniqueMessages.values()].sort((a, b) => a.timestampMs - b.timestampMs)
}

function getSenderName(message) {
  const participant = message.key?.participant || message.key?.remoteJid
  return message.pushName || contacts.get(participant)?.name || contacts.get(participant)?.notify || participant || 'desconhecido'
}

function getMessageBody(message) {
  const msg = message.message || {}
  return msg.conversation
    || msg.extendedTextMessage?.text
    || msg.imageMessage?.caption
    || msg.videoMessage?.caption
    || msg.documentMessage?.caption
    || ''
}
