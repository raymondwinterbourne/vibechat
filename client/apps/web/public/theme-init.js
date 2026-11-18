// 在页面渲染之前确定外观，避免先闪一下浅色再变成深色。
// 这是一个独立的小文件而不是写在页面里的脚本，因为内容安全策略只允许加载本站的脚本文件。
// 名称和判断方式与 packages/ui/src/preferences.ts 一致，改动时要一起改。
;(() => {
  let preference = null
  try {
    preference = localStorage.getItem('vc.theme')
  } catch {
    // 本地存储不可用时按"跟随系统"处理
  }
  const dark =
    preference === 'dark' ||
    (preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
})()
