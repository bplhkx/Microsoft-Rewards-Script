// 部署侧扩展（非上游代码）：给控制 API 增加"新增账号"能力。
//
// 上游把账号完全放在 ACCOUNT_N_* 环境变量里（src/util/Load.ts:122 loadAccounts），
// 而 Load.ts:59 的 ensureEnvLoaded() 只填充 process.env 中"尚未定义"的键——
// 也就是说 compose env_file 注入的 ACCOUNT_1_* 优先，写在项目根 .env 里的新账号
// （ACCOUNT_2_* 及以后）不会被覆盖，且每次 bot 进程启动都会重新读取。
// 因此这里把新账号追加到 <projectRoot>/.env（部署时是宿主机 accounts.env 的挂载），
// 同时同步到当前进程 env，使 /accounts 立刻可见、无需重建容器。

import fs from 'node:fs'
import path from 'node:path'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/
const MAX_FIELD = 512

// 允许从面板写入的字段 -> .env 后缀；undefined/空串跳过
const FIELDS = [
    ['password', 'PASSWORD'],
    ['totpSecret', 'TOTP_SECRET'],
    ['recoveryEmail', 'RECOVERY_EMAIL'],
    ['langCode', 'LANG_CODE'],
    ['geoLocale', 'GEO_LOCALE'],
    ['proxyUrl', 'PROXY_URL'],
    ['proxyPort', 'PROXY_PORT'],
    ['proxyUsername', 'PROXY_USERNAME'],
    ['proxyPassword', 'PROXY_PASSWORD'],
    // 跑哪一端：both|mobile|desktop（非法值由 bot 的 buildPlatforms 退回 both）
    ['platforms', 'PLATFORMS']
]

function fail(code, message) {
    const err = new Error(message)
    err.code = code
    return err
}

function containsControl(v) {
    return /[\u0000-\u001f\u007f]/.test(v)
}

// 值里有空格/井号/引号时必须带引号写入，读取侧（Load.ts:55）会脱掉成对引号
function formatValue(value) {
    const s = String(value)
    if (/[#\s"'`$&\\]/.test(s)) return `"${s.replace(/(["\\])/g, '\\$1')}"`
    return s
}

export function nextAccountIndex(env = process.env) {
    let max = 0
    for (const key of Object.keys(env)) {
        const m = /^ACCOUNT_([1-9]\d*)_EMAIL$/.exec(key)
        if (!m) continue
        const n = Number(m[1])
        if (Number.isSafeInteger(n)) max = Math.max(max, n)
    }
    return max + 1
}

function existingEmails(env, envFilePath) {
    const emails = new Map()
    for (const key of Object.keys(env)) {
        const m = /^ACCOUNT_([1-9]\d*)_EMAIL$/.exec(key)
        if (!m) continue
        const value = String(env[key] || '').trim()
        if (value) emails.set(value.toLowerCase(), Number(m[1]))
    }
    // 已经写进 .env 但还没被任何进程读到的账号也要算进去
    if (fs.existsSync(envFilePath)) {
        const raw = fs.readFileSync(envFilePath, 'utf-8')
        for (const line of raw.split(/\r?\n/)) {
            const m = /^\s*ACCOUNT_([1-9]\d*)_EMAIL\s*=\s*(.+?)\s*$/.exec(line)
            if (!m || line.trim().startsWith('#')) continue
            const value = m[2].replace(/^["']|["']$/g, '').trim()
            if (value) emails.set(value.toLowerCase(), Number(m[1]))
        }
    }
    return emails
}

/**
 * 追加一个账号。返回 { index, email, fields, envFile }。
 * 校验失败抛 err.code = 'INVALID'，重复邮箱抛 'DUPLICATE'。
 */
export function addAccount(projectRoot, payload, env = process.env) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw fail('INVALID', '请求体必须是 JSON 对象。')
    }

    const email = String(payload.email ?? '').trim()
    if (!email) throw fail('INVALID', '邮箱不能为空。')
    if (email.length > 320) throw fail('INVALID', '邮箱过长。')
    if (!EMAIL_RE.test(email)) throw fail('INVALID', `邮箱格式不正确：${email}`)

    const envFilePath = path.join(projectRoot, '.env')
    const seen = existingEmails(env, envFilePath)
    if (seen.has(email.toLowerCase())) {
        throw fail('DUPLICATE', `该邮箱已存在（ACCOUNT_${seen.get(email.toLowerCase())}）。`)
    }

    const index = nextAccountIndex(env)
    const written = []
    const lines = [`# 面板添加于 ${new Date().toISOString()}`]

    const push = (key, value) => {
        const s = String(value).trim()
        if (!s) return
        if (s.length > MAX_FIELD) throw fail('INVALID', `${key} 超过 ${MAX_FIELD} 字符。`)
        if (containsControl(s)) throw fail('INVALID', `${key} 含控制字符。`)
        lines.push(`${key}=${formatValue(s)}`)
        env[key] = s
        written.push(key)
    }

    push(`ACCOUNT_${index}_EMAIL`, email)
    for (const [field, suffix] of FIELDS) {
        if (payload[field] === undefined || payload[field] === null) continue
        push(`ACCOUNT_${index}_${suffix}`, payload[field])
    }
    if (!written.includes(`ACCOUNT_${index}_LANG_CODE`)) push(`ACCOUNT_${index}_LANG_CODE`, 'zh-CN')
    if (!written.includes(`ACCOUNT_${index}_GEO_LOCALE`)) push(`ACCOUNT_${index}_GEO_LOCALE`, 'CN')

    const block = lines.join('\n') + '\n'
    try {
        // 追加前必须确认文件以换行结尾：否则 "# 面板添加于 …" 会粘在上一条 ACCOUNT_N_* 后面，
        // 既污染那个账号的最后一个字段，也会让按注释块清理旧账号时误删整块（2026-10-05 实测踩过）。
        const current = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, 'utf-8') : ''
        const prefix = current && !/\n$/.test(current) ? '\n' : ''
        fs.appendFileSync(envFilePath, prefix + block, 'utf-8')
    } catch (e) {
        // 回滚进程 env，避免留下"看得见但没落盘"的账号
        for (const key of written) delete env[key]
        throw fail('WRITE_FAILED', `写入 ${envFilePath} 失败：${e.message}（请确认它是以可写方式挂载的宿主机文件）`)
    }

    return { index, email, fields: written, envFile: envFilePath, persisted: true }
}
