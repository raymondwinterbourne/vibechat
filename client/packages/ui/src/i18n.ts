// 界面文字的中英文资源。界面上的全部文字都来自这里，代码里不写死文字。

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import enAdmin from '../locales/en/admin.json'
import enAuth from '../locales/en/auth.json'
import enChats from '../locales/en/chats.json'
import enCommon from '../locales/en/common.json'
import enContacts from '../locales/en/contacts.json'
import enErrors from '../locales/en/errors.json'
import enNav from '../locales/en/nav.json'
import enSettings from '../locales/en/settings.json'
import zhAdmin from '../locales/zh-CN/admin.json'
import zhAuth from '../locales/zh-CN/auth.json'
import zhChats from '../locales/zh-CN/chats.json'
import zhCommon from '../locales/zh-CN/common.json'
import zhContacts from '../locales/zh-CN/contacts.json'
import zhErrors from '../locales/zh-CN/errors.json'
import zhNav from '../locales/zh-CN/nav.json'
import zhSettings from '../locales/zh-CN/settings.json'

export type Language = 'zh-CN' | 'en'

// 语言的名称不翻译：每种语言都用它自己的文字显示，不认识当前界面语言的人也能找到
export const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
]

const zh = {
  admin: zhAdmin,
  auth: zhAuth,
  chats: zhChats,
  common: zhCommon,
  contacts: zhContacts,
  errors: zhErrors,
  nav: zhNav,
  settings: zhSettings,
}

// 类型标注保证英文和中文有完全相同的条目，漏翻一条就过不了类型检查
const en: typeof zh = {
  admin: enAdmin,
  auth: enAuth,
  chats: enChats,
  common: enCommon,
  contacts: enContacts,
  errors: enErrors,
  nav: enNav,
  settings: enSettings,
}

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: typeof zh
  }
}

export function initI18n(language: Language): void {
  void i18n.use(initReactI18next).init({
    resources: { 'zh-CN': zh, en },
    lng: language,
    fallbackLng: 'en',
    defaultNS: 'common',
    interpolation: {
      // React 已经会转义插入的内容
      escapeValue: false,
    },
  })
}

export { i18n }
