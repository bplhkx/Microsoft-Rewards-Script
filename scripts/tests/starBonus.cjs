// 「奖励追踪」（必应 Star 奖励）解析的回归测试。
// 语料是 2026-11-03 从 rewards.bing.com/dashboard 真实抓到的 flight 片段：
// 同一页里 "starbonus" 出现三处，两处是档位权益文案（supportedLevels），
// 只有 model 那处带 currentProgress —— 所以"抠到第一段 starbonus 就算赢"是错的。
//
// 跑法：先 npm run build，再 node scripts/tests/starBonus.cjs
// （测的是构建产物 dist，不是 src，这样"源码对但没编进去"也算失败）
const ReactFunc = require('../../dist/browser/ReactFunc').default

// snapshotStarBonus 不碰 this，不用真的构造 bot
const react = Object.create(ReactFunc.prototype)

let fails = 0
const ok = (cond, label, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  :: ${extra}` : ''}`)
    if (!cond) fails++
}

// 真页面上的样子：整段都在 <script> 里，引号被转义成 \"
const benefitCopy =
    '{"key":"Star","text":"starbonus","supportedLevels":{"newLevel1":"300","newLevel2":"900","newLevel3":"2100"}}'
const model = (current, max, prev = 60) =>
    '{\\"type\\":\\"starbonus\\",\\"model\\":{\\"bonus\\":{\\"prevPointsEarned\\":' +
    prev +
    ',\\"prevPointsMax\\":2100,\\"pointsMax\\":' +
    max +
    ',\\"pointsPerLevel\\":{\\"1\\":300,\\"2\\":900,\\"3\\":2100},\\"state\\":\\"complete\\",\\"currentProgress\\":' +
    current +
    ',\\"showIncrementalTracker\\":false}}}'

const page = `<html><body>${benefitCopy}${benefitCopy}${model(60, 2100)}</body></html>`

const got = react.snapshotStarBonus(page)
ok(got?.current === 60 && got?.max === 2100, '转义过的 flight 里读到 60/2100', JSON.stringify(got))

const plain = `{"type":"starbonus","model":{"bonus":{"pointsMax":900,"currentProgress":300}}}`
ok(react.snapshotStarBonus(plain)?.current === 300, '没转义时也能解析')
ok(react.snapshotStarBonus(plain)?.max === 900, '分母取 pointsMax，不是 prevPointsMax')

// 本月值超过目标（积分标准每周会改）→ 不写，别把 2500/2100 这种上界面
ok(react.snapshotStarBonus(model(2500, 2100)) === null, '分子大于分母时不写（宁缺毋假）')
ok(
    react.snapshotStarBonus('{"type":"starbonus","model":{"bonus":{"prevPointsEarned":60}}}') === null,
    '缺 currentProgress 时不猜'
)
ok(react.snapshotStarBonus(benefitCopy) === null, '只有档位权益文案时不返回东西')
ok(react.snapshotStarBonus('<html>没有任何 starbonus 的页面</html>') === null, '页面里没这一节就返回 null')
ok(react.snapshotStarBonus('') === null, '空页面不炸')

// 四个账号的真实分布（11-03 实测）：current 60/60/60/30，prev 60/60/0/60
// —— 证明 model 里 currentProgress 与 prevPointsEarned 不是同一个数，别混用
const differing = model(30, 2100, 60)
const one = react.snapshotStarBonus(differing)
ok(one?.current === 30 && one?.max === 2100, '本月 30 不会被上月 60 顶掉', JSON.stringify(one))

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
