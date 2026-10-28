// 印章收集进度解析的回归测试。
// 语料是 2026-10-15 从 rewards.bing.com/dashboard 真实抓到的那一段（Next.js flight，
// 引号被转义成 \"）；同一天 /earn 里并没有这一节，所以别拿 /earn 的内容来测。
//
// 跑法：先 npm run build，再 node scripts/tests/streakBonus.cjs
// （测的是构建产物 dist，不是 src，这样"源码对但没编进去"也算失败）
const ReactFunc = require('../../dist/browser/ReactFunc').default

// snapshotStreakBonus 不碰 this，不用真的构造 bot
const react = Object.create(ReactFunc.prototype)

let fails = 0
const ok = (cond, label, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  :: ${extra}` : ''}`)
    if (!cond) fails++
}

const escaped =
    '{"name\\":\\"SnapshotSection_StreakBonus\\",\\"click\\":true,\\"data\\":{\\"streakBonus\\":1000,' +
    '\\"activityProgress\\":3,\\"activitiesTotal\\":12}},"children":["$","div",null]'

const plain = '{"name":"SnapshotSection_StreakBonus","data":{"streakBonus":1000,"activityProgress":5,"activitiesTotal":12}}'

const got = react.snapshotStreakBonus(escaped)
ok(got?.done === 3 && got?.max === 12, '转义过的 flight 片段解析成 3/12', JSON.stringify(got))
ok(react.snapshotStreakBonus(plain)?.done === 5, '没转义时也能解析')
ok(react.snapshotStreakBonus('<html>没有任何 punchcard 的页面</html>') === null, '页面里没这一节就返回 null')
ok(react.snapshotStreakBonus(escaped.replace('activityProgress\\":3', 'activityProgress\\":13')) === null, '分子大于分母时不写（宁缺毋假）')
ok(react.snapshotStreakBonus('SnapshotSection_StreakBonus","data":{"streakBonus":1000}') === null, '缺 activityProgress 时不猜')
ok(react.snapshotStreakBonus('') === null, '空页面不炸')

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
