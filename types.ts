

export interface UserProfile {
  topic: string;
  experienceLevel: string;
  learningStyle: string;
  goals: string;
  context: string;
  language: string;
}

export interface SyllabusItem {
  id: string;
  title: string;
  description: string;
  type: 'module' | 'lesson';
  status: 'pending' | 'ready';
  contextPrompt?: string;
  children?: SyllabusItem[];
}

export interface FileData {
  name: string;
  mimeType: string;
  data: string; // Base64
}

export enum AppState {
  UPLOAD = 'UPLOAD',
  ASSESSMENT = 'ASSESSMENT',
  PLANNING = 'PLANNING',
  READING = 'READING',
}

export interface Message {
  role: 'user' | 'model';
  text: string;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
}

export interface LearningSection {
  id: string;
  title: string;
  description: string;
  isCompleted: boolean;
  type: 'prerequisite' | 'core' | 'summary' | 'deep-dive';
  parentId?: string; // ID of the parent section if this is a sub-chapter
  content?: string; // The generated full lesson content (persisted)
  quiz?: QuizQuestion[]; // The generated quiz (persisted)
  contextPrompt?: string; // For Learn Mode
}

export interface LearningPlan {
  title: string;
  summary: string;
  sections: LearningSection[];
  backgroundMusicUrl?: string; // Optional field for YouTube background music
}

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  selectedText: string;
}

// Updated VoiceName to support both legacy Gemini voices and new TTS voices
export type VoiceName = 'Kore' | 'Fenrir' | 'Puck' | 'Zephyr' | 'Charon' | 'Marco' | 'Giulia';

// TTS Status interface
export interface TTSStatus {
  isRunning: boolean;
  isReady: boolean;
  modelLoaded: boolean;
  currentDevice: string;
  uptime: number;
  lastError?: string;
}

export interface AudioChunk {
  text: string;
  index: number;
  blobUrl: string | null;
  duration: number; // in seconds, known only after metadata loads
  isLoading: boolean;
}

export interface AudioState {
  isPlaying: boolean;
  currentVoice: VoiceName;
  playbackRate: number;
  chunks: AudioChunk[];
  currentChunkIndex: number;
  audioElement: HTMLAudioElement | null;
}

export interface CalibrationPoint {
  timeOffset: number; // The difference between Visual % and Audio %
}
