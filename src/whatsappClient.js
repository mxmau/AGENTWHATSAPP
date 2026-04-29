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
  const chat = findChatByName(chatName)

  if (!chat) {
    console.warn(`[WhatsApp] Chat não encontrado: "${chatName}"`)
    return []
  }

  return extractMessagesFromStore(chat.id, cutoff, getChatDisplayName(chat))
}

/**
 * Busca mensagens do próprio usuário (Recados / Salvos)
 */
export async function fetchSelfMessages(hoursBack = 12) {
  if (!sock || clientStatus !== 'ready') {
    throw new Error('WhatsApp não está conectado')
  }

  await waitForWarmup()

  const me = sock.user?.id
  if (!me) return []

  const cutoff = Math.floor((Date.now() - hoursBack * 3600 * 1000) / 1000)
  return extractMessagesFromStore(me, cutoff, 'Meus recados')
}

function findChatByName(chatName) {
  const needle = chatName.toLowerCase()
  return [...chats.values()].find(chat => getChatDisplayName(chat).toLowerCase().includes(needle))
    || [...contacts.values()].find(contact => getContactDisplayName(contact).toLowerCase().includes(needle))
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
