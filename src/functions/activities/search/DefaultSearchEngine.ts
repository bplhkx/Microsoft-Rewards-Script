import type { Page } from 'patchright'

import { URLs } from '../../../constants/urls'
import type { DashboardData } from '../../../interface/DashboardData'
import type { AppDashboardData } from '../../../interface/AppDashBoardData'
import { BaseActivity } from '../BaseActivity'
import { SearchQueryQueue } from '../../SearchQueryQueue'

const LOG_TAG = 'DEFAULT-SEARCH-ENGINE'
const LEVEL_INFO_PROMOTION = 'level_info'

const MAX_ATTEMPTS = 3
const POST_SEARCH_WAIT_MIN_MS = 3_000
const POST_SEARCH_WAIT_MAX_MS = 6_000

// Used only when the query engine cannot provide Chinese/English topics.
const FALLBACK_QUERIES = ['bing rewards', 'microsoft rewards', '今日热点新闻', '天气预报']

export interface DefaultSearchEngineState {
    days: number
    daysMax: number
    source: 'app' | 'web'
}

/**
 * "设置 Bing 为默认搜索引擎" / "Set Bing as your default search engine" level-up activity.
 *
 * Microsoft credits one day whenever the account performs a Bing search that
 * carries the Chrome default-provider form code (`PC=U316&FORM=CHROMN`), which
 * is the search template Chrome uses once Bing is set as the default engine.
 * Replaying one such search per day is therefore enough to keep the activity
 * moving towards its 14-day target.
 */
export class DefaultSearchEngine extends BaseActivity {
    public async run(page: Page, data: DashboardData, appData: AppDashboardData | null): Promise<void> {
        try {
            const state = this.resolveState(data, appData)
            if (!state) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    LOG_TAG,
                    '默认搜索引擎活动在本账户不可用（仪表板未提供 hva_dse 进度）'
                )
                return
            }

            if (state.days >= state.daysMax) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    LOG_TAG,
                    `默认搜索引擎活动已完成 | ${state.days}/${state.daysMax} 天 | 来源=${state.source}`
                )
                return
            }

            this.bot.logger.info(
                this.bot.isMobile,
                LOG_TAG,
                `开始默认搜索引擎打卡 | 进度=${state.days}/${state.daysMax} 天 | 来源=${state.source}` +
                    ` | 目标=每日一次带 FORM=CHROMN 的 Bing 搜索`
            )

            const queries = await this.buildQueries()
            let gained = false

            for (let attempt = 1; attempt <= MAX_ATTEMPTS && !gained; attempt++) {
                const query = queries[(attempt - 1) % queries.length] ?? FALLBACK_QUERIES[0] ?? 'bing rewards'

                this.bot.logger.debug(
                    this.bot.isMobile,
                    LOG_TAG,
                    `第 ${attempt}/${MAX_ATTEMPTS} 次尝试 | query="${query}"`
                )

                try {
                    await page.goto(URLs.bing.dseSearch(query), { waitUntil: 'domcontentloaded' })
                    await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})
                } catch (error) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        LOG_TAG,
                        `搜索页面打开失败 | attempt=${attempt} | ${error instanceof Error ? error.message : String(error)}`
                    )
                    continue
                }

                await this.bot.utils.wait(this.bot.utils.randomDelay(POST_SEARCH_WAIT_MIN_MS, POST_SEARCH_WAIT_MAX_MS))

                const refreshed = await this.refreshState()
                if (!refreshed) {
                    this.bot.logger.debug(this.bot.isMobile, LOG_TAG, `无法刷新进度，跳过本次校验 | attempt=${attempt}`)
                    continue
                }

                if (refreshed.days > state.days) {
                    gained = true
                    this.bot.logger.info(
                        this.bot.isMobile,
                        LOG_TAG,
                        `默认搜索引擎打卡成功 | ${refreshed.days}/${refreshed.daysMax} 天 | 来源=${refreshed.source}`,
                        'green'
                    )
                    break
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    LOG_TAG,
                    `进度未变（仍为 ${refreshed.days}/${refreshed.daysMax} 天）；今日可能已打卡或该搜索未被计入`
                )
            }

            if (!gained) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    LOG_TAG,
                    `默认搜索引擎打卡未确认成功 | 进度仍为 ${state.days}/${state.daysMax} 天 | attempts=${MAX_ATTEMPTS}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                LOG_TAG,
                `默认搜索引擎活动失败 | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    /**
     * Reads the current progress without touching the network so callers can
     * decide whether a browser session is worth opening at all.
     */
    public resolveState(data: DashboardData, appData: AppDashboardData | null): DefaultSearchEngineState | null {
        return this.fromAppDashboard(appData) ?? this.fromWebDashboard(data)
    }

    private fromAppDashboard(appData: AppDashboardData | null): DefaultSearchEngineState | null {
        const attributes = appData?.response?.promotions?.find(
            promotion => promotion.name === LEVEL_INFO_PROMOTION
        )?.attributes
        if (!attributes) return null

        const days = Number(attributes['hva_dse_days'])
        const daysMax = Number(attributes['hva_dse_days_max'])
        if (!Number.isFinite(days) || !Number.isFinite(daysMax) || daysMax <= 0) return null

        return { days, daysMax, source: 'app' }
    }

    private fromWebDashboard(data: DashboardData): DefaultSearchEngineState | null {
        const levelInfo = data?.dashboard?.userStatus?.levelInfo as
            | {
                  levelUpActivityDefaultSearchEngineDays?: number
                  hvaLevelUpActivityDefaultSearchEngineDays_V2?: string
                  hvaLevelUpActivityDefaultSearchEngineDaysMax_V2?: string
              }
            | undefined
        if (!levelInfo) return null

        const rawDays = levelInfo.hvaLevelUpActivityDefaultSearchEngineDays_V2
        const days = Number(rawDays ?? levelInfo.levelUpActivityDefaultSearchEngineDays)
        const daysMax = Number(levelInfo.hvaLevelUpActivityDefaultSearchEngineDaysMax_V2)
        if (!Number.isFinite(days) || !Number.isFinite(daysMax) || daysMax <= 0) return null

        return { days, daysMax, source: 'web' }
    }

    private async refreshState(): Promise<DefaultSearchEngineState | null> {
        if (this.bot.accessToken) {
            try {
                const appData = await this.bot.browser.func.getAppDashboardData()
                const state = this.fromAppDashboard(appData)
                if (state) return state
            } catch (error) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    LOG_TAG,
                    `刷新 App 进度失败 | ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        try {
            return this.fromWebDashboard(await this.bot.browser.func.getDashboardData())
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                LOG_TAG,
                `刷新 Web 进度失败 | ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    private async buildQueries(): Promise<string[]> {
        const fallback = this.bot.utils.shuffleArray([...FALLBACK_QUERIES])

        try {
            const queue = new SearchQueryQueue(this.bot)
            const topicCount = await queue.prepare()
            if (!topicCount) return fallback

            const queries: string[] = []
            for (let index = 0; index < MAX_ATTEMPTS; index++) {
                const query = await queue.next()
                if (!query) break
                queries.push(query)
            }

            return queries.length ? queries : fallback
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                LOG_TAG,
                `查询词生成失败，改用内置词库 | ${error instanceof Error ? error.message : String(error)}`
            )
            return fallback
        }
    }
}
