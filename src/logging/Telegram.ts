import { httpRequest } from '../util/Http'
import type { HttpRequestConfig } from '../util/Http'
import PQueue from 'p-queue'
import type { WebhookTelegramConfig } from '../interface/Config'
import type { LogLevel } from './Logger'
import { flushQueue } from './Queue'

const telegramQueue = new PQueue({
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

function getTelegramEmoji(level: LogLevel): string {
    switch (level) {
        case 'error':
            return '❌'
        case 'warn':
            return '⚠️'
        case 'info':
            return 'ℹ️'
        case 'debug':
            return '🐛'
        default:
            return '📝'
    }
}

/**
 * Run-end summary: plain text, no ``` fence and no MarkdownV2 - the emoji layout IS the
 * formatting, and a code block would flatten it into monospace.
 */
export async function sendTelegramPlain(config: WebhookTelegramConfig, text: string): Promise<void> {
    if (!config?.botToken || !config?.chatId) return

    const request: HttpRequestConfig = {
        method: 'POST',
        url: `https://api.telegram.org/bot${config.botToken}/sendMessage`,
        headers: { 'Content-Type': 'application/json' },
        data: { chat_id: config.chatId, text, disable_notification: false },
        timeout: 10000
    }

    await telegramQueue.add(async () => {
        try {
            await httpRequest(request)
        } catch (err) {
            const status = (err as { response?: { status?: number } })?.response?.status
            // rate limit / bad token / bot kicked: nothing we can do here
            if (status === 429 || status === 401 || status === 403) return
            console.warn(`[WEBHOOK] Telegram 推送失败 | status=${status ?? 'n/a'} | ${err instanceof Error ? err.message : String(err)}`)
        }
    })
}

export async function sendTelegram(config: WebhookTelegramConfig, content: string, level: LogLevel): Promise<void> {
    if (!config?.botToken || !config?.chatId) return

    const emoji = getTelegramEmoji(level)
    const message = `${emoji}\n\`\`\`\n${content}\n\`\`\``

    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`

    const request: HttpRequestConfig = {
        method: 'POST',
        url: url,
        headers: { 'Content-Type': 'application/json' },
        data: {
            chat_id: config.chatId,
            text: message,
            parse_mode: 'MarkdownV2',
            disable_notification: level === 'debug'
        },
        timeout: 10000
    }

    await telegramQueue.add(async () => {
        try {
            await httpRequest(request)
        } catch (err) {
            const status = (err as { response?: { status?: number } })?.response?.status

            if (status === 429 || status === 401 || status === 403) return
        }
    })
}

export function flushTelegramQueue(timeoutMs = 5000): Promise<void> {
    return flushQueue(telegramQueue, timeoutMs)
}
