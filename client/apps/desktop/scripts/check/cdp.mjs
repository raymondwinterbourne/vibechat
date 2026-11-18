// 通过调试口和正在运行的应用说话：在主进程里或者页面里执行一段代码，拿回结果。
// 只用 Node 自带的东西。在 Mac 上由应用自己的 Electron 当作 Node 来运行（见 scripts/mac check）。

/** 连到一个调试口上的第一个目标。`pick` 用来在几个目标里选。 */
export async function connect(port, pick = () => true) {
  const listed = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  })
  const targets = await listed.json()
  const target = targets.find(pick)
  if (!target) throw new Error(`调试口 ${port} 上没有要找的目标`)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error(`连不上调试口 ${port}`))
    setTimeout(() => reject(new Error(`连不上调试口 ${port}`)), 3000)
  })
  let next = 1
  const waiting = new Map()
  socket.onmessage = (message) => {
    const reply = JSON.parse(message.data)
    const done = waiting.get(reply.id)
    if (!done) return
    waiting.delete(reply.id)
    done(reply)
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = next++
      waiting.set(id, resolve)
      socket.send(JSON.stringify({ id, method, params }))
      // 对面没了（应用退出、页面换了）就不会有回音：不能一直等下去
      setTimeout(() => {
        if (waiting.delete(id)) reject(new Error(`调试口 ${port} 没有回音`))
      }, 10_000)
    })
  return {
    url: target.url,
    /** 执行一段代码，返回它的值。代码可以是一个返回 Promise 的表达式。 */
    async evaluate(expression) {
      const reply = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      const failure = reply.error ?? reply.result?.exceptionDetails
      if (failure) {
        const text = failure.exception?.description ?? failure.text ?? failure.message
        throw new Error(`执行失败：${text}`)
      }
      return reply.result.result.value
    },
    close: () => socket.close(),
  }
}
