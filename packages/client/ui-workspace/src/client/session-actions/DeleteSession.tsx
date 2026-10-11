/**
 * The delete action: a destructive `sidebar.workspaces.session.menu.item` row that asks for
 * confirmation, and the `shell.overlay` dialog that confirms it. Deleting is permanent, so the
 * row never deletes on its own click; the Host call and the notice a deletion raises live in the
 * injected callbacks.
 */
import { useState } from 'react'
import { Button, IconTrashOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DeleteSessionInjected, SessionDeleteConfirmInjected, SessionDeleteConfirmProps, SessionDeleteTarget, SessionMenuItemProps,
} from '../contract/slots.ts'
import browserCss from '../rows/WorkspaceBrowser.module.css'

/**
 * Menu row (order 900, after rows of a lower order): ask to delete the Session.
 * @param props - owner share, the delete share, and the menu open state.
 * @returns the row.
 */
export function DeleteSessionMenuItem({
  sessionId, displayTitle, useMenuOpenState, requestSessionDelete, t,
}: SessionMenuItemProps<DeleteSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      danger
      separatorBefore
      icon={<IconTrashOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        // The row passes the stored title, which is empty until the Session is named.
        requestSessionDelete(sessionId, displayTitle === '' ? t('session.untitled') : displayTitle)
      }}
    >
      {t('menu.deleteSession')}
    </MenuItemButton>
  )
}

/**
 * The `shell.overlay` entry: nothing while no deletion is pending, otherwise one dialog per
 * request (keyed by the Session). Confirming deletes; cancelling leaves the Session as it is.
 * @param props - the request hook, its settlement, the delete hop, and the locale seat.
 * @returns the open dialog, or null.
 */
export function SessionDeleteConfirmDialog({ useDeleteRequest, settleSessionDelete, deleteSession, t }: SessionDeleteConfirmProps) {
  const request = useDeleteRequest(pending => pending)
  if (request === null) return null
  return <DeleteConfirmForm key={request.sessionId} request={request} deleteSession={deleteSession} onSettle={settleSessionDelete} t={t} />
}

/** One request's dialog: in-flight and error state die with it. */
function DeleteConfirmForm({ request, deleteSession, onSettle, t }: {
  request: SessionDeleteTarget
  deleteSession: SessionDeleteConfirmInjected['deleteSession']
  onSettle: () => void
  t: SessionDeleteConfirmProps['t']
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    if (deleting) return
    onSettle()
  }
  const confirm = () => {
    setDeleting(true)
    setError(null)
    deleteSession(request.sessionId).then(() => {
      setDeleting(false)
      onSettle()
    }).catch((reason: unknown) => {
      setDeleting(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('delete.session.title')}
      description={t('delete.session.desc', { title: request.displayTitle })}
      footer={(
        <>
          <Button variant="outline" disabled={deleting} onClick={close}>{t('cancel')}</Button>
          <Button variant="outline" className={browserCss.deleteAction} disabled={deleting} onClick={confirm}>{t('menu.deleteSession')}</Button>
        </>
      )}
    >
      {deleting && <div className={browserCss.deleteStatus} role="status">{t('delete.session.pending')}</div>}
      {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
