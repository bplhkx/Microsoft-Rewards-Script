import type { MicrosoftRewardsBot } from '../index'

export interface ParsedOffer {
    offerId: string
    hash: string | null
    title: string
    description: string
    points: number
    promotionSubtype: string | null
    destination: string
    isCompleted: boolean
    isPromotional: boolean
    isLocked: boolean
    unlockCriteria: string | null
    date: string | null
    activityType: number | null
    reportable: boolean
}

export interface QuestChild {
    offerId: string
    hash: string | null
    points: number
    isCompleted: boolean
    isLocked: boolean
    isDisabled: boolean
    reportable: boolean
}

export interface ParentQuest {
    offerId: string
    title: string
    pointProgressMax: number
    complete: boolean
    /** 页面里那句 "3 / 12 tasks" —— 印章收集的真实进度，不是分数 */
    tasksDone: number | null
    tasksMax: number | null
}

export interface StreakState {
    partner: string

    activitiesCompleted: number
    activitiesTotal: number
    completedDays: number
    currentDay: number
    totalDays: number
    isCurrentDayCompleted: boolean
    isEnabled: boolean
    dailyPoints: number[]
    activationOfferId: string | null
    activationHash: string | null
    activationActivityType: number | null
    destinationUrl: string | null
}

export interface StreakProtectionState {
    isProtectionOn: boolean
    remainingDays: number | null
    streakCounter: number | null
}

export interface AccountState {
    level: number | null
    pointsProgress: number | null
    pointsRemaining: number | null
    lifetimeEarn: number | null
    availablePoints: number | null
}

export interface PageSnapshot {
    offers: ParsedOffer[]
    reportable: ParsedOffer[]
    streaks: StreakState[]
    streakProtection: StreakProtectionState | null
    account: AccountState
}

export default class ReactFunc {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    // Parse all available data from the provided pages into one snapshot
    public snapshotPage(html: string | readonly string[]): PageSnapshot {
        const combined = this.concatFlightChunks(html)

        const offers = this.parseOffers(combined)
        const streaks = this.parseStreaks(combined)
        const streakProtection = this.parseStreakProtection(combined)
        const account = this.parseAccountData(combined)
        const accountEmail = this.bot.currentAccountEmail

        this.bot.logger.info(
            this.bot.isMobile,
            'REACT-PARSE',
            `Snapshot complete | offers=${offers.length} | reportable=${offers.filter(o => o.reportable).length} | streaks=${streaks.length} | streakProtectionEnabled=${streakProtection?.isProtectionOn ?? 'null'} | streakProtectionRemainingDays=${streakProtection?.remainingDays ?? 'null'} | streakCounter=${streakProtection?.streakCounter ?? 'null'} | level=${account.level} | account=${accountEmail ?? 'null'}`
        )

        return {
            offers,
            reportable: offers.filter(o => o.reportable),
            streaks,
            streakProtection,
            account
        }
    }
    public getStreakProtection(html: string): StreakProtectionState | null {
        return this.parseStreakProtection(this.concatFlightChunks(html))
    }

    public buildId(html: string): string | null {
        const combined = this.concatFlightChunks(html)
        return (
            html.match(/[?&](?:amp;)?dpl=([A-Za-z0-9._-]+)/i)?.[1] ??
            combined.match(/[?&](?:amp;)?dpl=([A-Za-z0-9._-]+)/i)?.[1] ??
            combined.match(/"buildId":"([A-Za-z0-9._-]+)"/)?.[1] ??
            combined.match(/"b":"([A-Za-z0-9._-]{8,})"/)?.[1] ??
            html.match(/\/_next\/static\/([A-Za-z0-9._-]+)\//)?.[1] ??
            null
        )
    }

    public availablePointsFromPayload(payload: unknown): number | null {
        if (typeof payload !== 'string') return null

        const normalized = payload.replace(/\\"/g, '"')
        const matches = [...normalized.matchAll(/"availablePoints"\s*:\s*(\d+)/g)]
        const value = Number(matches.at(-1)?.[1])

        return Number.isSafeInteger(value) && value >= 0 ? value : null
    }

    private concatFlightChunks(html: string | readonly string[]): string {
        try {
            const pushRe = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g
            const pages = typeof html === 'string' ? [html] : html
            const perPage: string[] = []
            let combined = ''
            let count = 0

            for (const page of pages) {
                let pageChunks = 0
                const before = combined.length

                for (const match of page.matchAll(pushRe)) {
                    try {
                        // Re-wrap in quotes so JSON.parse decodes
                        combined += JSON.parse(`"${match[1]}"`)
                        count++
                        pageChunks++
                    } catch (err) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'REACT-PARSE',
                            `Skipped undecodable flight chunk | error=${err instanceof Error ? err.message : String(err)}`
                        )
                    }
                }

                if (pageChunks > 0) combined += '\n'
                perPage.push(`${pageChunks}c/${combined.length - before}b`)
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Concatenated flight chunks | pages=${pages.length} | chunks=${count} | length=${combined.length} | perSource=[${perPage.join(', ')}]`
            )

            if (count === 0) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'REACT-PARSE',
                    'No __next_f flight chunks found - page may not be an RSC render or markup changed'
                )
            }

            return combined
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed concatenating flight chunks | error=${error instanceof Error ? error.message : String(error)}`
            )
            return ''
        }
    }

    // Find every object containing "anchor" and return them as parsed JSON
    private extractObjects(combined: string, anchor: string): Record<string, unknown>[] {
        const out: Record<string, unknown>[] = []
        const anchorKey = anchor.replace(/^"|"$/g, '')
        let cursor = 0
        let failures = 0

        while (cursor < combined.length) {
            const anchorIndex = combined.indexOf(anchor, cursor)
            if (anchorIndex === -1) break

            cursor = anchorIndex + anchor.length
            let start = combined.lastIndexOf('{', anchorIndex)
            let extracted = false

            while (start !== -1) {
                let depth = 0
                let end = -1
                let inStr = false
                let esc = false

                for (let j = start; j < combined.length; j++) {
                    const c = combined[j]
                    if (esc) {
                        esc = false
                        continue
                    }
                    if (inStr && c === '\\') {
                        esc = true
                        continue
                    }
                    if (c === '"') {
                        inStr = !inStr
                        continue
                    }
                    if (inStr) continue
                    if (c === '{') depth++
                    else if (c === '}') {
                        depth--
                        if (depth === 0) {
                            end = j
                            break
                        }
                    }
                }

                if (end >= anchorIndex) {
                    const raw = combined.slice(start, end + 1)

                    try {
                        const parsed = JSON.parse(raw.replace(/"\$undefined"/g, 'null')) as Record<string, unknown>
                        if (Object.prototype.hasOwnProperty.call(parsed, anchorKey)) {
                            out.push(parsed)
                            cursor = Math.max(cursor, end + 1)
                            extracted = true
                            break
                        }
                    } catch {}
                }

                start = combined.lastIndexOf('{', start - 1)
            }

            if (!extracted) failures++
        }

        if (failures > 0) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `extractObjects("${anchor}") had ${failures} unparseable matches`
            )
        }

        return out
    }

    // Section parsers
    private parseOffers(combined: string): ParsedOffer[] {
        try {
            const today = this.todayStamp()
            const offers = new Map<string, ParsedOffer>()

            for (const obj of this.extractObjects(combined, '"offerId"')) {
                const offerId = obj.offerId as string | undefined
                if (!offerId) continue

                const hash = (obj.hash as string | null) ?? null
                const isCompleted = ((obj.isCompleted ?? obj.complete) as boolean | undefined) === true
                const isLocked = (obj.isLocked as boolean | undefined) === true
                const date = this.normaliseDate(obj.date as string | undefined)
                const attributes =
                    obj.attributes && typeof obj.attributes === 'object'
                        ? (obj.attributes as Record<string, unknown>)
                        : null
                const activityTypeValue =
                    obj.activityType ?? obj.activity_type ?? attributes?.activityType ?? attributes?.activity_type
                const parsedActivityType = Number(activityTypeValue)
                const promotionalValue = obj.isPromotional ?? attributes?.promotional
                const isPromotional =
                    promotionalValue === true ||
                    (typeof promotionalValue === 'string' && promotionalValue.toLowerCase() === 'true')

                // Never try future-dated offers, lol
                const reportable = !!hash && !isCompleted && !isLocked && (date === null || date <= today)

                const candidate: ParsedOffer = {
                    offerId,
                    hash,
                    title: (obj.title as string) ?? '',
                    description: (obj.description as string) ?? '',
                    points: (obj.points as number) ?? (obj.pointProgressMax as number) ?? 0,
                    promotionSubtype: (obj.promotionSubtype as string | null) ?? null,
                    destination: (obj.destination as string) ?? (obj.destinationUrl as string) ?? '',
                    isCompleted,
                    isPromotional,
                    isLocked,
                    unlockCriteria: (obj.unlockCriteria as string | null) ?? null,
                    date,
                    activityType:
                        Number.isInteger(parsedActivityType) && parsedActivityType > 0 ? parsedActivityType : null,
                    reportable
                }

                const existing = offers.get(offerId)
                if (!existing) {
                    offers.set(offerId, candidate)
                    continue
                }

                existing.hash ??= candidate.hash
                existing.title ||= candidate.title
                existing.description ||= candidate.description
                existing.points ||= candidate.points
                existing.promotionSubtype ??= candidate.promotionSubtype
                existing.destination ||= candidate.destination
                existing.isCompleted ||= candidate.isCompleted
                existing.isPromotional ||= candidate.isPromotional
                existing.isLocked ||= candidate.isLocked
                existing.unlockCriteria ??= candidate.unlockCriteria
                existing.date ??= candidate.date
                existing.activityType ??= candidate.activityType
                existing.reportable =
                    !!existing.hash &&
                    !existing.isCompleted &&
                    !existing.isLocked &&
                    (existing.date === null || existing.date <= today)
            }

            const unique = [...offers.values()]

            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Parsed offers | total=${unique.length} | reportable=${unique.filter(o => o.reportable).length}`
            )
            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Parsed offer ids | ${unique.map(o => `${o.offerId}${o.reportable ? '' : '(skip)'}`).join(', ') || 'none'}`
            )

            return unique
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed parsing offers | error=${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    private parseStreaks(combined: string): StreakState[] {
        try {
            const streaks = this.extractObjects(combined, '"dailyPoints"')
                .filter(o => typeof o.partner === 'string' && Array.isArray(o.dailyPoints))
                .map<StreakState>(o => ({
                    partner: o.partner as string,
                    activitiesCompleted: (o.activitiesCompleted as number) ?? 0,
                    activitiesTotal: (o.activitiesTotal as number) ?? 0,
                    completedDays: (o.completedDays as number) ?? 0,
                    currentDay: (o.currentDay as number) ?? 0,
                    totalDays: (o.totalDays as number) ?? 0,
                    isCurrentDayCompleted: (o.isCurrentDayCompleted as boolean | undefined) === true,
                    isEnabled: (o.isEnabled as boolean | undefined) === true,
                    dailyPoints: o.dailyPoints as number[],
                    activationOfferId:
                        typeof o.activationOfferId === 'string' && o.activationOfferId !== '$undefined'
                            ? o.activationOfferId
                            : null,
                    activationHash:
                        typeof o.activationHash === 'string' && o.activationHash !== '$undefined'
                            ? o.activationHash
                            : null,
                    activationActivityType: (() => {
                        const parsed = Number(o.activationActivityType)
                        return Number.isInteger(parsed) && parsed > 0 ? parsed : null
                    })(),
                    destinationUrl:
                        typeof o.destinationUrl === 'string' && o.destinationUrl !== '$undefined'
                            ? o.destinationUrl
                            : null
                }))

            // de-dupe on partner
            const byPartner = new Map(streaks.map(s => [s.partner, s]))
            const unique = [...byPartner.values()]

            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Parsed streaks | ${unique.map(s => `${s.partner}:${s.completedDays}/${s.totalDays}`).join(', ') || 'none'}`
            )

            // 连续打卡的真实进度在这里已经是结构化的了（completedDays/totalDays、
            // activitiesCompleted/activitiesTotal）。debug 行面板不会入库（generic 只留
            // warn/error），所以再补一行 CHECKIN-PROGRESS，让面板按 streak-<partner> /
            // tasks-<partner> 记账，App 那三行就能显示真进度而不是"连续得分天数"的近似值。
            const progress = this.streakProgressParts(unique)
            if (progress.length) {
                this.bot.logger.info(this.bot.isMobile, 'CHECKIN-PROGRESS', progress.join(' | '))
            }

            return unique
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed parsing streaks | error=${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    /**
     * 把 streak 卡的结构化进度拼成 CHECKIN-PROGRESS 的参数：
     *   streak-bing=3/14 | tasks-bing=2/4
     * partner 有时是 URL 或带空格的显示名，所以统一 slug 化并截短；
     * 界面按关键字（bing / mobile / daily…）归类，不依赖完整名字。
     */
    private streakProgressParts(streaks: StreakState[]): string[] {
        const parts: string[] = []
        for (const s of streaks) {
            const slug =
                String(s.partner ?? '')
                    .toLowerCase()
                    .replace(/^https?:\/\//, '')
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-+|-+$/g, '')
                    .slice(0, 24) || 'unknown'
            if (s.totalDays > 0 && s.completedDays <= s.totalDays) {
                parts.push(`streak-${slug}=${s.completedDays}/${s.totalDays}`)
            }
            if (s.activitiesTotal > 0 && s.activitiesCompleted <= s.activitiesTotal) {
                parts.push(`tasks-${slug}=${s.activitiesCompleted}/${s.activitiesTotal}`)
            }
        }
        return parts
    }

    private parseStreakProtection(combined: string): StreakProtectionState | null {
        try {
            const carriers = this.extractObjects(combined, '"isProtectionOn"').filter(o => 'isProtectionOn' in o)
            if (!carriers.length) return null

            // The flag and remainingDays
            const withDays = carriers.find(o => 'remainingDays' in o && typeof o.remainingDays === 'number')
            const withFlag = carriers.find(o => typeof o.isProtectionOn === 'boolean')
            const withStreakCounter = carriers.find(o => 'streakCounter' in o && typeof o.streakCounter === 'number')

            const state: StreakProtectionState = {
                isProtectionOn: (withDays?.isProtectionOn ?? withFlag?.isProtectionOn) === true,
                remainingDays: withDays ? (withDays.remainingDays as number) : null,
                streakCounter: withStreakCounter ? (withStreakCounter.streakCounter as number) : null
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Parsed streak protection | enabled=${state.isProtectionOn} | remainingDays=${state.remainingDays ?? 'null'} | streakCounter=${state.streakCounter}`
            )

            return state
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed parsing streak protection | error=${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    private parseAccountData(combined: string): AccountState {
        const empty: AccountState = {
            level: null,
            pointsProgress: null,
            pointsRemaining: null,
            lifetimeEarn: null,
            availablePoints: null
        }

        try {
            const membership =
                this.extractObjects(combined, '"pointsProgress"').find(
                    o => 'pointsRemaining' in o || 'lifetimeEarn' in o
                ) ?? {}

            // availablePoints renders in a separate header object
            const header = this.extractObjects(combined, '"availablePoints"').find(o => 'availablePoints' in o) ?? {}

            const account: AccountState = {
                level: (membership.level as number) ?? null,
                pointsProgress: (membership.pointsProgress as number) ?? null,
                pointsRemaining: (membership.pointsRemaining as number) ?? null,
                lifetimeEarn: (membership.lifetimeEarn as number) ?? null,
                availablePoints: (header.availablePoints as number) ?? (membership.availablePoints as number) ?? null
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Parsed account | level=${account.level} | available=${account.availablePoints} | toGo=${account.pointsRemaining} | lifetime=${account.lifetimeEarn}`
            )

            if (account.level === null && account.availablePoints === null) {
                // Common error! Keep however for debugging!
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'REACT-PARSE',
                    'Account state empty - membership/header objects not found in payload'
                )
            }

            return account
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed parsing account | error=${error instanceof Error ? error.message : String(error)}`
            )
            return empty
        }
    }

    public routerStateTree(segment: string): string {
        const refreshFlag = 4096
        const tree = [
            '',
            {
                children: [
                    '(nav)',
                    {
                        children: [
                            segment,
                            { children: ['PAGE', {}, null, null, refreshFlag] },
                            null,
                            null,
                            refreshFlag
                        ]
                    },
                    null,
                    null,
                    refreshFlag
                ]
            },
            null,
            null,
            refreshFlag + 16
        ]
        return encodeURIComponent(JSON.stringify(tree))
    }

    public questRouterStateTree(questId: string): string {
        const tree = [
            '',
            {
                children: [
                    '(nav)',
                    {
                        children: [
                            'earn',
                            {
                                children: [
                                    'quest',
                                    {
                                        children: [
                                            ['questId', questId, 'd', null],
                                            { children: ['__PAGE__', {}, null, null, 0] },
                                            null,
                                            null,
                                            0
                                        ]
                                    },
                                    null,
                                    null,
                                    0
                                ]
                            },
                            null,
                            null,
                            0
                        ]
                    },
                    null,
                    null,
                    0
                ]
            },
            null,
            null,
            16
        ]
        return encodeURIComponent(JSON.stringify(tree))
    }

    // Pull server-action ids out of a JS chunk
    public extractActionIds(jsText: string): {
        byName: Record<string, string>
        all: string[]
    } {
        const byName: Record<string, string> = {}
        const all = new Set<string>()

        // SHA-1 today (40 hex), allow growth to SHA-256 (64 hex)
        const HEX = '[a-f0-9]{40,64}'

        // Framework args that share the call shape but aren't the action name
        const KNOWN_NON_NAMES = new Set(['callServer', 'findSourceMapURL', 'encodeFormAction', 'default'])

        try {
            // Support for both formats: (createServerReference)(id) and createServerReference(id)
            // The argument search window has been expanded to 800 characters for Turbopack
            const createRegex = new RegExp(
                `createServerReference\\s*\\)?\\s*\\(\\s*"(${HEX})"([\\s\\S]{0,800}?)\\)`,
                'g'
            )
            const registerRegex = new RegExp(
                `registerServerReference\\s*\\)?\\s*\\([^,]+,\\s*"(${HEX})"([\\s\\S]{0,800}?)\\)`,
                'g'
            )

            const strLitRe = /"([A-Za-z_$][\w$]*)"/g

            const processMatches = (matches: IterableIterator<RegExpMatchArray>) => {
                for (const m of matches) {
                    const id = m[1]!
                    const argsBlock = m[2] ?? ''
                    all.add(id)

                    const candidates = [...argsBlock.matchAll(strLitRe)]
                        .map(x => x[1]!)
                        .filter(n => !KNOWN_NON_NAMES.has(n) && n.length > 3)

                    if (candidates.length) {
                        byName[candidates[candidates.length - 1]!] = id
                    }
                }
            }

            processMatches(jsText.matchAll(createRegex))
            processMatches(jsText.matchAll(registerRegex))

            const bareCreateRegex = new RegExp(`createServerReference\\s*\\)?\\s*\\(\\s*"(${HEX})"`, 'g')
            const bareRegisterRegex = new RegExp(`registerServerReference\\s*\\)?\\s*\\([^,]+,\\s*"(${HEX})"`, 'g')

            for (const m of jsText.matchAll(bareCreateRegex)) all.add(m[1]!)
            for (const m of jsText.matchAll(bareRegisterRegex)) all.add(m[1]!)

            const actionIdRe = new RegExp(`\\$ACTION_ID_(${HEX})`, 'g')
            for (const m of jsText.matchAll(actionIdRe)) all.add(m[1]!)

            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Extracted action ids | named=${Object.keys(byName).length} | total=${all.size}`
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed extracting action ids | error=${error instanceof Error ? error.message : String(error)}`
            )
        }

        return { byName, all: [...all] }
    }

    // Quest pages (punchcards)
    public snapshotQuestPage(html: string): QuestChild[] {
        try {
            const combined = this.concatFlightChunks(html)
            const children = this.parseQuestOffers(combined)

            this.bot.logger.info(
                this.bot.isMobile,
                'REACT-PARSE',
                `Quest snapshot | children=${children.length} | reportable=${children.filter(c => c.reportable).length}`
            )

            return children
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed parsing quest page | error=${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    private parseQuestOffers(combined: string): QuestChild[] {
        const out: QuestChild[] = []
        const seen = new Set<string>()

        for (const obj of this.extractObjects(combined, '"offerId"')) {
            const offerId = obj.offerId as string | undefined
            if (!offerId || !offerId.includes('pcchild') || seen.has(offerId)) continue
            seen.add(offerId)

            const hash = (obj.hash as string | null) ?? null
            const points = (obj.points as number) ?? (obj.pointProgressMax as number) ?? 0
            const isCompleted = ((obj.isCompleted ?? obj.complete) as boolean | undefined) === true
            const isLocked = (obj.isLocked as boolean | undefined) === true
            const isDisabled = (obj.isDisabled as boolean | undefined) === true

            const reportable = !!hash && !isCompleted && !isLocked && !isDisabled

            out.push({
                offerId,
                hash,
                points,
                isCompleted,
                isLocked,
                isDisabled,
                reportable
            })
        }

        this.bot.logger.debug(
            this.bot.isMobile,
            'REACT-PARSE',
            `Parsed quest children | total=${out.length} | reportable=${out.filter(c => c.reportable).length}`
        )

        return out
    }

    public snapshotQuestList(...htmls: string[]): ParentQuest[] {
        try {
            const combined = htmls.map(h => this.concatFlightChunks(h)).join('')

            const anchors: { id: string; at: number }[] = []
            for (const match of combined.matchAll(/\/earn\/quest\/([A-Za-z0-9_]+)/g)) {
                anchors.push({ id: match[1] as string, at: match.index ?? 0 })
            }
            for (const match of combined.matchAll(/"id":"quest_([A-Za-z0-9_]+)"/g)) {
                anchors.push({ id: match[1] as string, at: match.index ?? 0 })
            }
            for (const match of combined.matchAll(/[A-Za-z0-9_]*pcparent[A-Za-z0-9_]*/gi)) {
                anchors.push({ id: match[0] as string, at: match.index ?? 0 })
            }
            anchors.sort((a, b) => a.at - b.at)

            const byId = new Map<string, ParentQuest>()
            for (let k = 0; k < anchors.length; k++) {
                const { id, at } = anchors[k]!
                if (!this.isParentQuestId(id)) continue

                const next = anchors[k + 1]?.at ?? combined.length
                const region = combined.slice(at, Math.min(next, at + 3000))

                const title =
                    region.match(/"alt":"((?:[^"\\]|\\.)*)"/)?.[1] ??
                    region.match(/"title":"((?:[^"\\]|\\.)*)"/)?.[1] ??
                    ''

                const pointsMatch = region.match(/\["\+","([\d,]+)"\]/)
                const points = pointsMatch ? Number(pointsMatch[1]!.replace(/,/g, '')) : 0
                // 印章收集的进度文本。中文界面是 "3 / 12 个任务"，英文是 "3 / 12 tasks"，
                // 而 Next.js 的 flight 数组常把数字和文字切成相邻的两段（["3 / 12","个任务"]），
                // 所以中间允许最多 12 个非数字字符；再兜一层：这段里出现了"任务/tasks"，
                // 就取第一个分母不超过 40 的 n/m（分数、积分那种大分母不会误伤）。
                const tasks = this.parseTaskProgress(region)
                const tasksDone = tasks?.done ?? null
                const tasksMax = tasks?.max ?? null
                const complete = !!tasks && tasks.done >= tasks.max

                // First wins for title/points
                const prev = byId.get(id)
                byId.set(id, {
                    offerId: id,
                    title: prev?.title || title,
                    pointProgressMax: prev?.pointProgressMax || points,
                    complete: prev?.complete || complete,
                    // 同一个 parent 会在多个 Suspense 块里出现，带 tasks 的那块不一定先到：
                    // 谁先给出非空进度就用谁
                    tasksDone: prev?.tasksDone ?? tasksDone,
                    tasksMax: prev?.tasksMax ?? tasksMax
                })
            }

            const out = [...byId.values()]
            // 印章收集的真实进度是页面里那句 "3 / 12 tasks"。以前只拿它判 complete，
            // 数字当场丢掉，面板就只能显示"几张卡、几张没完成"。这里报"正在集的那张"：
            // 第一张未完成的卡；都完成了就报格子最多的那张。
            const withTasks = out.filter(q => (q.tasksMax ?? 0) > 0)
            const active =
                withTasks.find(q => !q.complete) ??
                [...withTasks].sort((a, b) => (b.tasksMax ?? 0) - (a.tasksMax ?? 0))[0]
            const stamps = active?.tasksMax ? ` | stamps=${active.tasksDone ?? 0}/${active.tasksMax}` : ''
            this.bot.logger.info(
                this.bot.isMobile,
                'REACT-PARSE',
                `Quest list | parents=${out.length} | incomplete=${out.filter(q => !q.complete).length}${stamps}`
            )
            this.bot.logger.debug(
                this.bot.isMobile,
                'REACT-PARSE',
                `Quest points | ${out.map(q => `${q.title || q.offerId}=${q.pointProgressMax}${q.tasksMax ? ` (${q.tasksDone ?? 0}/${q.tasksMax} 任务)` : ' (没解析到任务进度)'}`).join(' | ') || 'none'}`
            )
            if (!out.length) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'REACT-PARSE',
                    'No parent quests parsed - the fetched HTML may be missing the QuestSection chunks (Suspense/streaming or a login redirect)'
                )
            }
            return out
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'REACT-PARSE',
                `Failed parsing quest list | error=${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    // <campaign>_pcparent_<name>_punchcard
    /**
     * 从一张印章卡的文本块里取 "已完成 / 总数" 的进度。
     * 见调用处的注释：中英语言、flight 分段都要吃到，且不能把积分那种大数字当进度。
     */
    private parseTaskProgress(region: string): { done: number; max: number } | null {
        const word = '(?:tasks?|quests?|个任务|個任務|项任务|項任務|任务|印章|stamps?)'
        const take = (m: RegExpExecArray | null) => {
            if (!m) return null
            const done = Number(m[1])
            const max = Number(m[2])
            if (!Number.isFinite(done) || !Number.isFinite(max) || max <= 0 || max > 40 || done > max) return null
            return { done, max }
        }
        const tight = take(new RegExp(`(\\d+)\\s*\\/\\s*(\\d+)[^\\d]{0,12}${word}`, 'i').exec(region))
        if (tight) return tight
        if (!new RegExp(word, 'i').test(region)) return null
        // 退一步：这段里确实有"任务/tasks"，取第一个像样的小分数
        for (const m of region.matchAll(/(\d+)\s*\/\s*(\d+)/g)) {
            const found = take(m as unknown as RegExpExecArray)
            if (found) return found
        }
        return null
    }

    private isParentQuestId(offerId: string): boolean {
        const id = offerId.toLowerCase()
        if (id.includes('pcchild')) return false
        return id.includes('pcparent') || id.includes('punchcard')
    }

    // Utils
    private todayStamp(): string {
        const d = new Date()
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    private normaliseDate(rawDate: string | undefined): string | null {
        if (!rawDate) return null
        const m = rawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
        if (!m) return null
        return `${m[3]}-${m[1]}-${m[2]}`
    }
}
