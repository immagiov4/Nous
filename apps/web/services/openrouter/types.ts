import type {
  FileData,
  LearningPlan,
  LearningSection,
  LessonGeneratedVisual,
  LessonImageRef,
  LessonLearningAid,
  Message,
  OpenRouterModelSlot,
  PdfDocumentAssets,
  PdfImageAsset,
  PdfTextChunk,
  PdfTextIndex,
  PdfTextPage,
  QuizQuestion,
  SyllabusItem,
  TtsModelSummary,
  UserProfile,
  VoiceName,
  VoiceProfileId,
} from '../../types.ts';

export interface JsonSchemaFormat {
  type: 'json_schema';
  json_schema?: Record<string, unknown>;
}

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface FileContentPart {
  type: 'file';
  file: {
    filename: string;
    file_data: string;
  };
}

export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

export type ChatMessageContent =
  | string
  | Array<TextContentPart | ImageContentPart | FileContentPart>;

export interface FileAnnotationTextPart {
  type: 'text';
  text: string;
}

export interface FileAnnotationImagePart {
  type: 'image_url';
  image_url: { url: string };
}

export type FileAnnotationContentPart = FileAnnotationTextPart | FileAnnotationImagePart;

export interface FileAnnotation {
  type: 'file';
  file: {
    name?: string;
    hash?: string;
    content?: FileAnnotationContentPart[];
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatMessageContent;
  annotations?: FileAnnotation[];
}

export type OpenRouterReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface OpenRouterReasoningOptions {
  enabled?: boolean;
  effort?: OpenRouterReasoningEffort;
  max_tokens?: number;
  exclude?: boolean;
}

export interface ChatCompletionOptions {
  model: string;
  modelSlot?: OpenRouterModelSlot;
  allowTextOnlyImageFallback?: boolean;
  disableModelOverride?: boolean;
  messages: ChatMessage[];
  onReasoningUpdate?: (reasoningText: string) => void;
  reasoning?: OpenRouterReasoningOptions;
  temperature?: number;
  max_tokens?: number;
  response_format?: JsonSchemaFormat;
  tools?: Record<string, unknown>[];
  plugins?: Record<string, unknown>[];
  signal?: AbortSignal;
}

export interface OpenRouterToolCall {
  id?: string;
  type?: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenRouterChoice {
  message?: {
    content?: OpenRouterMessageContent;
    annotations?: FileAnnotation[];
    tool_calls?: OpenRouterToolCall[];
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

export interface TtsModelsResponse {
  defaultModel: string;
  models: TtsModelSummary[];
  success: boolean;
}

export type {
  FileData,
  LearningPlan,
  LearningSection,
  LessonGeneratedVisual,
  LessonImageRef,
  LessonLearningAid,
  Message,
  PdfDocumentAssets,
  PdfTextIndex,
  PdfTextChunk,
  PdfImageAsset,
  PdfTextPage,
  QuizQuestion,
  SyllabusItem,
  TtsModelSummary,
  UserProfile,
  VoiceProfileId,
  VoiceName,
};
