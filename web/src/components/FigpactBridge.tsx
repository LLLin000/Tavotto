import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFigpactStore } from '@/store/figpactStore'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { TextInput } from './ui/Input'
import { Notice } from './ui/Notice'

/**
 * Explicit Figpact live controls (G2-B/C).
 *
 * - One dialog takes the connect string; the password field clears on close
 *   and after connecting. The token never reaches state, storage, log, or DOM
 *   attributes.
 * - Capture / Show frame / Disconnect are explicit buttons. No autosave,
 *   no page mutation.
 */
export function FigpactBridge() {
  const { t } = useTranslation('workspace')
  const status = useFigpactStore((s) => s.status)
  const error = useFigpactStore((s) => s.error)
  const layout = useFigpactStore((s) => s.layout)
  const binding = useFigpactStore((s) => s.binding)
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const store = useFigpactStore.getState()

  const busyOp = status === 'connecting' || status === 'capturing' || status === 'framing'
  const connected = status !== 'offline'

  const close = () => {
    setOpen(false)
    // Memory-only token: never leave the secret in a form field.
    setValue('')
  }

  const submit = async () => {
    setBusy(true)
    try {
      await store.connect(value)
    } finally {
      setBusy(false)
      // Clear the password field after connecting, success or not.
      setValue('')
      if (useFigpactStore.getState().status === 'ready') setOpen(false)
    }
  }

  const statusKey =
    status === 'ready'
      ? 'figpact.statusReady'
      : status === 'stale'
        ? 'figpact.statusStale'
        : status === 'capturing'
          ? 'figpact.statusCapturing'
          : status === 'framing'
            ? 'figpact.statusFraming'
            : status === 'error'
              ? 'figpact.statusError'
              : status === 'connecting'
                ? 'figpact.statusConnecting'
                : 'figpact.statusOffline'

  return (
    <div data-figpact-bridge className="flex items-center gap-1">
      <span data-figpact-status={status} className="text-xs text-ink-3" aria-live="polite">
        {t(statusKey)}
      </span>
      {!connected ? (
        <Button size="md" data-toolbar-item data-figpact-connect onClick={() => setOpen(true)}>
          {t('figpact.connect')}
        </Button>
      ) : (
        <>
          <Button
            size="md"
            data-toolbar-item
            data-figpact-capture
            disabled={busyOp || busy}
            onClick={() => void store.capture()}
          >
            {t('figpact.capture')}
          </Button>
          <Button
            size="md"
            data-toolbar-item
            data-figpact-show-frame
            disabled={busyOp || busy || !layout}
            title={!layout ? t('figpact.statusStale') : undefined}
            onClick={() => void store.requestFrame()}
          >
            {t('figpact.showFrame')}
          </Button>
          <Button
            size="md"
            variant="danger"
            data-toolbar-item
            data-figpact-disconnect
            onClick={() => store.disconnect()}
          >
            {t('figpact.disconnect')}
          </Button>
        </>
      )}
      <Dialog
        open={open}
        onOpenChange={(v) => (v ? setOpen(true) : close())}
        anchor="figpact-connect"
        size="md"
        title={t('figpact.dialogTitle')}
        description={t('figpact.dialogHint')}
        initialFocusRef={inputRef}
        footer={{
          secondary: (
            <Button variant="secondary" size="lg" data-figpact-cancel onClick={close}>
              {t('figpact.dialogCancel')}
            </Button>
          ),
          primary: (
            <Button
              variant="primary"
              size="lg"
              loading={busy}
              data-figpact-submit
              disabled={!value}
              onClick={() => void submit()}
            >
              {t('figpact.dialogConnect')}
            </Button>
          ),
        }}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (value && !busy) void submit()
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="type-section">{t('figpact.dialogLabel')}</span>
            <TextInput
              ref={inputRef}
              type="password"
              autoComplete="off"
              value={value}
              disabled={busy}
              data-figpact-connection=""
              placeholder={t('figpact.dialogPlaceholder')}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          {binding && !error && (
            <p className="text-sm text-ink-3">
              {t('figpact.frameShown', { revision: binding.frame_revision.slice(0, 12) })}
            </p>
          )}
          {error && <Notice tone="danger">{`${t('figpact.errorPrefix')}${error}`}</Notice>}
        </form>
      </Dialog>
    </div>
  )
}
