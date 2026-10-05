import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'

export class EmailLogin {
    private submitButton = 'button[type="submit"]'

    constructor(private bot: MicrosoftRewardsBot) {}

    async enterEmail(page: Page, email: string): Promise<'ok' | 'error'> {
        try {
            const emailInputSelector = 'input[type="email"]'
            const emailField = await page
                .waitForSelector(emailInputSelector, { state: 'visible', timeout: 1000 })
                .catch(() => {})
            if (!emailField) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '未找到邮箱字段')
                return 'error'
            }

            await this.bot.utils.wait(1000)

            const prefilledEmail = await page
                .waitForSelector('#userDisplayName', { state: 'visible', timeout: 1000 })
                .catch(() => {})
            if (!prefilledEmail) {
                await page.fill(emailInputSelector, '').catch(() => {})
                await this.bot.utils.wait(500)
                await page.fill(emailInputSelector, email).catch(() => {})
                await this.bot.utils.wait(1000)
            } else {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '邮箱已预填充')
            }

            const submitButton = await page
                .waitForSelector(this.submitButton, { state: 'visible', timeout: 2000 })
                .catch(() => null)
            if (!submitButton) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '未找到提交按钮')
                return 'error'
            }

            const clicked = await this.bot.browser.utils.ghostClick(page, this.submitButton)
            if (!clicked) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '无法提交邮箱')
                return 'error'
            }
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '邮箱已提交')

            return 'ok'
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-ENTER-EMAIL',
                `发生错误: ${error instanceof Error ? error.message : String(error)}`
            )
            return 'error'
        }
    }

    async enterPassword(page: Page, password: string): Promise<'ok' | 'needs-2fa' | 'error'> {
        try {
            // deploy:password-race 状态机检测的是 [data-testid="passwordEntry"]（checkSelector 等 5 秒），
            // 而真正的 <input> 在客户端切换出来的密码视图里会晚一点挂载；原来只等 1 秒且选择器单一，
            // 桌面阶段经常在这里误判"未找到密码字段"，进而让整轮以致命错误中止、已挣积分统计一起归零。
            const passwordInputSelector = 'input[type="password"], input[name="passwd"]'
            const waitForPassword = () =>
                page.waitForSelector(passwordInputSelector, { state: 'visible', timeout: 10000 }).catch(() => undefined)

            let passwordField = await waitForPassword()
            if (!passwordField) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '密码字段暂未出现，重试一次')
                await this.bot.utils.wait(2000)
                passwordField = await waitForPassword()
            }
            if (!passwordField) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '未找到密码字段')
                return 'error'
            }

            await this.bot.utils.wait(1000)
            // 用已解析到的元素句柄填写，避免逗号选择器在严格模式下歧义
            await passwordField.fill('').catch(() => {})
            await this.bot.utils.wait(500)
            await passwordField.fill(password).catch(() => {})
            await this.bot.utils.wait(1000)

            const submitButton = await page
                .waitForSelector(this.submitButton, { state: 'visible', timeout: 2000 })
                .catch(() => null)

            if (!submitButton) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '未找到提交按钮')
                return 'error'
            }

            const clicked = await this.bot.browser.utils.ghostClick(page, this.submitButton)
            if (!clicked) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '无法提交密码')
                return 'error'
            }
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '密码已提交')

            return 'ok'
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-ENTER-PASSWORD',
                `发生错误: ${error instanceof Error ? error.message : String(error)}`
            )
            return 'error'
        }
    }
}
