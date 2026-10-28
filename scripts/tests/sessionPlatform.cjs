/* 回归：按平台重置登录会话（scripts/api/sessionStore.js，供 DELETE /sessions/:email?platform= 用）
   跑法：node scripts/tests/sessionPlatform.cjs

   为什么要有这条测试：移动端和桌面端在 sessions.db 里是两条独立的登录。
   之前只有"整个账号一起删"的口子，而实测现象是某个账号移动端反复失败、
   桌面端是好的 —— 重置入口要是把桌面端那条一起清掉，就等于白白多做一次全新登录。 */
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let fails = 0
const ok = (cond, name, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  :: ${extra}`}`)
  if (!cond) fails++
}

async function main() {
  // scripts/ 有自己的 package.json（type=module），所以这里只能动态 import；
  // Windows 上必须转成 file:// URL，直接给绝对路径会 ERR_UNSUPPORTED_ESM_URL_SCHEME
  const { pathToFileURL } = require('node:url')
  const { deleteStoredSessions, listStoredSessions } = await import(
    pathToFileURL(path.resolve(__dirname, '..', 'api', 'sessionStore.js')).href
  )

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-sessions-'))
  // resolveSessionDb 第一个候选是 process.cwd()/sessionPath —— 用随机目录名，
  // 免得测试在仓库里跑时命中真的 sessions/sessions.db（那会去删真账号的会话）
  const sp = `sessions-test-${process.pid}-${Date.now()}`
  const sessionDir = path.join(tmp, sp)
  fs.mkdirSync(sessionDir, { recursive: true })
  const dbPath = path.join(sessionDir, 'sessions.db')

  const db = new DatabaseSync(dbPath)
  db.exec(
    `CREATE TABLE sessions (email TEXT NOT NULL, platform TEXT NOT NULL, storage_state TEXT,
                            fingerprint TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (email, platform))`
  )
  db.exec(
    `CREATE TABLE account_metadata (email TEXT PRIMARY KEY COLLATE NOCASE, resolved_region TEXT,
                                    updated_at INTEGER NOT NULL)`
  )
  const ins = db.prepare(
    'INSERT INTO sessions (email, platform, storage_state, fingerprint, updated_at) VALUES (?,?,?,?,?)'
  )
  ins.run('a@outlook.com', 'desktop', '{"cookies":[1,2]}', '{}', 1)
  ins.run('a@outlook.com', 'mobile', '{"cookies":[3]}', '{}', 2)
  ins.run('b@gmail.com', 'mobile', '{"cookies":[9]}', '{}', 3)
  const insMeta = db.prepare('INSERT INTO account_metadata (email, resolved_region, updated_at) VALUES (?,?,?)')
  insMeta.run('a@outlook.com', 'CN', 1)
  insMeta.run('b@gmail.com', 'CN', 2)
  db.close()

  const rows = (email) => {
    const d = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return d
        .prepare('SELECT platform FROM sessions WHERE LOWER(email) = LOWER(?) ORDER BY platform')
        .all(email)
        .map((r) => r.platform)
    } finally {
      d.close()
    }
  }
  const hasMeta = (email) => {
    const d = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return d
        .prepare('SELECT COUNT(*) c FROM account_metadata WHERE LOWER(email) = LOWER(?)')
        .get(email).c === 1
    } finally {
      d.close()
    }
  }

  // 0) 先把"测的是临时库"钉死：一旦解析到仓库里真账号的 sessions.db，立刻停，绝不往下删
  const seeded = listStoredSessions(tmp, sp)
  if (seeded.count !== 3) {
    console.error(`FAIL  测试没有落在临时库上（看到 ${seeded.count} 条会话），已中止`)
    process.exit(1)
  }
  ok(true, '测的是临时库，不是真账号的 sessions.db')

  // 1) 只删移动端：桌面端必须原样留着
  let r = deleteStoredSessions(tmp, sp, 'a@outlook.com', 'mobile')
  ok(r.found && r.removed === 1 && r.platforms.join() === 'mobile', 'platform=mobile 只删掉那一行', JSON.stringify(r))
  ok(rows('a@outlook.com').join() === 'desktop', '删移动端不会带上桌面端', rows('a@outlook.com').join())
  ok(hasMeta('a@outlook.com'), '只动一个平台时保留账号元数据（resolved_region 两端共用）')
  ok(r.remaining.join() === 'desktop', '返回值说明还剩哪条', r.remaining.join())

  // 2) 大写带空格也能认
  r = deleteStoredSessions(tmp, sp, 'a@outlook.com', ' Desktop ')
  ok(r.found && r.removed === 1 && rows('a@outlook.com').length === 0, 'platform 大小写/空格不敏感', JSON.stringify(r))
  ok(hasMeta('a@outlook.com'), '单平台删除从不碰元数据')

  // 3) 这个平台根本没有会话 → 不删、不报错、说清楚还有谁
  r = deleteStoredSessions(tmp, sp, 'b@gmail.com', 'desktop')
  ok(!r.found && r.removed === 0, '只要桌面端而它只有移动端：什么都不删', JSON.stringify(r))
  ok(r.remaining.join() === 'mobile', '404 的响应能带出"其实还有 mobile"', r.remaining.join())
  ok(rows('b@gmail.com').join() === 'mobile', '那条移动端会话没被误删', rows('b@gmail.com').join())

  // 4) 认不出的平台必须拒绝，绝不能退化成"两端都删"
  r = deleteStoredSessions(tmp, sp, 'b@gmail.com', 'all')
  ok(!r.found && r.removed === 0 && r.invalidPlatform === true, '非法平台不删任何东西', JSON.stringify(r))
  ok(rows('b@gmail.com').join() === 'mobile', '非法平台不会把会话清掉', rows('b@gmail.com').join())

  // 5) 不传平台 = 老行为（两端都清）
  r = deleteStoredSessions(tmp, sp, 'b@gmail.com')
  ok(r.found && r.scope === 'both' && rows('b@gmail.com').length === 0, '省略 platform 仍是两端都删', JSON.stringify(r))
  ok(!hasMeta('b@gmail.com'), '两端都删时该账号的元数据一起走')
  ok(hasMeta('a@outlook.com'), '别的账号元数据不受影响')

  // 6) 列会话的接口不受影响
  const listed = listStoredSessions(tmp, sp)
  ok(listed.databaseExists && listed.count === 0, '清空后 listStoredSessions 正常返回', JSON.stringify(listed))

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
  process.exit(fails ? 1 : 0)
}

main().catch((e) => {
  console.error('测试自身出错:', e)
  process.exit(1)
})
