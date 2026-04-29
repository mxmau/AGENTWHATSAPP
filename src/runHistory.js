import fs from 'fs'
import path from 'path'
import { loadTextFile, saveTextFile } from './persistence.js'

const HISTORY_FILE = path.resolve('run-history.json')
const MAX_RUNS = 50

export function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return []
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
  } catch {
    return []
  }
}

export async function loadHistoryAsync() {
  const persisted = await loadTextFile('run-history.json')
  if (persisted) {
    try {
      return JSON.parse(persisted)
    } catch {
      return []
    }
  }

  return loadHistory()
}

export async function addRunToHistory(summary) {
  const history = await loadHistoryAsync()
  history.unshift(summary)
  if (history.length > MAX_RUNS) history.splice(MAX_RUNS)
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2))
  await saveTextFile('run-history.json', JSON.stringify(history, null, 2))
}
