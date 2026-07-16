// Completes authenticated account setup without exposing Admin credentials to the browser.
import { type Request, type Response, Router } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';
import {
  requestSupabaseAdmin,
  SUPABASE_ADMIN_USERS_PATH,
  SupabaseAdminRequestError,
} from '../services/supabaseAdmin.js';
import { isRecord, readOptionalString } from '../utils/validation.js';

const PASSWORD_SETUP_FAILED_MESSAGE = 'Salvataggio della password non riuscito. Riprova.';
const WEAK_PASSWORD_MESSAGE = 'La password è troppo debole. Scegline una più lunga e difficile.';

const router = Router();

router.put('/password-setup', async (req: Request, res: Response) => {
  const currentUser = getCurrentUser(req);
  if (!currentUser.passwordSetupRequired) {
    res.status(403).json({ success: false, error: 'Configurazione password non richiesta.' });
    return;
  }

  if (!isRecord(req.body)) {
    res.status(400).json({ success: false, error: 'Corpo della richiesta non valido.' });
    return;
  }

  const password = readOptionalString(req.body.password);
  if (!password) {
    res.status(400).json({ success: false, error: 'Password obbligatoria.' });
    return;
  }

  try {
    await requestSupabaseAdmin({
      method: 'PUT',
      path: `${SUPABASE_ADMIN_USERS_PATH}/${encodeURIComponent(currentUser.id)}`,
      body: {
        password,
        app_metadata: { password_setup_required: null },
      },
    });
    res.json({ success: true });
  } catch (error) {
    if (error instanceof SupabaseAdminRequestError && error.code === 'weak_password') {
      res.status(422).json({
        success: false,
        code: 'weak_password',
        error: WEAK_PASSWORD_MESSAGE,
      });
      return;
    }

    console.error('[Nous][Auth] Failed to complete password setup.', error);
    res.status(502).json({
      success: false,
      code: 'password_setup_unavailable',
      error: PASSWORD_SETUP_FAILED_MESSAGE,
    });
  }
});

export default router;
