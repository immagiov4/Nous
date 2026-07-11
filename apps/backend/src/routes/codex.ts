import { type Request, type Response, Router } from 'express';
import { assertCodexRequestAccess, CODEX_ACCESS_DENIED_MESSAGE } from '../services/codexAccess.js';
import {
  cancelCodexLogin,
  closeManagedCodexAccountClient,
  getManagedCodexAccountClient,
  isCodexAppServerEnabled,
  listCodexModels,
  logoutCodexAccount,
  readCodexAccount,
  startCodexDeviceLogin,
} from '../services/codexAppServer.js';
import { isRecord, readOptionalString } from '../utils/validation.js';

const CODEX_UNAVAILABLE_MESSAGE = 'Codex non è disponibile su questo server.';
const CODEX_OPERATION_FAILED_MESSAGE = 'Codex non ha completato l’operazione. Riprova.';

const sendCodexError = (res: Response, error: unknown): void => {
  console.error('[Codex app-server] Request failed.', {
    errorType: error instanceof Error ? error.name : 'unknown',
  });
  res.status(503).json({ success: false, error: CODEX_OPERATION_FAILED_MESSAGE });
};

const requireCodexRequestAccess = (req: Request, res: Response): boolean => {
  try {
    assertCodexRequestAccess(req);
    return true;
  } catch {
    res.status(403).json({ success: false, error: CODEX_ACCESS_DENIED_MESSAGE });
    return false;
  }
};

const router = Router();

router.get('/status', async (req: Request, res: Response) => {
  if (!isCodexAppServerEnabled()) {
    res.json({ success: true, enabled: false, account: null, models: [] });
    return;
  }
  if (!requireCodexRequestAccess(req, res)) {
    return;
  }

  try {
    const client = await getManagedCodexAccountClient();
    const [account, models] = await Promise.all([
      readCodexAccount(client),
      listCodexModels(client),
    ]);
    res.json({ success: true, enabled: true, account, models });
  } catch (error) {
    await closeManagedCodexAccountClient();
    sendCodexError(res, error);
  }
});

router.post('/login', async (req: Request, res: Response) => {
  if (!isCodexAppServerEnabled()) {
    res.status(409).json({ success: false, error: CODEX_UNAVAILABLE_MESSAGE });
    return;
  }
  if (!requireCodexRequestAccess(req, res)) {
    return;
  }

  try {
    const login = await startCodexDeviceLogin();
    if (!isRecord(login)) {
      throw new Error('Codex login response is invalid.');
    }
    res.json({
      success: true,
      login: {
        type: readOptionalString(login.type),
        loginId: readOptionalString(login.loginId),
        userCode: readOptionalString(login.userCode),
        verificationUrl: readOptionalString(login.verificationUrl),
      },
    });
  } catch (error) {
    await closeManagedCodexAccountClient();
    sendCodexError(res, error);
  }
});

router.post('/login/cancel', async (req: Request, res: Response) => {
  if (!requireCodexRequestAccess(req, res)) {
    return;
  }
  const loginId = isRecord(req.body) ? readOptionalString(req.body.loginId) : undefined;
  if (!loginId) {
    res.status(400).json({ success: false, error: 'Identificativo di accesso non valido.' });
    return;
  }

  try {
    await cancelCodexLogin(loginId);
    res.json({ success: true });
  } catch (error) {
    await closeManagedCodexAccountClient();
    sendCodexError(res, error);
  }
});

router.post('/logout', async (req: Request, res: Response) => {
  if (!requireCodexRequestAccess(req, res)) {
    return;
  }
  try {
    await logoutCodexAccount();
    res.json({ success: true });
  } catch (error) {
    await closeManagedCodexAccountClient();
    sendCodexError(res, error);
  }
});

export default router;
