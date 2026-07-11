import { requireOpenAiApiKey } from '../config/chatConfig.js';

export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

export const getOpenAiJsonHeaders = () => ({
  Authorization: `Bearer ${requireOpenAiApiKey()}`,
  'Content-Type': 'application/json',
});
