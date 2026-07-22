import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { translateUiMessage as t } from '../i18n/uiMessages.ts';
import { Pressable } from '../utils/motion/index.ts';

const NOTIFICATION_AUTO_DISMISS_MS = 5_200;
type NotificationKind = 'error' | 'success';

interface NotificationState {
  kind: NotificationKind;
  message: string;
}

interface ConfirmationRequest {
  confirmLabel: string;
  message: string;
  onResolve: (confirmed: boolean) => void;
  title: string;
}

interface ConfirmationDialogRequest {
  confirmLabel: string;
  message: string;
  title: string;
}

export const useAppDialogs = () => {
  const [confirmationRequest, setConfirmationRequest] = useState<ConfirmationRequest | null>(null);
  const [notification, setNotification] = useState<NotificationState | null>(null);
  const pendingConfirmationResolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  const notify = useCallback((message: string, kind: NotificationKind = 'error') => {
    setNotification({ kind, message });
  }, []);

  const requestConfirmation = useCallback(
    (request: ConfirmationDialogRequest): Promise<boolean> =>
      new Promise(resolve => {
        pendingConfirmationResolveRef.current?.(false);
        pendingConfirmationResolveRef.current = resolve;
        setConfirmationRequest({ ...request, onResolve: resolve });
      }),
    []
  );

  useEffect(() => {
    if (!notification) {
      return;
    }

    const timeoutId = globalThis.setTimeout(() => {
      setNotification(null);
    }, NOTIFICATION_AUTO_DISMISS_MS);

    return () => {
      globalThis.clearTimeout(timeoutId);
    };
  }, [notification]);

  useEffect(
    () => () => {
      pendingConfirmationResolveRef.current?.(false);
      pendingConfirmationResolveRef.current = null;
    },
    []
  );

  const resolveConfirmation = useCallback(
    (confirmed: boolean) => {
      const resolve = confirmationRequest?.onResolve || null;
      resolve?.(confirmed);
      if (pendingConfirmationResolveRef.current === resolve) {
        pendingConfirmationResolveRef.current = null;
      }
      setConfirmationRequest(null);
    },
    [confirmationRequest]
  );

  const confirmationDialog =
    confirmationRequest && typeof document !== 'undefined'
      ? createPortal(
          <div className="fixed inset-0 z-[140] flex items-center justify-center px-4 py-6">
            <button
              type="button"
              aria-label={t('Chiudi conferma')}
              className="absolute inset-0 bg-black/50 backdrop-blur-sm"
              onClick={() => resolveConfirmation(false)}
            />
            <div
              className="relative w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
              role="dialog"
              aria-modal="true"
            >
              <h2 className="text-lg font-semibold text-gray-900 dark:text-zinc-100">
                {confirmationRequest.title}
              </h2>
              <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-zinc-300">
                {confirmationRequest.message}
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <Pressable
                  onClick={() => resolveConfirmation(false)}
                  className="rounded-full px-4 py-2 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                >
                  {t('Annulla')}
                </Pressable>
                <Pressable
                  onClick={() => resolveConfirmation(true)}
                  className="rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700"
                >
                  {confirmationRequest.confirmLabel}
                </Pressable>
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  const notificationPalette =
    notification?.kind === 'success'
      ? {
          closeButton:
            '-mr-1 rounded-full px-2 text-emerald-700 transition-colors hover:bg-emerald-100 dark:text-emerald-200 dark:hover:bg-emerald-900/60',
          container:
            'fixed bottom-5 left-1/2 z-[120] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 shadow-2xl dark:border-emerald-900/70 dark:bg-emerald-950 dark:text-emerald-200',
        }
      : {
          closeButton:
            '-mr-1 rounded-full px-2 text-red-700 transition-colors hover:bg-red-100 dark:text-red-200 dark:hover:bg-red-900/60',
          container:
            'fixed bottom-5 left-1/2 z-[120] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 shadow-2xl dark:border-red-900/70 dark:bg-red-950 dark:text-red-200',
        };

  const appOverlays = (
    <>
      {notification ? (
        <div className={notificationPalette.container}>
          <div className="flex items-start justify-between gap-3">
            <span>{notification.message}</span>
            <Pressable
              onClick={() => setNotification(null)}
              className={notificationPalette.closeButton}
              title={t('Chiudi')}
            >
              {t('Chiudi')}
            </Pressable>
          </div>
        </div>
      ) : null}
      {confirmationDialog}
    </>
  );

  return {
    appOverlays,
    notify,
    requestConfirmation,
  };
};
