// "连不上服务器"页面。主进程每隔几秒自己重试一次，连上了就离开这一页；
// 这里只负责显示文字，和把"重试"按钮的点击告诉主进程。
const TEXT = {
  'zh-CN': {
    title: '连不上服务器',
    detail: '请检查网络。恢复之后会自动进入。',
    retry: '重试',
    retrying: '正在重试…',
  },
  en: {
    title: "Can't reach the server",
    detail: "Check your connection. You'll be taken in as soon as it's back.",
    retry: 'Retry',
    retrying: 'Retrying…',
  },
}

const params = new URLSearchParams(location.search)
const text = TEXT[params.get('lang')] ?? TEXT.en
document.documentElement.lang = params.get('lang') ?? 'en'
document.getElementById('title').textContent = text.title
document.getElementById('detail').textContent = text.detail
document.getElementById('server').textContent = params.get('server') ?? ''

const button = document.getElementById('retry')
button.textContent = text.retry
button.addEventListener('click', () => {
  button.disabled = true
  button.textContent = text.retrying
  window.vibeOffline?.retry()
  // 这一次没连上的话主进程不会带页面离开：过一会儿让按钮恢复
  setTimeout(() => {
    button.disabled = false
    button.textContent = text.retry
  }, 3000)
})
