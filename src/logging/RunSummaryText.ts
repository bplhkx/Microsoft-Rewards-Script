// Pure formatter for the end-of-run Telegram summary. Kept in its own module so it can be
// unit-tested without importing dist/index.js (which runs main() on require).
import { formatLocalTimestamp } from './Logger'

export interface RunSummaryAccount {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number // seconds
    success: boolean
    error?: string
}

const DIGITS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣']

function bullet(index: number): string {
    if (index < DIGITS.length) return DIGITS[index]!
    return '🔹'
}

function minutes(seconds: number): string {
    return Number.isFinite(seconds) ? (seconds / 60).toFixed(1) : '?'
}

export function buildTelegramRunSummary(
    accounts: RunSummaryAccount[],
    runStartTime: number,
    hadWorkerFailure: boolean
): string {
    const totalGained = accounts.reduce((sum, s) => sum + s.collectedPoints, 0)
    const totalBefore = accounts.reduce((sum, s) => sum + s.initialPoints, 0)
    const totalAfter = accounts.reduce((sum, s) => sum + s.finalPoints, 0)
    const okCount = accounts.filter(s => s.success).length
    const runtime = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

    const head = hadWorkerFailure ? '⚠️ 跑完了，但有异常' : '🎉 全部跑完'
    const lines: string[] = [
        `${head} ｜ Microsoft Rewards`,
        `📅 ${formatLocalTimestamp(new Date())} ⏱ 用时 ${runtime} 分钟`,
        `✅ 成功 ${okCount}/${accounts.length} 🪙 本次合计 +${totalGained}`,
        `💰 总余额 ${totalBefore} → ${totalAfter}`,
        ''
    ]

    accounts.forEach((s, i) => {
        const mark = s.success ? '🪙' : '❌'
        const gain = s.success ? `+${s.collectedPoints}` : `+0`
        const err = s.error ? ` ⛔ ${s.error.slice(0, 60)}` : ''
        lines.push(`${bullet(i + 1)} ${s.email}`)
        lines.push(`   ${mark} 本次 ${gain} ｜ 💰 ${s.initialPoints} → ${s.finalPoints} ｜ ⏱ ${minutes(s.duration)} 分${err}`)
    })

    if (accounts.length === 0) lines.push('🫥 这一轮没有账号跑')
    return lines.join('\n')
}
