import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import type { NoteMention } from '../shared/noteMentions';
import type { ChatAttachment, ChatAttachmentKind } from '../shared/chatAttachments';

interface MessageMeta {
  noteMentions?: NoteMention[]
}

interface AttachmentMeta {
  kind?: ChatAttachmentKind
  mimeType?: string
  size?: number
  promptText?: string
  warnings?: string[]
  imageDataUrls?: string[]
  blocked?: boolean
}

export class DatabaseManager {
  private db: Database.Database;
  private static instance: DatabaseManager;

  private constructor() {
    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'chat_history.db');
    const attachmentsDir = path.join(userDataPath, 'attachments');

    // Ensure attachments directory exists
    if (!fs.existsSync(attachmentsDir)) {
      fs.mkdirSync(attachmentsDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initSchema();
    this.migrateFromJsonFiles(userDataPath);
  }

  public static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        meta_json TEXT,
        timestamp INTEGER,
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id INTEGER,
        chat_id TEXT,
        file_path TEXT,
        file_type TEXT,
        original_name TEXT,
        kind TEXT,
        meta_json TEXT,
        sort_index INTEGER,
        history_summary TEXT,
        timestamp INTEGER,
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        text TEXT NOT NULL,
        icon TEXT,
        type TEXT DEFAULT 'other',
        full_text TEXT,
        duration_seconds INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );

      CREATE TABLE IF NOT EXISTS stats (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        meetings_transcripted INTEGER DEFAULT 0,
        words_dictated INTEGER DEFAULT 0,
        total_dictation_time_seconds INTEGER DEFAULT 0,
        ai_chats_prompts INTEGER DEFAULT 0,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS trainer_analysis_cache (
        note_id TEXT PRIMARY KEY,
        note_mtime INTEGER NOT NULL,
        analysis_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_logs_timestamp ON activity_logs(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_logs_type ON activity_logs(type);
      CREATE INDEX IF NOT EXISTS idx_trainer_analysis_updated_at ON trainer_analysis_cache(updated_at DESC);
    `);

    // Migrate existing stats table to add ai_chats_prompts column if it doesn't exist
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(stats)").all() as { name: string }[];
      const hasAiChatsPrompts = tableInfo.some(col => col.name === 'ai_chats_prompts');
      if (!hasAiChatsPrompts) {
        this.db.exec("ALTER TABLE stats ADD COLUMN ai_chats_prompts INTEGER DEFAULT 0");
      }
    } catch { /* Ignore if already exists or table doesn't exist yet */ }

    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
      const hasMetaJson = tableInfo.some(col => col.name === 'meta_json');
      if (!hasMetaJson) {
        this.db.exec("ALTER TABLE messages ADD COLUMN meta_json TEXT");
      }
    } catch { /* Ignore if already exists or table doesn't exist yet */ }

    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(attachments)").all() as { name: string }[];
      if (!tableInfo.some(col => col.name === 'kind')) {
        this.db.exec("ALTER TABLE attachments ADD COLUMN kind TEXT");
      }
      if (!tableInfo.some(col => col.name === 'meta_json')) {
        this.db.exec("ALTER TABLE attachments ADD COLUMN meta_json TEXT");
      }
      if (!tableInfo.some(col => col.name === 'sort_index')) {
        this.db.exec("ALTER TABLE attachments ADD COLUMN sort_index INTEGER");
      }
      if (!tableInfo.some(col => col.name === 'history_summary')) {
        this.db.exec("ALTER TABLE attachments ADD COLUMN history_summary TEXT");
      }
    } catch { /* Ignore attachment migration errors */ }

    // Ensure stats row exists
    const statsRow = this.db.prepare('SELECT id FROM stats WHERE id = 1').get();
    if (!statsRow) {
      this.db.prepare('INSERT INTO stats (id, meetings_transcripted, words_dictated, total_dictation_time_seconds, ai_chats_prompts, updated_at) VALUES (1, 0, 0, 0, 0, ?)').run(Date.now());
    }
  }

  public saveChat(chatId: string, title: string, messages: any[]) {
    const now = Date.now();

    const transaction = this.db.transaction(() => {
      // Upsert chat
      const existingChat = this.db.prepare('SELECT id FROM chats WHERE id = ?').get(chatId);
      if (existingChat) {
        this.db.prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?').run(title, now, chatId);
      } else {
        this.db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(chatId, title, now, now);
      }

      // Delete existing messages for this chat to avoid duplicates/complex syncing
      // (Simple approach: replace all messages. For huge chats, we might want to optimize this later)
      this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
      this.db.prepare('DELETE FROM attachments WHERE chat_id = ?').run(chatId);

      const insertMessage = this.db.prepare('INSERT INTO messages (chat_id, role, content, meta_json, timestamp) VALUES (?, ?, ?, ?, ?)');
      const insertAttachment = this.db.prepare(`
        INSERT INTO attachments (id, message_id, chat_id, file_path, file_type, original_name, kind, meta_json, sort_index, history_summary, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const msg of messages) {
        const metaJson = this.serializeMessageMeta(msg)
        const result = insertMessage.run(chatId, msg.role, msg.content, metaJson, msg.timestamp);
        const messageId = result.lastInsertRowid;

        if (msg.screenshots && Array.isArray(msg.screenshots)) {
          msg.screenshots.forEach((screenshot: any, index: number) => {
            // If we have base64 data (from migration or new capture), save it to disk
            let filePath = screenshot.filePath;
            if (screenshot.base64Data) {
              const fileName = `screenshot_${screenshot.id}_${Date.now()}.png`;
              const fullPath = path.join(app.getPath('userData'), 'attachments', fileName);
              fs.writeFileSync(fullPath, Buffer.from(screenshot.base64Data, 'base64'));
              filePath = fullPath;
            }

            insertAttachment.run(
              screenshot.id,
              messageId,
              chatId,
              filePath,
              'image',
              'screenshot.png',
              null,
              null,
              index,
              null,
              screenshot.timestamp
            );
          })
        }

        if (Array.isArray(msg.attachments)) {
          msg.attachments.forEach((attachment: ChatAttachment, index: number) => {
            insertAttachment.run(
              attachment.id,
              messageId,
              chatId,
              attachment.storagePath,
              attachment.mimeType || attachment.kind,
              attachment.name,
              attachment.kind,
              this.serializeAttachmentMeta(attachment),
              index,
              attachment.historySummary || '',
              msg.timestamp
            )
          })
        }
      }
    });

    transaction();


    return { ok: true };
  }

  public getHistory(limit = 50, offset = 0) {
    const chats = this.db.prepare(`
      SELECT 
        c.id,
        c.title,
        c.created_at,
        c.updated_at,
        c.updated_at as timestamp
      FROM chats c
      ORDER BY c.updated_at DESC 
      LIMIT ? OFFSET ?
    `).all(limit, offset) as any[];

    if (chats.length === 0) {
      return { ok: true, chats: [] };
    }

    // Prepare the messages lookup statement once to avoid recompiling it for each chat
    // This reduces SQL statement preparation overhead when loading large chat histories
    const getMessagesStmt = this.db.prepare(`
      SELECT id, role, content, meta_json, timestamp
      FROM messages
      WHERE chat_id = ?
      ORDER BY timestamp ASC
    `);
    const getAttachmentsStmt = this.db.prepare(`
      SELECT *
      FROM attachments
      WHERE chat_id = ?
      ORDER BY sort_index ASC, timestamp ASC
    `)

    // For each chat, get the messages
    const chatsWithMessages = chats.map(chat => {
      const messages = getMessagesStmt.all(chat.id);
      const attachments = getAttachmentsStmt.all(chat.id)

      return {
        ...chat,
        messages: this.attachAttachmentsToMessages(messages || [], attachments || [])
      };
    });

    return { ok: true, chats: chatsWithMessages };
  }

  public getChat(chatId: string) {
    const chat = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId) as any;
    if (!chat) return { ok: false, message: 'Chat not found' };

    const messages = this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC').all(chatId);
    const attachments = this.db.prepare('SELECT * FROM attachments WHERE chat_id = ? ORDER BY sort_index ASC, timestamp ASC').all(chatId);
    const messagesWithAttachments = this.attachAttachmentsToMessages(messages, attachments);

    return { ok: true, chat: { ...chat, messages: messagesWithAttachments } };
  }

  public deleteChat(chatId: string) {
    // Attachments on disk should be deleted too, but for now we just delete DB records
    // ON DELETE CASCADE handles messages and attachments tables
    this.db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);


    return { ok: true };
  }

  public searchChats(query: string) {
    const results = this.db.prepare(`
      SELECT DISTINCT c.id, c.title, c.updated_at 
      FROM chats c
      JOIN messages m ON m.chat_id = c.id
      WHERE m.content LIKE ? OR c.title LIKE ?
      ORDER BY c.updated_at DESC
      LIMIT 20
    `).all(`%${query}%`, `%${query}%`);
    return { ok: true, results };
  }

  private serializeAttachmentMeta(attachment: ChatAttachment): string | null {
    const meta: AttachmentMeta = {
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      size: attachment.size,
      promptText: attachment.promptText,
      warnings: Array.isArray(attachment.warnings) ? attachment.warnings : [],
      imageDataUrls: Array.isArray(attachment.imageDataUrls) ? attachment.imageDataUrls : [],
      blocked: !!attachment.blocked
    }

    return JSON.stringify(meta)
  }

  private parseAttachmentMeta(metaJson: unknown): AttachmentMeta {
    if (typeof metaJson !== 'string' || !metaJson.trim()) {
      return {}
    }

    try {
      const parsed = JSON.parse(metaJson)
      return {
        kind: typeof parsed?.kind === 'string' ? parsed.kind as ChatAttachmentKind : undefined,
        mimeType: typeof parsed?.mimeType === 'string' ? parsed.mimeType : undefined,
        size: typeof parsed?.size === 'number' ? parsed.size : undefined,
        promptText: typeof parsed?.promptText === 'string' ? parsed.promptText : undefined,
        warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.filter((warning: any) => typeof warning === 'string') : [],
        imageDataUrls: Array.isArray(parsed?.imageDataUrls) ? parsed.imageDataUrls.filter((url: any) => typeof url === 'string') : [],
        blocked: !!parsed?.blocked
      }
    } catch {
      return {}
    }
  }

  private attachAttachmentsToMessages(messages: any[], attachmentRows: any[]) {
    return messages.map((message: any) => {
      const hydrated = this.hydrateMessage(message)
      const rows = attachmentRows.filter((attachment) => attachment.message_id === message.id)
      if (rows.length === 0) {
        return hydrated
      }

      const screenshots = rows
        .filter((row) => !row.meta_json && !row.kind && !row.history_summary)
        .map((row) => ({
          id: row.id,
          filePath: row.file_path,
          timestamp: row.timestamp
        }))

      const attachments = rows
        .filter((row) => row.meta_json || row.kind || row.history_summary)
        .map((row) => {
          const meta = this.parseAttachmentMeta(row.meta_json)
          return {
            id: row.id,
            name: row.original_name || 'Attachment',
            mimeType: meta.mimeType || row.file_type || '',
            size: meta.size || 0,
            kind: meta.kind || 'document',
            storagePath: row.file_path || '',
            promptText: meta.promptText || '',
            historySummary: row.history_summary || '',
            imageDataUrls: meta.imageDataUrls || [],
            warnings: meta.warnings || [],
            blocked: !!meta.blocked
          } satisfies ChatAttachment
        })

      return {
        ...hydrated,
        ...(screenshots.length > 0 ? { screenshots } : {}),
        ...(attachments.length > 0 ? { attachments } : {})
      }
    })
  }

  private serializeMessageMeta(message: any): string | null {
    const noteMentions = Array.isArray(message?.noteMentions)
      ? message.noteMentions
        .filter((mention: any) => mention?.noteId && mention?.label)
        .map((mention: any) => ({ noteId: String(mention.noteId), label: String(mention.label) }))
      : []

    if (noteMentions.length === 0) return null
    return JSON.stringify({ noteMentions } satisfies MessageMeta)
  }

  private parseMessageMeta(metaJson: unknown): MessageMeta {
    if (typeof metaJson !== 'string' || !metaJson.trim()) {
      return {}
    }

    try {
      const parsed = JSON.parse(metaJson)
      const noteMentions = Array.isArray(parsed?.noteMentions)
        ? parsed.noteMentions
          .filter((mention: any) => mention?.noteId && mention?.label)
          .map((mention: any) => ({ noteId: String(mention.noteId), label: String(mention.label) }))
        : []

      return noteMentions.length > 0 ? { noteMentions } : {}
    } catch {
      return {}
    }
  }

  private hydrateMessage(message: any) {
    const meta = this.parseMessageMeta(message?.meta_json)
    const hydrated = {
      ...message,
      ...(meta.noteMentions?.length ? { noteMentions: meta.noteMentions } : {})
    }
    delete hydrated.meta_json
    return hydrated
  }

  // Activity logs methods
  public getActivityLogs(limit = 100, offset = 0) {
    const logs = this.db.prepare(`
    SELECT * FROM activity_logs 
      ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
      `).all(limit, offset);
    return { ok: true, logs };
  }

  public addActivityLog(log: { text: string; icon: string; type?: string; fullText?: string; durationSeconds?: number }) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO activity_logs(timestamp, text, icon, type, full_text, duration_seconds, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(now, log.text, log.icon, log.type || 'other', log.fullText || log.text, log.durationSeconds || null, now);
    return { ok: true };
  }

  public deleteActivityLog(timestamp: number) {
    this.db.prepare('DELETE FROM activity_logs WHERE timestamp = ?').run(timestamp);
    return { ok: true };
  }

  // Stats methods
  public getStats() {
    let stats = this.db.prepare('SELECT * FROM stats WHERE id = 1').get() as any;
    if (!stats) {
      // Initialize stats if not exists
      this.db.prepare(`
        INSERT INTO stats(id, meetings_transcripted, words_dictated, total_dictation_time_seconds, updated_at)
    VALUES(1, 0, 0, 0, ?)
      `).run(Date.now());
      stats = { id: 1, meetings_transcripted: 0, words_dictated: 0, total_dictation_time_seconds: 0, updated_at: Date.now() };
    }
    return {
      ok: true,
      stats: {
        meetingsTranscripted: stats.meetings_transcripted,
        wordsDictated: stats.words_dictated,
        totalDictationTimeSeconds: stats.total_dictation_time_seconds,
        aiChatsPrompts: stats.ai_chats_prompts || 0
      }
    };
  }

  public updateStats(update: { wordsDictated?: number; dictationTimeSeconds?: number; meetingsTranscripted?: number; aiChatsPrompts?: number }) {
    const current = this.getStats();
    if (!current.ok || !current.stats) {
      return { ok: false, message: 'Failed to get current stats' };
    }

    const newStats = {
      meetings_transcripted: (current.stats.meetingsTranscripted || 0) + (update.meetingsTranscripted || 0),
      words_dictated: (current.stats.wordsDictated || 0) + (update.wordsDictated || 0),
      total_dictation_time_seconds: (current.stats.totalDictationTimeSeconds || 0) + (update.dictationTimeSeconds || 0),
      ai_chats_prompts: (current.stats.aiChatsPrompts || 0) + (update.aiChatsPrompts || 0),
      updated_at: Date.now()
    };


    this.db.prepare(`
      UPDATE stats 
      SET meetings_transcripted = ?, words_dictated = ?, total_dictation_time_seconds = ?, ai_chats_prompts = ?, updated_at = ?
      WHERE id = 1
        `).run(newStats.meetings_transcripted, newStats.words_dictated, newStats.total_dictation_time_seconds, newStats.ai_chats_prompts, newStats.updated_at);

    const resultStats = {
      meetingsTranscripted: newStats.meetings_transcripted,
      wordsDictated: newStats.words_dictated,
      totalDictationTimeSeconds: newStats.total_dictation_time_seconds,
      aiChatsPrompts: newStats.ai_chats_prompts
    };


    return {
      ok: true,
      stats: resultStats
    };
  }

  public resetStats() {
    this.db.prepare(`
      UPDATE stats 
      SET meetings_transcripted = 0, words_dictated = 0, total_dictation_time_seconds = 0, ai_chats_prompts = 0, updated_at = ?
      WHERE id = 1
        `).run(Date.now());

    return this.getStats();
  }

  public getTrainerAnalysisCache(noteId: string) {
    const row = this.db.prepare('SELECT note_id, note_mtime, analysis_json, updated_at FROM trainer_analysis_cache WHERE note_id = ?').get(noteId) as any;
    if (!row) {
      return { ok: true, cache: null };
    }

    try {
      return {
        ok: true,
        cache: {
          noteId: row.note_id,
          noteMtime: row.note_mtime,
          analysis: JSON.parse(row.analysis_json),
          updatedAt: row.updated_at
        }
      };
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) };
    }
  }

  public setTrainerAnalysisCache(noteId: string, noteMtime: number, analysis: unknown) {
    const now = Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO trainer_analysis_cache(note_id, note_mtime, analysis_json, updated_at)
      VALUES(?, ?, ?, ?)
    `).run(noteId, noteMtime, JSON.stringify(analysis), now);

    return { ok: true, updatedAt: now };
  }

  public deleteTrainerAnalysisCache(noteId: string) {
    this.db.prepare('DELETE FROM trainer_analysis_cache WHERE note_id = ?').run(noteId);
    return { ok: true };
  }

  public renameTrainerAnalysisCache(noteId: string, nextId: string) {
    this.db.prepare('UPDATE trainer_analysis_cache SET note_id = ? WHERE note_id = ?').run(nextId, noteId);
    return { ok: true };
  }

  private migrateFromJsonFiles(userDataPath: string) {
    try {
      // Create metadata table if it doesn't exist (must be first)
      this.db.prepare(`
        CREATE TABLE IF NOT EXISTS metadata(
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `).run();

      // Check if migration has already been done
      const migrationFlag = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('json_migration_done') as any;
      if (migrationFlag?.value === '1') {
        return; // Already migrated
      }

      // Migrate activity logs
      const activityLogsPath = path.join(userDataPath, 'activity_logs.json');
      if (fs.existsSync(activityLogsPath)) {
        try {
          const data = fs.readFileSync(activityLogsPath, 'utf8');
          const logs = JSON.parse(data);

          if (Array.isArray(logs) && logs.length > 0) {
            const stmt = this.db.prepare(`
              INSERT INTO activity_logs(timestamp, text, icon, type, full_text, duration_seconds, created_at)
              VALUES(?, ?, ?, ?, ?, ?, ?)
            `);

            for (const log of logs) {
              stmt.run(
                log.timestamp || Date.now(),
                log.text || '',
                log.icon || '📝',
                log.type || 'other',
                log.fullText || log.text || '',
                log.durationSeconds || null,
                log.timestamp || Date.now()
              );
            }
          }
          // Delete the old JSON file after successful migration
          fs.unlinkSync(activityLogsPath);
        } catch (e: any) {
          console.error('Failed to migrate activity logs:', e.message);
        }
      }

      // Migrate stats
      const statsPath = path.join(userDataPath, 'stats.json');
      if (fs.existsSync(statsPath)) {
        try {
          const data = fs.readFileSync(statsPath, 'utf8');
          const stats = JSON.parse(data);

          this.db.prepare(`
            INSERT OR REPLACE INTO stats(id, meetings_transcripted, words_dictated, total_dictation_time_seconds, updated_at)
            VALUES(1, ?, ?, ?, ?)
          `).run(
            stats.meetingsTranscripted || 0,
            stats.wordsDictated || 0,
            stats.totalDictationTimeSeconds || 0,
            Date.now()
          );
          // Delete the old JSON file after successful migration
          fs.unlinkSync(statsPath);
        } catch (e: any) {
          console.error('Failed to migrate stats:', e.message);
        }
      }

      // Mark migration as complete
      this.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('json_migration_done', '1');

    } catch (e: any) {
      console.error('Migration error:', e.message);
    }
  }
}
