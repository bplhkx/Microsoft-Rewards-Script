// 部署侧扩展（非上游代码）：给控制 API 增加"新增账号"和"修改已有账号跑哪一端"的能力。
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

// ── 修改已存在账号 ────────────────────────────────────────────────
// 只做一件事：改写 ACCOUNT_N_PLATFORMS（跑哪一端）。
// 不改邮箱/密码：邮箱是面板历史与 sessions.db 的关联键，改它会让积分历史和已存会话全部错位。
const PLATFORM_VALUES = ['both', 'mobile', 'desktop']

export function normalizePlatforms(value) {
    const v = String(value ?? '').trim().toLowerCase()
    return PLATFORM_VALUES.includes(v) ? v : 'both'
}

/**
 * 就地改写某个已存在账号的 ACCOUNT_N_PLATFORMS。
 * 返回 { index, email, platforms, persisted, where, note }。
 * where: 'updated' 已有该键 | 'inserted' 在该账号块内补一行 | 'appended' 该账号不在文件里（compose env_file 注入），追加一个补充块
 */
export function updateAccountPlatform(projectRoot, index, payload, env = process.env) {
    const idx = Number(index)
    if (!Number.isSafeInteger(idx) || idx < 1) {
        throw fail('INVALID', '账号序号必须是不小于 1 的整数。')
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw fail('INVALID', '请求体必须是 JSON 对象。')
    }

    const emailKey = `ACCOUNT_${idx}_EMAIL`
    const platformsKey = `ACCOUNT_${idx}_PLATFORMS`

    // 账号是否存在：以当前进程 env 为准（服务启动时 loadEnvFile 已把文件里的账号读进来）
    const email = String(env[emailKey] ?? '').trim()
    if (!email) {
        throw fail('NOT_FOUND', `ACCOUNT_${idx} 不存在（没有 ${emailKey}）。`)
    }

    const rawPlatform = payload.platforms
    if (rawPlatform === undefined || rawPlatform === null || String(rawPlatform).trim() === '') {
        throw fail('INVALID', '缺少 platforms。')
    }
    const value = String(rawPlatform).trim().toLowerCase()
    if (!PLATFORM_VALUES.includes(value)) {
        throw fail('INVALID', `platforms 只能是 both / mobile / desktop，收到的是 ${rawPlatform}。`)
    }

    const envFilePath = path.join(projectRoot, '.env')
    const rawText = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, 'utf-8') : ''
    const lines = rawText.length ? rawText.split(/\r?\n/) : []
    const inFile = lines.some((l) => new RegExp(`^\\s*ACCOUNT_${idx}_`).test(l))

    const newLine = `${platformsKey}=${formatValue(value)}`
    const keyRe = new RegExp(`^\\s*${platformsKey}\\s*=`)
    const emailRe = new RegExp(`^\\s*${emailKey}\\s*=`)

    let text
    let where
    const at = lines.findIndex((l) => keyRe.test(l))
    if (at >= 0) {
        lines[at] = newLine
        text = lines.join('\n')
        where = 'updated'
    } else {
        const afterEmail = lines.findIndex((l) => emailRe.test(l))
        if (afterEmail >= 0) {
            lines.splice(afterEmail + 1, 0, newLine)
            text = lines.join('\n')
            where = 'inserted'
        } else {
            const block = `# 面板修改于 ${new Date().toISOString()}\n${newLine}`
            text = rawText ? `${/\n$/.test(rawText) ? rawText : rawText + '\n'}\n${block}\n` : `${block}\n`
            where = 'appended'
        }
    }
    if (!/\n$/.test(text)) text += '\n'

    try {
        // 用 writeFileSync 而不是"写临时文件 + rename"：rename 会换掉 inode，
        // 而这个文件是宿主机的单文件 bind-mount，换 inode 会让容器里看到的还是旧内容。
        fs.writeFileSync(envFilePath, text, 'utf-8')
    } catch (e) {
        throw fail('WRITE_FAILED', `写入 ${envFilePath} 失败：${e.message}（请确认它是以可写方式挂载的宿主机文件）`)
    }

    // 落盘成功后再同步当前进程 env，让 /accounts 立刻反映新值（下一轮进程重读时读到的也是同一值）
    env[platformsKey] = value

    const note =
        where === 'appended'
            ? '该账号由 compose 的 env_file 注入，本次是在 .env 里补了一个新键。若以后 env_file 也定义同名键，env_file 会优先（ensureEnvLoaded 只填未定义的键）。'
            : undefined

    return { index: idx, email, platforms: value, persisted: true, where, envFile: envFilePath, note }
}
