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
import { restoreDirectory, saveDirectory } from './persistence.js'

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
  for (const message of items) {
    const chatId = message?.key?.remoteJid
    if (!chatId) continue

    const list = messagesByChat.get(chatId) || []
    const messageId = message.key?.id
    if (messageId && list.some(item => item.key?.id === messageId)) continue

    list.push(message)
    list.sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0))
    if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT)
    messagesByChat.set(chatId, list)

    if (!chats.has(chatId)) chats.set(chatId, { id: chatId })
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
 * Busca mensagens recentes de um chat pelo nome (busca parcial)
 */
export async function fetchRecentMessages(chatName, hoursBack = 12) {
  if (!sock || clientStatus !== 'ready') {
    throw new Error('WhatsApp não está conectado')
  }

  await waitForWarmup()

  const cutoff = Math.floor((Date.now() - hoursBack * 3600 * 1000) / 1000)
  const match = findChatByName(chatName)
  const chat = match?.chat

  if (!chat) {
    console.warn(`[WhatsApp] Chat não encontrado: "${chatName}"`)
    console.warn(`[WhatsApp] Candidatos parecidos para "${chatName}": ${formatChatCandidates(match?.candidates || [])}`)
    return {
      messages: [],
      status: 'not_found',
      source: chatName,
      matchedChat: null,
      chatId: null,
      candidates: match?.candidates || [],
    }
  }

  const messages = extractMessagesFromStore(chat.id, cutoff, getChatDisplayName(chat))
  console.log(`[WhatsApp] Chat encontrado para "${chatName}": "${getChatDisplayName(chat)}" | score ${match.score} | id ${chat.id}`)
  return {
    messages,
    status: messages.length ? 'ok' : 'empty_window',
    source: chatName,
    matchedChat: getChatDisplayName(chat),
    chatId: chat.id,
    score: match.score,
    candidates: match.candidates,
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
  const messages = selfCandidates.flatMap(candidate => extractMessagesFromStore(candidate.id, cutoff, candidate.name))

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

function findChatByName(chatName) {
  const needle = normalizeSearchText(chatName)
  const needleTokens = tokenizeSearchText(chatName)
  const candidates = buildChatSearchCandidates()
    .map(candidate => ({ ...candidate, score: scoreChatCandidate(needle, needleTokens, candidate) }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score)

  const best = candidates[0]
  const minimumScore = needleTokens.length > 1 ? 45 : 30
  return {
    chat: best?.score >= minimumScore ? best.chat : null,
    score: best?.score || 0,
    candidates: candidates.slice(0, 8).map(candidate => ({
      name: candidate.displayName,
      id: candidate.id,
      score: candidate.score,
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
  score += matchedTokens.length * 22

  if (needleTokens.length && matchedTokens.length === needleTokens.length) score += 35
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
  return normalizeSearchText(value).split(' ').filter(token => token.length >= 2)
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
      timestamp: new Date(Number(message.messageTimestamp) * 1000).toLocaleString('pt-BR'),
      chatName,
    }))
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
