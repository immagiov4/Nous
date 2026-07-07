// Composes the backend chat routers into a single entrypoint.
import { Router } from 'express';

import { contextChatRouter } from './contextChat.js';
import { libraryChatRouter } from './libraryChat.js';

const router = Router();
router.use(contextChatRouter);
router.use(libraryChatRouter);

export default router;
