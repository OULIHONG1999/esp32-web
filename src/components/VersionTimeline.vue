<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  UnauthorizedError,
  collectReleases,
  getStoredToken,
  previewRetention,
  promoteRelease,
  setLatestRelease,
  setProjectRetention,
  setStoredToken,
  type Registry,
  type RegistryOption,
  type RegistryRelease,
} from '../api/registry'

const props = defineProps<{
  option: RegistryOption | null
  registry: Registry | null
  chipName: string | null
}>()

const emit = defineEmits<{
  /** 请求父层载入该版本（走统一下载填充逻辑） */
  load: [release: RegistryRelease]
  /** 晋升/回滚/retention 之后，父层刷新 registry 列表 */
  changed: []
  /** 401 后需要 token —— 由父层统一提示（保留事件位） */
  needToken: []
}>()

const releases = computed<RegistryRelease[]>(() => {
  if (!props.registry || !props.option) return []
  return collectReleases(props.registry, props.option.projectId, props.option.variant)
})

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 401 → 引导输入 token 存本地后重试一次（FIRMWARE-REGISTRY §8） */
async function withAuth(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      const hint = getStoredToken() ? 'token 被服务器拒绝，请重新输入：' : '首次操作需输入发布 token：'
      const t = window.prompt(hint + '\n（服务器环境变量 FIRMWARE_PUBLISH_TOKEN）')
      if (!t || !t.trim()) return
      setStoredToken(t.trim())
      await fn()
      return
    }
    throw e
  }
}

async function doPromote(rel: RegistryRelease): Promise<void> {
  if (!props.option) return
  const note = window.prompt(`将 ${rel.id} 晋升为发布版，填写说明（必填）：`, '')
  if (note === null) return
  try {
    await withAuth(() =>
      promoteRelease(props.option!.projectId, props.option!.variant, rel.id, note),
    )
    if (note.trim()) emit('changed')
  } catch (e) {
    window.alert(`晋升失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

async function doRollback(rel: RegistryRelease): Promise<void> {
  if (!props.option) return
  const ok = window.confirm(`回滚：把 latest 指向 ${rel.id}？（页面「载入最新」将拿到它；文件不移动）`)
  if (!ok) return
  try {
    await withAuth(() => setLatestRelease(props.option!.projectId, props.option!.variant, rel.id))
    emit('changed')
  } catch (e) {
    window.alert(`回滚失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

const retentionInput = ref<string>('')

async function doRetention(): Promise<void> {
  if (!props.option) return
  const raw = retentionInput.value.trim()
  const val = raw === 'all' ? 'all' : Number(raw)
  if (val !== 'all' && (!Number.isInteger(val) || val < 0)) {
    window.alert('保留数：非负整数或 all')
    return
  }
  try {
    // 确认语义：先预览将删清单，再写策略（FIRMWARE-REGISTRY §4.3）
    const prev = await previewRetention(
      props.option.projectId,
      val === 'all' ? undefined : val,
    )
    const list =
      prev.doomed.length === 0
        ? '当前没有将被删除的快照。'
        : `下次发布将删除 ${prev.doomed.length} 个旧快照：\n` +
          prev.doomed.slice(0, 10).map((d) => `· ${d.release}`).join('\n') +
          (prev.doomed.length > 10 ? `\n…共 ${prev.doomed.length} 个` : '')
    const ok = window.confirm(`设置 snapshots 保留数 = ${val}？\n（只影响未来发布，确认后写入策略）\n\n${list}`)
    if (!ok) return
    await withAuth(() => setProjectRetention(props.option!.projectId, val))
    emit('changed')
  } catch (e) {
    window.alert(`retention 设置失败：${e instanceof Error ? e.message : String(e)}`)
  }
}
</script>

<template>
  <div v-if="option && releases.length" class="tl">
    <div class="tl__head">
      <span class="tl__title">版本时间线 · {{ option.projectName }} / {{ option.variant }}</span>
      <span class="tl__ret">
        保留快照
        <input
          v-model="retentionInput"
          class="tl__ret-input"
          placeholder="30 / all"
        />
        <button class="tl__btn" type="button" @click="doRetention">
          设置
        </button>
      </span>
    </div>
    <ul class="tl__list">
      <li v-for="rel in releases" :key="rel.id" class="tl__item">
        <span
          class="tl__badge"
          :class="rel.type === 'release' ? 'tl__badge--release' : 'tl__badge--snap'"
          :title="rel.type === 'release' ? '发布版（永不自动删）' : '历史快照（受保留策略管理）'"
        >
          {{ rel.type === 'release' ? '★ 发布版' : '快照' }}
        </span>
        <code class="tl__id">{{ rel.id }}</code>
        <span v-if="rel.id === option.release.id" class="tl__latest">latest</span>
        <span class="tl__note">{{ rel.note || '—' }}</span>
        <span class="tl__date">{{ fmtDate(rel.createdAt) }}</span>
        <span class="tl__ops">
          <button
            class="tl__btn tl__btn--primary"
            type="button"
            title="下载该版本全部段并填入烧录表格"
            @click="emit('load', rel)"
          >
            载入
          </button>
          <button
            v-if="rel.type === 'snapshot'"
            class="tl__btn"
            type="button"
            title="晋升为发布版（需填写说明，永不自动删）"
            @click="doPromote(rel)"
          >
            晋升
          </button>
          <button
            v-if="rel.id !== option.release.id"
            class="tl__btn"
            type="button"
            title="把 latest 指向此版本（回滚）"
            @click="doRollback(rel)"
          >
            回滚到此
          </button>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.tl {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
  font-size: 12px;
}
.tl__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.tl__title {
  color: var(--muted);
  font-weight: 600;
}
.tl__ret {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
}
.tl__ret-input {
  width: 64px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--ink);
  padding: 3px 6px;
  font-size: 12px;
}
.tl__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tl__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 4px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.tl__badge {
  flex-shrink: 0;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
}
.tl__badge--release {
  background: color-mix(in srgb, var(--accent) 25%, transparent);
  color: var(--accent);
}
.tl__badge--snap {
  background: var(--panel);
  color: var(--muted);
  border: 1px solid var(--border);
}
.tl__id {
  color: var(--ink);
}
.tl__latest {
  color: var(--accent);
  font-weight: 600;
}
.tl__note {
  flex: 1;
  min-width: 120px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl__date {
  color: var(--muted);
  opacity: 0.7;
}
.tl__ops {
  display: flex;
  gap: 6px;
}
.tl__btn {
  background: transparent;
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
}
.tl__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.tl__btn--primary {
  color: var(--accent);
  border-color: var(--accent);
}
</style>
