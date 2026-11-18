import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { createContext, useContext, useEffect } from 'react'
import type { Platform } from './platform'
import { initPreferences, usePreferences } from './preferences'
import { router } from './router'
import { queryClient } from './session'
import { Toaster } from './toast'

// 在渲染之前让保存的语言和外观生效
initPreferences()

const PlatformContext = createContext<Platform | null>(null)

/** 取得当前平台（Web 或 Desktop）提供的能力。 */
export function usePlatform(): Platform {
  const platform = useContext(PlatformContext)
  if (!platform) throw new Error('usePlatform must be used inside App')
  return platform
}

export function App({ platform }: { platform: Platform }) {
  // 桌面端的系统菜单跟着界面的语言走
  const language = usePreferences((state) => state.language)
  useEffect(() => {
    platform.setLanguage(language)
  }, [platform, language])

  return (
    <PlatformContext value={platform}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster />
      </QueryClientProvider>
    </PlatformContext>
  )
}
