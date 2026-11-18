// 操作结果的提示：在页面底部出现几秒钟后自动消失。

import { create } from 'zustand'

type Kind = 'success' | 'error'

interface Toast {
  id: number
  kind: Kind
  text: string
}

interface ToastState {
  toasts: Toast[]
  show: (kind: Kind, text: string) => void
}

const DURATION_MS = 4000
let nextId = 1

const useToasts = create<ToastState>((set) => ({
  toasts: [],
  show: (kind, text) => {
    const id = nextId++
    set((state) => ({ toasts: [...state.toasts, { id, kind, text }] }))
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
    }, DURATION_MS)
  },
}))

export const toast = {
  success: (text: string) => useToasts.getState().show('success', text),
  error: (text: string) => useToasts.getState().show('error', text),
}

export function Toaster() {
  const toasts = useToasts((state) => state.toasts)
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6">
      {toasts.map((item) => (
        <output
          key={item.id}
          data-testid="toast"
          className={`rounded-card border border-border bg-surface px-3 py-2 shadow-float ${
            item.kind === 'error' ? 'text-danger' : 'text-fg'
          }`}
        >
          {item.text}
        </output>
      ))}
    </div>
  )
}
