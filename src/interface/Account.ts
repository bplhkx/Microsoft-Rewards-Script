export interface Account {
    email: string
    password: string
    totpSecret?: string
    recoveryEmail: string
    geoLocale: string
    langCode: string
    proxy: AccountProxy
    saveFingerprint: ConfigSaveFingerprint
    // deploy:account-platforms 该账号跑哪一端的搜索/活动：both | mobile | desktop
    platforms: 'both' | 'mobile' | 'desktop'
}

export interface AccountProxy {
    proxyHttp: boolean
    url: string
    port: number
    password: string
    username: string
}

export interface ConfigSaveFingerprint {
    mobile: boolean
    desktop: boolean
}
