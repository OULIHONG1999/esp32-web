/**
 * 烧录提示音（Web Audio 合成，零音频文件依赖）——完成音 / 错误音。
 *
 * 浏览器自动播放策略：AudioContext 必须在**用户手势**中创建或恢复，否则一直挂在
 * suspended 上，请求发出也没声音。而"烧录完成"发生在点击之后好几分钟——那时手势
 * 早已过期。因此：`primeAudio()` 挂在首次点击/按键上先把它解锁（App 侧一次性监听），
 * 之后的 playFlashOk / playFlashErr 才真的响。
 *
 * 静音环境、不支持 Web Audio、用户关掉声音开关——一律静默降级，绝不抛错打断烧录流程。
 */

const SOUND_KEY = 'fw.sound'

let ctx: AudioContext | null = null
let enabled = readEnabled()

function readEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(SOUND_KEY) !== '0'
  } catch {
    return true
  }
}

/** 声音开关（默认开；localStorage 持久） */
export function isSoundEnabled(): boolean {
  return enabled
}

export function setSoundEnabled(v: boolean): void {
  enabled = v
  try {
    globalThis.localStorage?.setItem(SOUND_KEY, v ? '1' : '0')
  } catch {
    /* 私隐模式忽略 */
  }
}

/**
 * 在用户手势中调用一次：创建并恢复 AudioContext（解锁自动播放）。
 * 可重复调用，代价只有一次 state 判断。
 */
export function primeAudio(): void {
  const ac = ensureCtx()
  if (ac && ac.state === 'suspended') void ac.resume()
}

function ensureCtx(): AudioContext | null {
  try {
    const AC =
      globalThis.AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    if (!ctx) ctx = new AC()
    return ctx
  } catch {
    return null
  }
}

function tone(freq: number, at: number, dur: number, gain = 0.07): void {
  const ac = ensureCtx()
  if (!ac) return
  // 挂起中：先请求恢复再排音——时钟冻结在 currentTime，恢复后这段音仍会补播；
  // 若浏览器仍不放行（无手势），就是静默降级，不影响烧录。
  if (ac.state === 'suspended') void ac.resume()
  try {
    const osc = ac.createOscillator()
    const g = ac.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    const t0 = ac.currentTime + at
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    osc.connect(g).connect(ac.destination)
    osc.start(t0)
    osc.stop(t0 + dur + 0.05)
  } catch {
    /* 单音失败不影响其它音 */
  }
}

/** 烧录完成：上行三音（C5→E5→G5） */
export function playFlashOk(): void {
  if (!enabled) return
  try {
    tone(523.25, 0, 0.14)
    tone(659.25, 0.12, 0.14)
    tone(783.99, 0.24, 0.22)
  } catch {
    /* 静音降级 */
  }
}

/** 烧录失败：双低音下行（G4→E4） */
export function playFlashErr(): void {
  if (!enabled) return
  try {
    tone(392.0, 0, 0.18, 0.08)
    tone(329.63, 0.18, 0.32, 0.08)
  } catch {
    /* 静音降级 */
  }
}
