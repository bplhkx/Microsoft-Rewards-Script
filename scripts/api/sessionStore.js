import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function resolveSessionDb(projectRoot, sessionPath) {
    const candidates = [
        path.resolve(process.cwd(), sessionPath, 'sessions.db'),
        path.join(projectRoot, sessionPath, 'sessions.db'),
        path.join(projectRoot, 'dist', sessionPath, 'sessions.db'),
        path.join(projectRoot, 'src', sessionPath, 'sessions.db')
    ]
    const dbPath = candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0]
    return { dbPath, exists: fs.existsSync(dbPath) }
}

function openDatabase(dbPath, readOnly) {
    const db = new DatabaseSync(dbPath, { readOnly })
    db.exec('PRAGMA busy_timeout = 5000')
    return db
}

function closeDatabase(db) {
    try {
        db.close()
    } catch {}
}

function cookieCount(storageState) {
    if (!storageState) return 0
    try {
        const parsed = JSON.parse(storageState)
        return Array.isArray(parsed?.cookies) ? parsed.cookies.length : 0
    } catch {
        return null
    }
}

function toSession(row) {
    const updatedAt = Number(row.updated_at)
    const updatedDate = new Date(updatedAt)
    return {
        email: row.email,
        platform: row.platform,
        updatedAt:
            Number.isFinite(updatedAt) && !Number.isNaN(updatedDate.getTime()) ? updatedDate.toISOString() : null,
        hasStorageState: Boolean(row.storage_state),
        hasFingerprint: Boolean(row.fingerprint),
        cookieCount: cookieCount(row.storage_state)
    }
}

export function listStoredSessions(projectRoot, sessionPath) {
    const { dbPath, exists } = resolveSessionDb(projectRoot, sessionPath)
    if (!exists) {
        return { databaseExists: false, sessions: [], count: 0, accounts: 0 }
    }

    const db = openDatabase(dbPath, true)
    try {
        const rows = db
            .prepare(
                `SELECT email, platform, storage_state, fingerprint, updated_at
                 FROM sessions
                 ORDER BY LOWER(email), platform`
            )
            .all()
        return {
            databaseExists: true,
            sessions: rows.map(toSession),
            count: rows.length,
            accounts: new Set(rows.map(row => row.email.toLowerCase())).size
        }
    } finally {
        closeDatabase(db)
    }
}

const SESSION_PLATFORMS = ['mobile', 'desktop']

/**
 * Delete a stored login session.
 *
 * `platform` picks the scope: 'mobile' | 'desktop' | 'both' (default, for backwards
 * compatibility with DELETE /sessions/:email without a query string).
 *
 * The mobile and the desktop row are independent logins, so resetting one must never
 * take the other with it - that would force a full re-login on a platform that was fine.
 * `account_metadata` (resolved region) is shared, so it is only cleared when both rows go.
 */
export function deleteStoredSessions(projectRoot, sessionPath, email, platform = 'both') {
    const raw =
        platform === undefined || platform === null || platform === ''
            ? 'both'
            : String(platform).trim().toLowerCase()
    if (raw !== 'both' && !SESSION_PLATFORMS.includes(raw)) {
        // An unrecognised scope must not silently widen to "both" - that would delete the
        // login the caller meant to keep.
        return { found: false, removed: 0, email, platforms: [], remaining: [], scope: raw, invalidPlatform: true }
    }
    const scope = raw

    const { dbPath, exists } = resolveSessionDb(projectRoot, sessionPath)
    if (!exists) return { found: false, removed: 0, email, platforms: [], remaining: [], scope }

    const db = openDatabase(dbPath, false)
    try {
        const all = db
            .prepare('SELECT email, platform FROM sessions WHERE LOWER(email) = LOWER(?) ORDER BY platform')
            .all(email)

        if (!all.length) return { found: false, removed: 0, email, platforms: [], remaining: [], scope }

        const matches = scope === 'both' ? all : all.filter(row => row.platform === scope)
        if (!matches.length) {
            // The account does have a session, just not on the platform being reset
            return {
                found: false,
                removed: 0,
                email: all[0].email,
                platforms: [],
                remaining: all.map(row => row.platform),
                scope
            }
        }

        const result =
            scope === 'both'
                ? db.prepare('DELETE FROM sessions WHERE LOWER(email) = LOWER(?)').run(email)
                : db.prepare('DELETE FROM sessions WHERE LOWER(email) = LOWER(?) AND platform = ?').run(
                      email,
                      matches[0].platform
                  )
        if (scope === 'both') {
            try {
                db.prepare('DELETE FROM account_metadata WHERE LOWER(email) = LOWER(?)').run(email)
            } catch {}
        }
        try {
            db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        } catch {}

        const remaining = db
            .prepare('SELECT platform FROM sessions WHERE LOWER(email) = LOWER(?)')
            .all(email)
            .map(row => row.platform)

        return {
            found: true,
            removed: Number(result.changes ?? 0),
            email: matches[0].email,
            platforms: [...new Set(matches.map(row => row.platform))],
            remaining,
            scope
        }
    } finally {
        closeDatabase(db)
    }
}
