import type {
  FileData,
  LearningPlan,
  LearningSection,
  Message,
  QuizQuestion,
  SyllabusItem,
  UserProfile,
  VoiceName,
} from '../../types';

export interface JsonSchemaFormat {
  type: 'json_object' | 'json_schema';
  json_schema?: Record<string, unknown>;
}

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

export type ChatMessageContent = string | Array<TextContentPart | ImageContentPart>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatMessageContent;
}

export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: JsonSchemaFormat;
  tools?: Record<string, unknown>[];
}

export interface OpenRouterChoice {
  message?: {
    content?: OpenRouterMessageContent;
  };
}

export interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
}

export type OpenRouterMessageContent = ChatMessageContent;

export interface FunctionCall<TArgs = Record<string, unknown>> {
  name: string;
  args: TArgs;
}

export interface ChatSession<TArgs = Record<string, unknown>> {
  sendMessage: (params: { message: string }) => Promise<{
    text: string;
    functionCalls?: Array<FunctionCall<TArgs>>;
  }>;
  getHistory?: () => ChatMessage[];
}

export interface LearnLessonContext {
  pastContext: string;
  futureContext: string;
  currentLessonDescription: string;
}

export interface ModuleBlueprint {
  title: string;
  description: string;
  lessons: LessonBlueprint[];
}

export interface LessonBlueprint {
  title: string;
  description: string;
  contextPrompt?: string;
}

export interface TtsStatusResponse {
  status?: {
    isRunning?: boolean;
    isReady?: boolean;
    lastError?: string;
  };
}

export interface TtsVoiceDescriptor {
  id: string;
  name: string;
  language: string;
}

export type {
  FileData,
  LearningPlan,
  LearningSection,
  Message,
  QuizQuestion,
  SyllabusItem,
  UserProfile,
  VoiceName,
};
