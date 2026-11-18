import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchSettings,
  groupScreenEgressKbps,
  groupVideoEgressKbps,
  updateSettings,
} from '@vibechat/core'
import type { SettingRange, SettingsView, UpdateSettingsRequest } from '@vibechat/protocol'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { limitsQuery } from '../../chat'
import { Button } from '../../components/Button'
import { ListSkeleton } from '../../components/ListSkeleton'
import { LoadError } from '../../components/LoadError'
import { SegmentedControl } from '../../components/SegmentedControl'
import { TextField } from '../../components/TextField'
import { useErrorMessage } from '../../errors'
import { toast } from '../../toast'
import { AdminBody, AdminHeader } from './common'

const QUERY_KEY = ['admin', 'settings']
const MB = 1024 * 1024
/** 编辑时限在服务端按秒存，界面上按小时填。 */
const HOUR = 60 * 60
/** 码率在服务端按千比特每秒存，界面上按 Mbps 填。 */
const KBPS_PER_MBPS = 1000

type Retention = 'forever' | 'limited'

/** 表单里填的内容。都是文字：输入框里可以暂时是空的。 */
interface Draft {
  fileMb: string
  groupMax: string
  groupCallMax: string
  voiceMax: string
  recallWindow: string
  editWindow: string
  retention: Retention
  retentionDays: string
  screenMaxWidth: string
  screenMaxFps: string
  screenDirectMbps: string
  screenRelayMbps: string
  cameraRelayMbps: string
  groupCameraHigh: string
  groupCameraLow: string
  groupScreen: string
}

const mbps = (kbps: number) => String(kbps / KBPS_PER_MBPS)
const kbps = (mbps: string) => Math.round(Number(mbps) * KBPS_PER_MBPS)

function draftOf(settings: SettingsView): Draft {
  return {
    fileMb: String(Math.round(settings.file_max_bytes / MB)),
    groupMax: String(settings.group_max_members),
    groupCallMax: String(settings.group_call_max),
    voiceMax: String(settings.voice_max_seconds),
    recallWindow: String(settings.recall_window_seconds),
    editWindow: String(Math.round(settings.edit_window_seconds / HOUR)),
    retention: settings.retention_days === null ? 'forever' : 'limited',
    retentionDays: settings.retention_days === null ? '' : String(settings.retention_days),
    screenMaxWidth: String(settings.screen_max_width),
    screenMaxFps: String(settings.screen_max_fps),
    screenDirectMbps: mbps(settings.screen_direct_kbps),
    screenRelayMbps: mbps(settings.screen_relay_kbps),
    cameraRelayMbps: mbps(settings.camera_relay_kbps),
    groupCameraHigh: String(settings.group_camera_high_kbps),
    groupCameraLow: String(settings.group_camera_low_kbps),
    groupScreen: String(settings.group_screen_kbps),
  }
}

/** 和现在生效的相比，改了哪几项。 */
function changesOf(draft: Draft, settings: SettingsView): UpdateSettingsRequest {
  const changes: UpdateSettingsRequest = {}
  const fileBytes = Number(draft.fileMb) * MB
  if (fileBytes !== settings.file_max_bytes) changes.file_max_bytes = fileBytes
  const groupMax = Number(draft.groupMax)
  if (groupMax !== settings.group_max_members) changes.group_max_members = groupMax
  const groupCallMax = Number(draft.groupCallMax)
  if (groupCallMax !== settings.group_call_max) changes.group_call_max = groupCallMax
  const voiceMax = Number(draft.voiceMax)
  if (voiceMax !== settings.voice_max_seconds) changes.voice_max_seconds = voiceMax
  const recallWindow = Number(draft.recallWindow)
  if (recallWindow !== settings.recall_window_seconds) changes.recall_window_seconds = recallWindow
  const editWindow = Number(draft.editWindow) * HOUR
  if (editWindow !== settings.edit_window_seconds) changes.edit_window_seconds = editWindow
  // 0 表示永久保留
  const retention = draft.retention === 'forever' ? 0 : Number(draft.retentionDays)
  if (retention !== (settings.retention_days ?? 0)) changes.retention_days = retention
  const width = Number(draft.screenMaxWidth)
  if (width !== settings.screen_max_width) changes.screen_max_width = width
  const fps = Number(draft.screenMaxFps)
  if (fps !== settings.screen_max_fps) changes.screen_max_fps = fps
  const direct = kbps(draft.screenDirectMbps)
  if (direct !== settings.screen_direct_kbps) changes.screen_direct_kbps = direct
  const relay = kbps(draft.screenRelayMbps)
  if (relay !== settings.screen_relay_kbps) changes.screen_relay_kbps = relay
  const camera = kbps(draft.cameraRelayMbps)
  if (camera !== settings.camera_relay_kbps) changes.camera_relay_kbps = camera
  const high = Number(draft.groupCameraHigh)
  if (high !== settings.group_camera_high_kbps) changes.group_camera_high_kbps = high
  const low = Number(draft.groupCameraLow)
  if (low !== settings.group_camera_low_kbps) changes.group_camera_low_kbps = low
  const screen = Number(draft.groupScreen)
  if (screen !== settings.group_screen_kbps) changes.group_screen_kbps = screen
  return changes
}

function SettingsForm({ settings }: { settings: SettingsView }) {
  const { t } = useTranslation('admin')
  const errorMessage = useErrorMessage()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(() => draftOf(settings))
  const changes = changesOf(draft, settings)
  const changed = Object.keys(changes).length > 0

  const save = useMutation({
    mutationFn: () => updateSettings(changes),
    onSuccess: async (updated) => {
      queryClient.setQueryData(QUERY_KEY, updated)
      setDraft(draftOf(updated))
      toast.success(t('settings.saved'))
      // 管理员自己的页面也按新的上限来
      await queryClient.invalidateQueries({ queryKey: limitsQuery.queryKey })
    },
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    save.mutate()
  }

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  /** 一项的说明：默认值和允许的范围。`scale` 是界面上的单位相当于多少。 */
  function hint(range: SettingRange, scale = 1): string {
    const values = { min: range.min / scale, max: range.max / scale }
    return range.default === null
      ? t('settings.rangeNoDefault', values)
      : t('settings.range', { ...values, default: range.default / scale })
  }

  function number(
    key: keyof Draft,
    label: string,
    range: SettingRange,
    scale = 1,
    extra = '',
    step = 1,
  ) {
    return (
      <TextField
        label={label}
        hint={`${extra}${hint(range, scale)}`}
        type="number"
        inputMode={step < 1 ? 'decimal' : 'numeric'}
        min={range.min / scale}
        max={range.max / scale}
        step={step}
        value={draft[key]}
        onChange={(event) => set(key, event.target.value as Draft[typeof key])}
        required
      />
    )
  }

  return (
    <form onSubmit={onSubmit} data-testid="admin-settings" className="flex flex-col gap-5 py-5">
      {number('fileMb', t('settings.fileMax'), settings.file_max_bytes_range, MB)}
      {number('groupMax', t('settings.groupMax'), settings.group_max_members_range)}
      {number(
        'groupCallMax',
        t('settings.groupCallMax'),
        settings.group_call_max_range,
        1,
        `${t('settings.groupCallHint')} `,
      )}
      {number('voiceMax', t('settings.voiceMax'), settings.voice_max_seconds_range)}
      {number(
        'recallWindow',
        t('settings.recallWindow'),
        settings.recall_window_seconds_range,
        1,
        `${t('settings.recallHint')} `,
      )}
      {number(
        'editWindow',
        t('settings.editWindow'),
        settings.edit_window_seconds_range,
        HOUR,
        `${t('settings.editHint')} `,
      )}
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1.5 text-[12px] text-fg-2">{t('settings.retention')}</legend>
        <div>
          <SegmentedControl
            label={t('settings.retention')}
            value={draft.retention}
            options={[
              { value: 'forever', label: t('settings.retentionForever') },
              { value: 'limited', label: t('settings.retentionLimited') },
            ]}
            onChange={(value) => set('retention', value)}
            fillOnPhone
          />
        </div>
        {draft.retention === 'limited' && (
          <>
            {number('retentionDays', t('settings.retentionDays'), settings.retention_days_range)}
            <p role="note" data-testid="retention-warning" className="text-[12px] text-danger">
              {t('settings.retentionWarning')}
            </p>
          </>
        )}
      </fieldset>
      <fieldset data-testid="call-video-settings" className="flex flex-col gap-5">
        <legend className="mb-1.5 text-[12px] text-fg-2">{t('settings.callVideo')}</legend>
        <p className="text-[12px] text-fg-2">{t('settings.callVideoHint')}</p>
        {number('screenMaxWidth', t('settings.screenMaxWidth'), settings.screen_max_width_range)}
        {number('screenMaxFps', t('settings.screenMaxFps'), settings.screen_max_fps_range)}
        {number(
          'screenDirectMbps',
          t('settings.screenDirectMbps'),
          settings.screen_direct_kbps_range,
          KBPS_PER_MBPS,
          '',
          0.1,
        )}
        {number(
          'screenRelayMbps',
          t('settings.screenRelayMbps'),
          settings.screen_relay_kbps_range,
          KBPS_PER_MBPS,
          `${t('settings.relayHint')} `,
          0.1,
        )}
        {number(
          'cameraRelayMbps',
          t('settings.cameraRelayMbps'),
          settings.camera_relay_kbps_range,
          KBPS_PER_MBPS,
          `${t('settings.relayHint')} `,
          0.1,
        )}
      </fieldset>
      <fieldset data-testid="group-video-settings" className="flex flex-col gap-5">
        <legend className="mb-1.5 text-[12px] text-fg-2">{t('settings.groupVideo')}</legend>
        <p className="text-[12px] text-fg-2">{t('settings.groupVideoHint')}</p>
        {number(
          'groupCameraHigh',
          t('settings.groupCameraHigh'),
          settings.group_camera_high_kbps_range,
        )}
        {number(
          'groupCameraLow',
          t('settings.groupCameraLow'),
          settings.group_camera_low_kbps_range,
        )}
        {/* 按现在填的数算给管理员看：人数上限那么多人都开摄像头时，服务器最多往外发多少 */}
        <p role="note" data-testid="group-video-estimate" className="text-[12px] text-fg-2">
          {t('settings.groupVideoEstimate', {
            count: Number(draft.groupCallMax) || 0,
            mbps: (
              groupVideoEgressKbps(
                Number(draft.groupCallMax) || 0,
                Number(draft.groupCameraHigh) || 0,
                Number(draft.groupCameraLow) || 0,
              ) / KBPS_PER_MBPS
            ).toFixed(1),
          })}
        </p>
        {number('groupScreen', t('settings.groupScreen'), settings.group_screen_kbps_range)}
        {/* 有人共享屏幕时又是多少：视频通话里别人都开着摄像头，和语音通话里只有屏幕 */}
        <p role="note" data-testid="group-screen-estimate" className="text-[12px] text-fg-2">
          {t('settings.groupScreenEstimate', {
            count: Number(draft.groupCallMax) || 0,
            video: (
              groupScreenEgressKbps(
                Number(draft.groupCallMax) || 0,
                Number(draft.groupScreen) || 0,
                Number(draft.groupCameraLow) || 0,
                true,
              ) / KBPS_PER_MBPS
            ).toFixed(1),
            voice: (
              groupScreenEgressKbps(
                Number(draft.groupCallMax) || 0,
                Number(draft.groupScreen) || 0,
                Number(draft.groupCameraLow) || 0,
                false,
              ) / KBPS_PER_MBPS
            ).toFixed(1),
          })}
        </p>
      </fieldset>
      {save.isError && (
        <p role="alert" className="text-danger">
          {errorMessage(save.error)}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={!changed || save.isPending}>
          {t('settings.save')}
        </Button>
      </div>
    </form>
  )
}

/** 系统设置：各项上限和保留期限。每一项旁边写着默认值和允许的范围；改完立即生效。 */
export function SystemSettingsPage() {
  const { t } = useTranslation('admin')
  const errorMessage = useErrorMessage()
  const settings = useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) => fetchSettings({ signal }),
  })
  return (
    <>
      <AdminHeader title={t('settings.title')} />
      <AdminBody>
        {settings.isError ? (
          <LoadError
            message={errorMessage(settings.error)}
            onRetry={() => void settings.refetch()}
          />
        ) : !settings.data ? (
          <ListSkeleton rows={3} />
        ) : (
          <SettingsForm settings={settings.data} />
        )}
      </AdminBody>
    </>
  )
}
