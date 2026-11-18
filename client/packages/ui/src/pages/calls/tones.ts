// 来电铃声和回铃音：浏览器现场生成，不放音频文件（F3 任务清单第 4 章）。
//
// 浏览器要求用户和页面互动过才放声音：页面打开后一下都没点过时，来电可能不响，只有系统通知。

export type Tone =
  /** 来电：两声一组，隔一会儿再响。 */
  | 'ring'
  /** 打出去等对方接：嘟——（一秒响、四秒停，和电话里听到的一样）。 */
  | 'ringback'

interface Pattern {
  /** 频率，赫兹。两个频率叠在一起的听起来像电话铃。 */
  frequencies: number[]
  /** 每一段 [开始, 结束]，秒，在一个周期里。 */
  bursts: [number, number][]
  period: number
  volume: number
}

const PATTERNS: Record<Tone, Pattern> = {
  ring: {
    frequencies: [440, 480],
    bursts: [
      [0, 0.4],
      [0.6, 1.0],
    ],
    period: 3,
    volume: 0.12,
  },
  ringback: { frequencies: [425], bursts: [[0, 1]], period: 5, volume: 0.08 },
}

/** 开始放，交回停下的函数。浏览器放不了声音时什么也不做。 */
export function playTone(tone: Tone): () => void {
  let context: AudioContext
  try {
    context = new AudioContext()
  } catch {
    return () => {}
  }
  void context.resume().catch(() => {})
  const pattern = PATTERNS[tone]
  const output = context.createGain()
  output.gain.value = pattern.volume
  output.connect(context.destination)

  // 一次排好一个周期，快到头时再排下一个
  let next = context.currentTime + 0.05
  function schedule() {
    for (const [start, end] of pattern.bursts) {
      const envelope = context.createGain()
      envelope.gain.setValueAtTime(0, next + start)
      envelope.gain.linearRampToValueAtTime(1, next + start + 0.02)
      envelope.gain.setValueAtTime(1, next + end - 0.02)
      envelope.gain.linearRampToValueAtTime(0, next + end)
      envelope.connect(output)
      for (const frequency of pattern.frequencies) {
        const oscillator = context.createOscillator()
        oscillator.frequency.value = frequency
        oscillator.connect(envelope)
        oscillator.start(next + start)
        oscillator.stop(next + end)
      }
    }
    next += pattern.period
  }
  schedule()
  const timer = window.setInterval(() => {
    if (next - context.currentTime < 1) schedule()
  }, 250)
  return () => {
    window.clearInterval(timer)
    void context.close().catch(() => {})
  }
}
