const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { loadTsModule } = require('./helpers/load-ts-module.cjs')

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notto-chat-meta-'))
const dbPath = path.join(userDataDir, 'chat_history.db')
const dbStores = new Map()

function getStore(filePath) {
  let store = dbStores.get(filePath)
  if (!store) {
    store = {
      tables: new Map(),
      autoIncrement: new Map()
    }
    dbStores.set(filePath, store)
  }
  return store
}

function ensureTable(store, name, columns) {
  if (!store.tables.has(name)) {
    store.tables.set(name, {
      columns: [...columns],
      rows: []
    })
  }
  const table = store.tables.get(name)
  for (const column of columns) {
    if (!table.columns.includes(column)) {
      table.columns.push(column)
      table.rows.forEach((row) => { row[column] = row[column] ?? null })
    }
  }
  return table
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim()
}

class FakeStatement {
  constructor(database, sql) {
    this.database = database
    this.sql = normalizeSql(sql)
  }

  run(...args) {
    return this.database.run(this.sql, args)
  }

  get(...args) {
    const rows = this.database.all(this.sql, args)
    return rows[0]
  }

  all(...args) {
    return this.database.all(this.sql, args)
  }
}

class FakeDatabase {
  constructor(filePath) {
    this.filePath = filePath
    this.store = getStore(filePath)
  }

  exec(sql) {
    const normalized = normalizeSql(sql)

    if (normalized.includes('CREATE TABLE chats')) {
      ensureTable(this.store, 'chats', ['id', 'title', 'created_at', 'updated_at'])
    }
    if (normalized.includes('CREATE TABLE messages')) {
      const columns = ['id', 'chat_id', 'role', 'content', 'timestamp']
      if (normalized.includes('meta_json')) columns.splice(4, 0, 'meta_json')
      ensureTable(this.store, 'messages', columns)
    }
    if (normalized.includes('CREATE TABLE attachments')) {
      const columns = ['id', 'message_id', 'chat_id', 'file_path', 'file_type', 'original_name', 'timestamp']
      if (normalized.includes('kind')) columns.splice(6, 0, 'kind', 'meta_json', 'sort_index', 'history_summary')
      ensureTable(this.store, 'attachments', columns)
    }
    if (normalized.includes('CREATE TABLE activity_logs')) {
      ensureTable(this.store, 'activity_logs', ['id', 'timestamp', 'text', 'icon', 'type', 'full_text', 'duration_seconds', 'created_at'])
    }
    if (normalized.includes('CREATE TABLE stats')) {
      ensureTable(this.store, 'stats', ['id', 'meetings_transcripted', 'words_dictated', 'total_dictation_time_seconds', 'updated_at'])
    }
    if (normalized.includes('CREATE TABLE IF NOT EXISTS trainer_analysis_cache')) {
      ensureTable(this.store, 'trainer_analysis_cache', ['note_id', 'note_mtime', 'analysis_json', 'updated_at'])
    }
    if (normalized.includes('ALTER TABLE stats ADD COLUMN ai_chats_prompts')) {
      ensureTable(this.store, 'stats', ['id'])
      ensureTable(this.store, 'stats', ['ai_chats_prompts'])
    }
    if (normalized.includes('ALTER TABLE messages ADD COLUMN meta_json')) {
      ensureTable(this.store, 'messages', ['id'])
      ensureTable(this.store, 'messages', ['meta_json'])
    }
    if (normalized.includes('ALTER TABLE attachments ADD COLUMN kind')) {
      ensureTable(this.store, 'attachments', ['id'])
      ensureTable(this.store, 'attachments', ['kind'])
    }
    if (normalized.includes('ALTER TABLE attachments ADD COLUMN meta_json')) {
      ensureTable(this.store, 'attachments', ['id'])
      ensureTable(this.store, 'attachments', ['meta_json'])
    }
    if (normalized.includes('ALTER TABLE attachments ADD COLUMN sort_index')) {
      ensureTable(this.store, 'attachments', ['id'])
      ensureTable(this.store, 'attachments', ['sort_index'])
    }
    if (normalized.includes('ALTER TABLE attachments ADD COLUMN history_summary')) {
      ensureTable(this.store, 'attachments', ['id'])
      ensureTable(this.store, 'attachments', ['history_summary'])
    }
    if (normalized.includes('CREATE TABLE IF NOT EXISTS metadata')) {
      ensureTable(this.store, 'metadata', ['key', 'value'])
    }
  }

  prepare(sql) {
    return new FakeStatement(this, sql)
  }

  transaction(fn) {
    return (...args) => fn(...args)
  }

  run(sql, args) {
    const normalized = normalizeSql(sql)

    if (normalized === 'INSERT INTO stats (id, meetings_transcripted, words_dictated, total_dictation_time_seconds, ai_chats_prompts, updated_at) VALUES (1, 0, 0, 0, 0, ?)') {
      const table = ensureTable(this.store, 'stats', ['id', 'meetings_transcripted', 'words_dictated', 'total_dictation_time_seconds', 'ai_chats_prompts', 'updated_at'])
      table.rows.push({ id: 1, meetings_transcripted: 0, words_dictated: 0, total_dictation_time_seconds: 0, ai_chats_prompts: 0, updated_at: args[0] })
      return { changes: 1 }
    }

    if (normalized.startsWith('CREATE TABLE IF NOT EXISTS metadata(')) {
      ensureTable(this.store, 'metadata', ['key', 'value'])
      return { changes: 0 }
    }

    if (normalized === 'INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)') {
      const table = ensureTable(this.store, 'chats', ['id', 'title', 'created_at', 'updated_at'])
      table.rows.push({ id: args[0], title: args[1], created_at: args[2], updated_at: args[3] })
      return { changes: 1 }
    }

    if (normalized === 'UPDATE chats SET title = ?, updated_at = ? WHERE id = ?') {
      const table = ensureTable(this.store, 'chats', ['id', 'title', 'created_at', 'updated_at'])
      const row = table.rows.find((item) => item.id === args[2])
      if (row) {
        row.title = args[0]
        row.updated_at = args[1]
      }
      return { changes: row ? 1 : 0 }
    }

    if (normalized === 'DELETE FROM messages WHERE chat_id = ?') {
      const table = ensureTable(this.store, 'messages', ['id', 'chat_id', 'role', 'content', 'meta_json', 'timestamp'])
      table.rows = table.rows.filter((row) => row.chat_id !== args[0])
      return { changes: 1 }
    }

    if (normalized === 'DELETE FROM attachments WHERE chat_id = ?') {
      const table = ensureTable(this.store, 'attachments', ['id', 'message_id', 'chat_id', 'file_path', 'file_type', 'original_name', 'kind', 'meta_json', 'sort_index', 'history_summary', 'timestamp'])
      table.rows = table.rows.filter((row) => row.chat_id !== args[0])
      return { changes: 1 }
    }

    if (normalized === 'INSERT INTO messages (chat_id, role, content, meta_json, timestamp) VALUES (?, ?, ?, ?, ?)') {
      const table = ensureTable(this.store, 'messages', ['id', 'chat_id', 'role', 'content', 'meta_json', 'timestamp'])
      const nextId = (this.store.autoIncrement.get('messages') || 0) + 1
      this.store.autoIncrement.set('messages', nextId)
      table.rows.push({
        id: nextId,
        chat_id: args[0],
        role: args[1],
        content: args[2],
        meta_json: args[3],
        timestamp: args[4]
      })
      return { lastInsertRowid: nextId, changes: 1 }
    }

    if (normalized === 'INSERT INTO attachments (id, message_id, chat_id, file_path, file_type, original_name, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)') {
      const table = ensureTable(this.store, 'attachments', ['id', 'message_id', 'chat_id', 'file_path', 'file_type', 'original_name', 'kind', 'meta_json', 'sort_index', 'history_summary', 'timestamp'])
      table.rows.push({
        id: args[0],
        message_id: Number(args[1]),
        chat_id: args[2],
        file_path: args[3],
        file_type: args[4],
        original_name: args[5],
        kind: null,
        meta_json: null,
        sort_index: null,
        history_summary: null,
        timestamp: args[6]
      })
      return { changes: 1 }
    }

    if (normalized === 'INSERT INTO attachments (id, message_id, chat_id, file_path, file_type, original_name, kind, meta_json, sort_index, history_summary, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)') {
      const table = ensureTable(this.store, 'attachments', ['id', 'message_id', 'chat_id', 'file_path', 'file_type', 'original_name', 'kind', 'meta_json', 'sort_index', 'history_summary', 'timestamp'])
      table.rows.push({
        id: args[0],
        message_id: Number(args[1]),
        chat_id: args[2],
        file_path: args[3],
        file_type: args[4],
        original_name: args[5],
        kind: args[6],
        meta_json: args[7],
        sort_index: args[8],
        history_summary: args[9],
        timestamp: args[10]
      })
      return { changes: 1 }
    }

    if (normalized === 'DELETE FROM chats WHERE id = ?') {
      const chats = ensureTable(this.store, 'chats', ['id', 'title', 'created_at', 'updated_at'])
      chats.rows = chats.rows.filter((row) => row.id !== args[0])
      ensureTable(this.store, 'messages', ['id', 'chat_id']).rows = ensureTable(this.store, 'messages', ['id', 'chat_id']).rows.filter((row) => row.chat_id !== args[0])
      ensureTable(this.store, 'attachments', ['id', 'chat_id']).rows = ensureTable(this.store, 'attachments', ['id', 'chat_id']).rows.filter((row) => row.chat_id !== args[0])
      return { changes: 1 }
    }

    if (normalized === 'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)') {
      const table = ensureTable(this.store, 'metadata', ['key', 'value'])
      const existing = table.rows.find((row) => row.key === args[0])
      if (existing) {
        existing.value = args[1]
      } else {
        table.rows.push({ key: args[0], value: args[1] })
      }
      return { changes: 1 }
    }

    if (normalized === 'INSERT OR REPLACE INTO trainer_analysis_cache(note_id, note_mtime, analysis_json, updated_at) VALUES(?, ?, ?, ?)') {
      const table = ensureTable(this.store, 'trainer_analysis_cache', ['note_id', 'note_mtime', 'analysis_json', 'updated_at'])
      const existing = table.rows.find((row) => row.note_id === args[0])
      if (existing) {
        existing.note_mtime = args[1]
        existing.analysis_json = args[2]
        existing.updated_at = args[3]
      } else {
        table.rows.push({
          note_id: args[0],
          note_mtime: args[1],
          analysis_json: args[2],
          updated_at: args[3]
        })
      }
      return { changes: 1 }
    }

    if (normalized === 'DELETE FROM trainer_analysis_cache WHERE note_id = ?') {
      const table = ensureTable(this.store, 'trainer_analysis_cache', ['note_id', 'note_mtime', 'analysis_json', 'updated_at'])
      table.rows = table.rows.filter((row) => row.note_id !== args[0])
      return { changes: 1 }
    }

    if (normalized === 'UPDATE trainer_analysis_cache SET note_id = ? WHERE note_id = ?') {
      const table = ensureTable(this.store, 'trainer_analysis_cache', ['note_id', 'note_mtime', 'analysis_json', 'updated_at'])
      const row = table.rows.find((item) => item.note_id === args[1])
      if (row) {
        row.note_id = args[0]
      }
      return { changes: row ? 1 : 0 }
    }

    throw new Error(`Unsupported run SQL in test fake: ${normalized}`)
  }

  all(sql, args) {
    const normalized = normalizeSql(sql)

    if (normalized === 'PRAGMA table_info(stats)') {
      return (ensureTable(this.store, 'stats', ['id']).columns || []).map((name) => ({ name }))
    }

    if (normalized === 'PRAGMA table_info(messages)') {
      return (ensureTable(this.store, 'messages', ['id']).columns || []).map((name) => ({ name }))
    }

    if (normalized === 'PRAGMA table_info(attachments)') {
      return (ensureTable(this.store, 'attachments', ['id']).columns || []).map((name) => ({ name }))
    }

    if (normalized === 'SELECT id FROM stats WHERE id = 1') {
      const row = ensureTable(this.store, 'stats', ['id']).rows.find((item) => item.id === 1)
      return row ? [{ id: row.id }] : []
    }

    if (normalized === 'SELECT id FROM chats WHERE id = ?') {
      const row = ensureTable(this.store, 'chats', ['id']).rows.find((item) => item.id === args[0])
      return row ? [{ id: row.id }] : []
    }

    if (normalized === 'SELECT value FROM metadata WHERE key = ?') {
      const row = ensureTable(this.store, 'metadata', ['key', 'value']).rows.find((item) => item.key === args[0])
      return row ? [{ value: row.value }] : []
    }

    if (normalized === 'SELECT note_id, note_mtime, analysis_json, updated_at FROM trainer_analysis_cache WHERE note_id = ?') {
      const row = ensureTable(this.store, 'trainer_analysis_cache', ['note_id', 'note_mtime', 'analysis_json', 'updated_at']).rows.find((item) => item.note_id === args[0])
      return row ? [{ ...row }] : []
    }

    if (normalized.includes('SELECT c.id, c.title, c.created_at, c.updated_at, c.updated_at as timestamp FROM chats c ORDER BY c.updated_at DESC LIMIT ? OFFSET ?')) {
      const limit = args[0]
      const offset = args[1]
      return [...ensureTable(this.store, 'chats', ['id', 'title', 'created_at', 'updated_at']).rows]
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(offset, offset + limit)
        .map((row) => ({ ...row, timestamp: row.updated_at }))
    }

    if (normalized === 'SELECT id, role, content, meta_json, timestamp FROM messages WHERE chat_id = ? ORDER BY timestamp ASC') {
      return [...ensureTable(this.store, 'messages', ['id', 'chat_id', 'role', 'content', 'meta_json', 'timestamp']).rows]
        .filter((row) => row.chat_id === args[0])
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(({ id, role, content, meta_json, timestamp }) => ({ id, role, content, meta_json, timestamp }))
    }

    if (normalized === 'SELECT * FROM chats WHERE id = ?') {
      const row = ensureTable(this.store, 'chats', ['id', 'title', 'created_at', 'updated_at']).rows.find((item) => item.id === args[0])
      return row ? [{ ...row }] : []
    }

    if (normalized === 'SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC') {
      return [...ensureTable(this.store, 'messages', ['id', 'chat_id', 'role', 'content', 'meta_json', 'timestamp']).rows]
        .filter((row) => row.chat_id === args[0])
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((row) => ({ ...row }))
    }

    if (normalized === 'SELECT * FROM attachments WHERE chat_id = ? ORDER BY sort_index ASC, timestamp ASC') {
      return [...ensureTable(this.store, 'attachments', ['id', 'message_id', 'chat_id', 'file_path', 'file_type', 'original_name', 'kind', 'meta_json', 'sort_index', 'history_summary', 'timestamp']).rows]
        .filter((row) => row.chat_id === args[0])
        .sort((a, b) => {
          const sortA = a.sort_index == null ? Number.MAX_SAFE_INTEGER : a.sort_index
          const sortB = b.sort_index == null ? Number.MAX_SAFE_INTEGER : b.sort_index
          return sortA - sortB || a.timestamp - b.timestamp
        })
        .map((row) => ({ ...row }))
    }

    throw new Error(`Unsupported all SQL in test fake: ${normalized}`)
  }
}

const legacyDb = new FakeDatabase(dbPath)
legacyDb.exec(`
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    timestamp INTEGER
  );
`)
legacyDb.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
  'legacy-chat',
  'Legacy Chat',
  1,
  2
)
legacyDb.store.tables.get('messages').rows.push({
  id: 1,
  chat_id: 'legacy-chat',
  role: 'user',
  content: 'Legacy message',
  timestamp: 10
})
legacyDb.store.autoIncrement.set('messages', 1)

const originalLoad = Module._load
Module._load = function mockModules(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath(name) {
          assert.equal(name, 'userData')
          return userDataDir
        }
      }
    }
  }

  if (request === 'better-sqlite3') {
    return FakeDatabase
  }

  return originalLoad.call(this, request, parent, isMain)
}

const { DatabaseManager } = loadTsModule(path.join(__dirname, '..', 'src', 'main', 'DatabaseManager.ts'))
Module._load = originalLoad

const manager = DatabaseManager.getInstance()

test('DatabaseManager migrates legacy messages table to include meta_json', () => {
  const messagesColumns = new FakeDatabase(dbPath).prepare('PRAGMA table_info(messages)').all()
  assert.ok(messagesColumns.some((column) => column.name === 'meta_json'))

  const legacyChat = manager.getChat('legacy-chat')
  assert.equal(legacyChat.ok, true)
  assert.equal(legacyChat.chat.messages.length, 1)
  assert.equal(legacyChat.chat.messages[0].content, 'Legacy message')
  assert.equal(legacyChat.chat.messages[0].noteMentions, undefined)
})

test('DatabaseManager round-trips note mentions alongside existing message attachments', () => {
  const noteMentions = [{ noteId: '2026-03-30 120000 - Roadmap.txt', label: 'Roadmap' }]
  const saveResult = manager.saveChat('notes-chat', 'Roadmap Chat', [
    {
      role: 'user',
      content: 'Summarize @[Roadmap]',
      timestamp: 100,
      noteMentions,
      screenshots: [
        {
          id: 'shot-1',
          filePath: '/tmp/notto-shot-1.png',
          timestamp: 101
        }
      ],
      attachments: [
        {
          id: 'attachment-1',
          name: 'roadmap.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 2048,
          kind: 'document',
          storagePath: '/tmp/roadmap.docx',
          promptText: 'Roadmap quarter overview',
          historySummary: 'Roadmap quarter overview',
          imageDataUrls: [],
          warnings: []
        }
      ]
    },
    {
      role: 'assistant',
      content: 'Here is the summary.',
      timestamp: 102
    }
  ])

  assert.equal(saveResult.ok, true)

  const chatResult = manager.getChat('notes-chat')
  assert.equal(chatResult.ok, true)
  assert.deepEqual(chatResult.chat.messages[0].noteMentions, noteMentions)
  assert.equal(chatResult.chat.messages[0].screenshots.length, 1)
  assert.equal(chatResult.chat.messages[0].screenshots[0].id, 'shot-1')
  assert.equal(chatResult.chat.messages[0].attachments.length, 1)
  assert.equal(chatResult.chat.messages[0].attachments[0].name, 'roadmap.docx')
  assert.equal(chatResult.chat.messages[0].attachments[0].historySummary, 'Roadmap quarter overview')

  const historyResult = manager.getHistory(10, 0)
  assert.equal(historyResult.ok, true)
  const savedChat = historyResult.chats.find((chat) => chat.id === 'notes-chat')
  assert.ok(savedChat)
  assert.deepEqual(savedChat.messages[0].noteMentions, noteMentions)
  assert.equal(savedChat.messages[0].content, 'Summarize @[Roadmap]')
  assert.equal(savedChat.messages[0].attachments.length, 1)
  assert.equal(savedChat.messages[0].attachments[0].mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
})

test('DatabaseManager stores, renames, and deletes trainer analysis cache entries', () => {
  const analysis = {
    headline: 'Keep answers tighter',
    summary: 'Good question usage overall.',
    strengths: ['Asks clarifying questions'],
    improvements: ['Reduce filler phrases'],
    drills: ['Summarize answers in one sentence']
  }

  const saveResult = manager.setTrainerAnalysisCache('2026-03-30 120000 - Roadmap.txt', 12345, analysis)
  assert.equal(saveResult.ok, true)

  const cached = manager.getTrainerAnalysisCache('2026-03-30 120000 - Roadmap.txt')
  assert.equal(cached.ok, true)
  assert.equal(cached.cache.noteMtime, 12345)
  assert.deepEqual(cached.cache.analysis, analysis)

  const renameResult = manager.renameTrainerAnalysisCache('2026-03-30 120000 - Roadmap.txt', '2026-03-30 120000 - Renamed.txt')
  assert.equal(renameResult.ok, true)
  assert.equal(manager.getTrainerAnalysisCache('2026-03-30 120000 - Roadmap.txt').cache, null)
  assert.deepEqual(manager.getTrainerAnalysisCache('2026-03-30 120000 - Renamed.txt').cache.analysis, analysis)

  const deleteResult = manager.deleteTrainerAnalysisCache('2026-03-30 120000 - Renamed.txt')
  assert.equal(deleteResult.ok, true)
  assert.equal(manager.getTrainerAnalysisCache('2026-03-30 120000 - Renamed.txt').cache, null)
})
