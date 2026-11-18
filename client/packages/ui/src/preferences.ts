// 用户对语言和外观的选择。目前保存在浏览器本地；有了账号之后同时保存到账号。

import { create } from 'zustand'
import { i18n, initI18n, type Language } from './i18n'

export type ThemePreference = 'light' | 'dark' | 'system'

// 这两个名称和取值与 apps/web/public/theme-init.js 里的一致，改动时要一起改
const THEME_KEY = 'vc.theme'
const LANGUAGE_KEY = 'vc.lang'

const DARK_QUERY = '(prefers-color-scheme: dark)'

// 浏览器可能禁用本地存储（如隐私模式），读写失败时按没有保存过处理
function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存不下来就只在本次打开期间生效
  }
}

function storedTheme(): ThemePreference {
  const value = read(THEME_KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

function storedLanguage(): Language {
  const value = read(LANGUAGE_KEY)
  if (value === 'zh-CN' || value === 'en') return value
  // 没有选择过：中文环境显示中文，其余显示英文
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

function applyTheme(preference: ThemePreference): void {
  const dark =
    preference === 'dark' || (preference === 'system' && window.matchMedia(DARK_QUERY).matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

function applyLanguage(language: Language): void {
  document.documentElement.lang = language
}

interface Preferences {
  theme: ThemePreference
  language: Language
  setTheme: (theme: ThemePreference) => void
  setLanguage: (language: Language) => void
}

export const usePreferences = create<Preferences>((set) => ({
  theme: storedTheme(),
  language: storedLanguage(),
  setTheme: (theme) => {
    write(THEME_KEY, theme)
    applyTheme(theme)
    set({ theme })
  },
  setLanguage: (language) => {
    write(LANGUAGE_KEY, language)
    applyLanguage(language)
    void i18n.changeLanguage(language)
    set({ language })
  },
}))

/** 登录后以账号里保存的选择为准。账号里没有保存过的项目保持本机的选择。 */
export function adoptAccountPreferences(account: {
  language: Language | null
  theme: ThemePreference | null
}): void {
  const { language, theme, setLanguage, setTheme } = usePreferences.getState()
  if (account.language && account.language !== language) setLanguage(account.language)
  if (account.theme && account.theme !== theme) setTheme(account.theme)
}

/** 应用启动时调用一次：让保存的选择生效，并在系统外观变化时跟着变。 */
export function initPreferences(): void {
  const { theme, language } = usePreferences.getState()
  initI18n(language)
  applyLanguage(language)
  applyTheme(theme)
  window.matchMedia(DARK_QUERY).addEventListener('change', () => {
    applyTheme(usePreferences.getState().theme)
  })
}
