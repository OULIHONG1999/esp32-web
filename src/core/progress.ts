/**
 * 烧录进度换算（纯逻辑，可单测）。
 *
 * 背景（2026-10-06 用户报「烧录卡住到一半」）：esptool-js 的 `reportProgress(fileIndex, written, bytesTotal)`
 * 两个数字都是**压缩后**（compress:true → deflate）的字节数，而整体进度的分母是**真实字节**
 * （各段 `data.byteLength` 之和）。直接相加会让分母未压缩、分子已压缩——2 MB 的 app 段
 * deflate 后约剩一半，于是进度条最长的一段只爬到 ~50%，烧完也停在 50% 不动。
 *
 * 正解：段内比例 `written / bytesTotal` 与压缩无关（两者同单位），
 * 用它乘该段**真实**字节数，再加已完成段的真实字节。
 */

/** 段内压缩进度 → 已写入的真实字节数（整体进度分子） */
export function overallWritten(
  partSizes: readonly number[],
  fileIndex: number,
  partWritten: number,
  partTotal: number,
): number {
  const before = partSizes.slice(0, fileIndex).reduce((n, s) => n + s, 0)
  const realPart = partSizes[fileIndex] ?? 0
  if (!(partTotal > 0)) return before
  const fraction = Math.min(1, Math.max(0, partWritten / partTotal))
  return before + Math.round(fraction * realPart)
}

/** 整体进度分母：各段真实字节之和 */
export function overallTotal(partSizes: readonly number[]): number {
  return partSizes.reduce((n, s) => n + s, 0)
}
