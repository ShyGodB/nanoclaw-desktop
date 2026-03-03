import fs from 'fs';
import path from 'path';

import { Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  stripTopicSuffix,
} from '../types.js';

/** Build a JID that encodes the topic thread_id when present. */
function buildTopicJid(chatId: number, threadId?: number): string {
  return threadId !== undefined ? `tg:${chatId}/${threadId}` : `tg:${chatId}`;
}

/** Extract numeric chat ID and optional thread_id from a composite JID. */
function parseTopicJid(jid: string): { chatId: string; threadId: number | undefined } {
  const raw = jid.replace(/^tg:/, '');
  const slashIdx = raw.indexOf('/');
  if (slashIdx !== -1) {
    return {
      chatId: raw.slice(0, slashIdx),
      threadId: parseInt(raw.slice(slashIdx + 1), 10),
    };
  }
  return { chatId: raw, threadId: undefined };
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onMigrateGroup?: (oldJid: string, newJid: string) => void;
}

/** Buffered message waiting to be dispatched (for media group batching). */
interface PendingMessage {
  chatJid: string;
  timestamp: string;
  msg: import('../types.js').NewMessage;
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  prefixAssistantName = false;

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  /** Buffer for media group messages: media_group_id → pending messages + debounce timer. */
  private mediaGroupBuffer = new Map<string, { items: PendingMessage[]; timer: NodeJS.Timeout }>();
  private static MEDIA_GROUP_DEBOUNCE_MS = 1500;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Buffer a message that belongs to a media group. After no new messages arrive
   * for MEDIA_GROUP_DEBOUNCE_MS, flush all buffered messages at once so they're
   * all visible to the next poll cycle.
   */
  private bufferMediaGroupMessage(mediaGroupId: string, pending: PendingMessage): void {
    const existing = this.mediaGroupBuffer.get(mediaGroupId);
    if (existing) {
      existing.items.push(pending);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flushMediaGroup(mediaGroupId), TelegramChannel.MEDIA_GROUP_DEBOUNCE_MS);
    } else {
      const timer = setTimeout(() => this.flushMediaGroup(mediaGroupId), TelegramChannel.MEDIA_GROUP_DEBOUNCE_MS);
      this.mediaGroupBuffer.set(mediaGroupId, { items: [pending], timer });
    }
  }

  private flushMediaGroup(mediaGroupId: string): void {
    const group = this.mediaGroupBuffer.get(mediaGroupId);
    if (!group) return;
    this.mediaGroupBuffer.delete(mediaGroupId);

    logger.info({ mediaGroupId, count: group.items.length }, 'Flushing media group');
    for (const pending of group.items) {
      this.opts.onChatMetadata(pending.chatJid, pending.timestamp);
      const base = stripTopicSuffix(pending.chatJid);
      if (base !== pending.chatJid) {
        this.opts.onChatMetadata(base, pending.timestamp);
      }
      this.opts.onMessage(pending.chatJid, pending.msg);
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      const isTopicMessage = ctx.message?.is_topic_message;
      const threadId = isTopicMessage ? ctx.message?.message_thread_id : undefined;
      const baseJid = `tg:${chatId}`;
      let reply = `Chat ID: \`${baseJid}\`\nName: ${chatName}\nType: ${chatType}`;
      if (threadId !== undefined) {
        reply += `\nTopic JID: \`${buildTopicJid(chatId, threadId)}\`\nThread ID: ${threadId}`;
      }
      if (ctx.message?.message_thread_id !== undefined && !isTopicMessage) {
        reply += `\n_(General topic — uses base Chat ID)_`;
      }

      ctx.reply(reply, { parse_mode: 'Markdown' });
    });

    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) return;

      // Only treat as a topic message when is_topic_message is true.
      // General topic messages carry a message_thread_id but is_topic_message is false;
      // using that thread ID for replies causes "message thread not found" errors.
      const threadId = ctx.message.is_topic_message ? ctx.message.message_thread_id : undefined;
      const chatJid = buildTopicJid(ctx.chat.id, threadId);
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store metadata for both topic JID and base group JID
      this.opts.onChatMetadata(chatJid, timestamp, chatName);
      const base = stripTopicSuffix(chatJid);
      if (base !== chatJid) {
        this.opts.onChatMetadata(base, timestamp, chatName);
      }

      const groups = this.opts.registeredGroups();
      const group = groups[chatJid] || groups[base];
      if (!group) {
        logger.warn(
          { chatJid, chatName, chatType: ctx.chat.type, isForum: (ctx.chat as any).is_forum },
          'Message from unregistered Telegram chat (register with /chatid)',
        );
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders
    const storeNonText = (ctx: any, placeholder: string) => {
      const threadId = ctx.message?.is_topic_message ? ctx.message?.message_thread_id : undefined;
      const chatJid = buildTopicJid(ctx.chat.id, threadId);
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid] || groups[stripTopicSuffix(chatJid)];
      if (!group) {
        logger.warn({ chatJid }, 'Non-text message from unregistered Telegram chat');
        return;
      }

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const msg: import('../types.js').NewMessage = {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      };

      const mediaGroupId = ctx.message?.media_group_id as string | undefined;
      if (mediaGroupId) {
        this.bufferMediaGroupMessage(mediaGroupId, { chatJid, timestamp, msg });
      } else {
        this.opts.onChatMetadata(chatJid, timestamp);
        const base = stripTopicSuffix(chatJid);
        if (base !== chatJid) {
          this.opts.onChatMetadata(base, timestamp);
        }
        this.opts.onMessage(chatJid, msg);
      }
    };

    this.bot.on('message:photo', async (ctx) => {
      const threadId = ctx.message?.is_topic_message ? ctx.message?.message_thread_id : undefined;
      const chatJid = buildTopicJid(ctx.chat.id, threadId);
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid] || groups[stripTopicSuffix(chatJid)];
      if (!group) {
        logger.warn({ chatJid }, 'Photo from unregistered Telegram chat');
        return;
      }

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const msgId = ctx.message.message_id.toString();

      // Get largest photo resolution (last element in the array)
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      let imagePaths: string[] | undefined;

      try {
        const file = await ctx.api.getFile(largest.file_id);
        if (file.file_path) {
          const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          const resp = await fetch(url);
          if (resp.ok) {
            const safeChatJid = chatJid.replace(/[^a-zA-Z0-9-]/g, '_');
            const photoDir = path.join(DATA_DIR, 'photos', safeChatJid);
            fs.mkdirSync(photoDir, { recursive: true });
            const ext = path.extname(file.file_path) || '.jpg';
            const localFile = path.join(photoDir, `${msgId}${ext}`);
            const buffer = Buffer.from(await resp.arrayBuffer());
            fs.writeFileSync(localFile, buffer);

            // Relative path from project root for ContainerInput
            const relativePath = path.relative(process.cwd(), localFile);
            imagePaths = [relativePath];
            logger.info({ chatJid, localFile, size: buffer.length }, 'Telegram photo downloaded');
          } else {
            logger.warn({ chatJid, status: resp.status }, 'Failed to download Telegram photo');
          }
        }
      } catch (err) {
        logger.error({ chatJid, err }, 'Error downloading Telegram photo');
      }

      const photoRef = imagePaths ? `[Photo: ${imagePaths[0]}]` : '[Photo]';

      const msg: import('../types.js').NewMessage = {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${photoRef}${caption}`,
        timestamp,
        is_from_me: false,
        imagePaths,
      };

      const mediaGroupId = (ctx.message as any).media_group_id as string | undefined;
      if (mediaGroupId) {
        this.bufferMediaGroupMessage(mediaGroupId, { chatJid, timestamp, msg });
      } else {
        this.opts.onChatMetadata(chatJid, timestamp);
        const base = stripTopicSuffix(chatJid);
        if (base !== chatJid) {
          this.opts.onChatMetadata(base, timestamp);
        }
        this.opts.onMessage(chatJid, msg);
      }
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));

    // Voice & audio — download and transcribe via Whisper
    const handleAudioMessage = async (
      ctx: any,
      fileId: string,
      label: string,
      fallback: string,
    ) => {
      const threadId = ctx.message?.is_topic_message ? ctx.message?.message_thread_id : undefined;
      const chatJid = buildTopicJid(ctx.chat.id, threadId);
      const groups = this.opts.registeredGroups();
      if (!groups[chatJid] && !groups[stripTopicSuffix(chatJid)]) {
        logger.warn({ chatJid }, `${label} from unregistered Telegram chat`);
        return;
      }

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const msgId = ctx.message.message_id.toString();

      let placeholder = fallback;
      try {
        const file = await ctx.api.getFile(fileId);
        if (file.file_path) {
          const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          const resp = await fetch(url);
          if (resp.ok) {
            const buffer = Buffer.from(await resp.arrayBuffer());
            const text = await transcribeAudio(buffer, file.file_path);
            if (text) {
              placeholder = `[${label}: ${text}]`;
              logger.info({ chatJid, length: text.length }, `${label} transcribed`);
            }
          } else {
            logger.warn({ chatJid, status: resp.status }, `Failed to download ${label.toLowerCase()}`);
          }
        }
      } catch (err) {
        logger.error({ chatJid, err }, `Error processing ${label.toLowerCase()}`);
      }

      this.opts.onChatMetadata(chatJid, timestamp);
      const base = stripTopicSuffix(chatJid);
      if (base !== chatJid) {
        this.opts.onChatMetadata(base, timestamp);
      }
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:voice', (ctx) =>
      handleAudioMessage(ctx, ctx.message.voice.file_id, 'Voice', '[Voice message]'),
    );
    this.bot.on('message:audio', (ctx) =>
      handleAudioMessage(ctx, ctx.message.audio.file_id, 'Audio', '[Audio]'),
    );
    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      const originalName = doc?.file_name || 'file';
      const fileId = doc?.file_id;

      const threadId = ctx.message?.is_topic_message ? ctx.message?.message_thread_id : undefined;
      const chatJid = buildTopicJid(ctx.chat.id, threadId);
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid] || groups[stripTopicSuffix(chatJid)];
      if (!group) {
        logger.warn({ chatJid }, 'Document from unregistered Telegram chat');
        return;
      }

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const msgId = ctx.message.message_id.toString();

      let placeholder = `[Document: ${originalName}]`;

      // Telegram Bot API has a 20MB limit on getFile()
      if (doc?.file_size && doc.file_size > 20 * 1024 * 1024) {
        logger.warn({ chatJid, fileName: originalName, fileSize: doc.file_size }, 'Document exceeds 20MB Telegram Bot API limit, skipping download');
      } else if (fileId) {
        try {
          const file = await ctx.api.getFile(fileId);
          if (file.file_path) {
            const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
            const resp = await fetch(url);
            if (resp.ok) {
              const safeChatJid = chatJid.replace(/[^a-zA-Z0-9-]/g, '_');
              const fileDir = path.join(DATA_DIR, 'files', safeChatJid);
              fs.mkdirSync(fileDir, { recursive: true });
              const safeName = originalName.replace(/[/\\]/g, '_');
              const localFile = path.join(fileDir, `${msgId}_${safeName}`);
              const buffer = Buffer.from(await resp.arrayBuffer());
              fs.writeFileSync(localFile, buffer);

              const relativePath = path.relative(process.cwd(), localFile);
              placeholder = `[File: ${relativePath}]`;
              logger.info({ chatJid, localFile, size: buffer.length, fileName: originalName }, 'Telegram document downloaded');
            } else {
              logger.warn({ chatJid, status: resp.status, fileName: originalName }, 'Failed to download Telegram document');
            }
          }
        } catch (err) {
          logger.error({ chatJid, err, fileName: originalName }, 'Error downloading Telegram document');
        }
      }

      const msg: import('../types.js').NewMessage = {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      };

      const mediaGroupId = (ctx.message as any).media_group_id as string | undefined;
      if (mediaGroupId) {
        this.bufferMediaGroupMessage(mediaGroupId, { chatJid, timestamp, msg });
      } else {
        this.opts.onChatMetadata(chatJid, timestamp);
        const base = stripTopicSuffix(chatJid);
        if (base !== chatJid) {
          this.opts.onChatMetadata(base, timestamp);
        }
        this.opts.onMessage(chatJid, msg);
      }
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle group → supergroup migration (e.g. when Forum Topics are enabled)
    this.bot.on('message:migrate_to_chat_id', (ctx) => {
      const oldId = ctx.chat.id;
      const newId = (ctx.message as any).migrate_to_chat_id as number;
      const oldJid = `tg:${oldId}`;
      const newJid = `tg:${newId}`;

      const groups = this.opts.registeredGroups();
      if (groups[oldJid] && this.opts.onMigrateGroup) {
        logger.info({ oldJid, newJid }, 'Telegram group migrated to supergroup, updating registration');
        this.opts.onMigrateGroup(oldJid, newJid);
      }
    });

    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          if (!botInfo.can_read_all_group_messages) {
            logger.warn(
              'Bot privacy mode is ON — bot cannot see messages in groups unless mentioned or made admin',
            );
          }
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            '  Send /chatid to the bot to get a chat\'s registration ID\n',
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const { chatId, threadId } = parseTopicJid(jid);
      const opts: Record<string, unknown> = { parse_mode: 'Markdown', ...(threadId !== undefined ? { message_thread_id: threadId } : {}) };
      const MAX_LENGTH = 4096;
      const sendChunk = async (chunk: string, sendOpts: Record<string, unknown>) => {
        const MAX_RETRIES = 3;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            await this.bot!.api.sendMessage(chatId, chunk, sendOpts);
            return;
          } catch (err: any) {
            // Retry without thread ID if topic no longer exists
            if (sendOpts.message_thread_id && err?.message?.includes('message thread not found')) {
              logger.warn({ jid }, 'Topic thread not found, retrying without thread ID');
              await this.bot!.api.sendMessage(chatId, chunk);
              return;
            }
            // Retry on transient network errors
            const isNetwork = err?.error?.code === 'ECONNRESET' || err?.error?.code === 'ETIMEDOUT'
              || err?.message?.includes('Network request') || err?.message?.includes('socket hang up');
            if (isNetwork && attempt < MAX_RETRIES - 1) {
              logger.warn({ jid, attempt: attempt + 1 }, 'Telegram send failed (network), retrying...');
              await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
              continue;
            }
            throw err;
          }
        }
      };
      if (text.length <= MAX_LENGTH) {
        await sendChunk(text, opts);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendChunk(text.slice(i, i + MAX_LENGTH), opts);
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendPhoto(jid: string, filePath: string, caption?: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const { chatId, threadId } = parseTopicJid(jid);
      const opts: Record<string, unknown> = {};
      if (caption) opts.caption = caption;
      if (threadId !== undefined) opts.message_thread_id = threadId;
      try {
        await this.bot.api.sendPhoto(chatId, new InputFile(filePath), opts);
      } catch (err: any) {
        if (opts.message_thread_id && err?.message?.includes('message thread not found')) {
          logger.warn({ jid }, 'Topic thread not found for photo, retrying without thread ID');
          const fallbackOpts: Record<string, unknown> = {};
          if (caption) fallbackOpts.caption = caption;
          await this.bot.api.sendPhoto(chatId, new InputFile(filePath), fallbackOpts);
        } else {
          throw err;
        }
      }
      logger.info({ jid, filePath }, 'Telegram photo sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Telegram photo');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const { chatId, threadId } = parseTopicJid(jid);
      const opts = threadId !== undefined ? { message_thread_id: threadId } : {};
      await this.bot.api.sendChatAction(chatId, 'typing', opts);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}
