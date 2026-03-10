import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Upload, BookOpen, CheckCircle2, ChevronRight, BrainCircuit, GraduationCap, MessageSquare, Download, FileJson, CornerDownRight, Eye, EyeOff, Ruler, ArrowRight, FileText, X, Moon, Sun, ChevronsUp, ChevronsDown, SidebarOpen, SidebarClose, Gauge, Archive, FolderArchive, Wifi, WifiOff, Volume2, Play, Pause } from 'lucide-react';
import JSZip from 'jszip';
import { FileData, AppState, Message, LearningPlan, LearningSection, ContextMenuState, VoiceName, AudioState, AudioChunk, CalibrationPoint, SyllabusItem } from './types';
import * as GeminiService from './services/geminiService';
import { ASSESSMENT_MIN_TURNS } from './constants';
import MarkdownRenderer from './components/MarkdownRenderer';
import ContextMenu from './components/ContextMenu';
import LoadingScreen from './components/LoadingScreen';
import AudioPlayer from './components/AudioPlayer';
import ReadingRuler from './components/ReadingRuler';
import MusicPlayer from './components/MusicPlayer';

// Helper to create a valid WAV file from raw PCM data
const createWavBlob = (pcmData: ArrayBuffer, sampleRate: number = 24000): Blob => {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.byteLength;
  const headerSize = 44;
  
  const header = new ArrayBuffer(headerSize);
  const view = new DataView(header);

  const writeString = (view: DataView, offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // File size - 8
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, numChannels, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, bitsPerSample, true); // BitsPerSample

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true); // Subchunk2Size

  return new Blob([header, pcmData], { type: 'audio/wav' });
};

// Smaller chunks reduce per-request latency and improve playback stability on slower TTS setups.
const CHUNK_SIZE_APPROX = 420; 
const SIDEBAR_WIDTH_PX = 384;

// IGNORED_DIRS: We still filter these to avoid noise and massive performance hits
// from dependencies or build artifacts, even if they contain text.
const IGNORED_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 
  '.idea', '.vscode', '__pycache__', 'bin', 'obj', '.vs', 
  'vendor', 'packages'
];

// Heuristic to detect binary files by checking for null bytes in the first chunk
const isBinaryFile = (uint8Array: Uint8Array): boolean => {
  // Check the first 1024 bytes (or less)
  const checkLength = Math.min(uint8Array.length, 1024);
  
  for (let i = 0; i < checkLength; i++) {
    // 0x00 is the null byte. Its presence almost always indicates a binary file 
    // (images, compiled code, etc.) rather than source code.
    if (uint8Array[i] === 0) {
      return true;
    }
  }
  return false;
};

interface SidebarGroup {
  id: string;
  title: string;
  sections: LearningSection[];
}

const buildSidebarGroups = (
  learningPlan: LearningPlan | null,
  syllabus: SyllabusItem[]
): SidebarGroup[] => {
  if (!learningPlan || learningPlan.sections.length === 0) return [];

  const sectionById = new Map(learningPlan.sections.map(section => [section.id, section]));
  const usedSectionIds = new Set<string>();
  const groups: SidebarGroup[] = [];

  syllabus.forEach((module) => {
    const moduleSections = (module.children || [])
      .map((lesson) => sectionById.get(lesson.id))
      .filter((section): section is LearningSection => Boolean(section));

    if (moduleSections.length === 0) return;

    groups.push({
      id: module.id,
      title: module.title,
      sections: moduleSections
    });

    moduleSections.forEach((section) => usedSectionIds.add(section.id));
  });

  const orphanGroups = new Map<string, LearningSection[]>();
  const orphanOrder: string[] = [];

  learningPlan.sections.forEach((section) => {
    if (usedSectionIds.has(section.id)) return;

    const groupKey = section.parentId || '__ungrouped__';
    if (!orphanGroups.has(groupKey)) {
      orphanGroups.set(groupKey, []);
      orphanOrder.push(groupKey);
    }

    orphanGroups.get(groupKey)!.push(section);
  });

  orphanOrder.forEach((groupKey, index) => {
    const sections = orphanGroups.get(groupKey) || [];
    if (sections.length === 0) return;

    const matchingModule = syllabus.find((module) => module.id === groupKey);
    const isUngrouped = groupKey === '__ungrouped__';

    groups.push({
      id: isUngrouped ? `group-${index}` : groupKey,
      title: matchingModule?.title || (isUngrouped ? 'Percorso' : `Modulo ${groups.length + 1}`),
      sections
    });
  });

  return groups.length > 0
    ? groups
    : [{ id: 'group-0', title: 'Percorso', sections: learningPlan.sections }];
};

const App: React.FC = () => {
  // State
  const [state, setState] = useState<AppState>(AppState.UPLOAD);
  const [file, setFile] = useState<FileData | null>(null);
  const [importedPlan, setImportedPlan] = useState<LearningPlan | null>(null);
  
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState<string>("Caricamento..."); // Detailed status
  const [isContextLoading, setIsContextLoading] = useState(false);
  
  // Assessment State
  const [assessmentMessages, setAssessmentMessages] = useState<Message[]>([]);
  const [currentAssessmentInput, setCurrentAssessmentInput] = useState('');
  const [chatSession, setChatSession] = useState<any>(null);

  // Planning State
  const [learningPlan, setLearningPlan] = useState<LearningPlan | null>(null);

  // Background Music State
  const [musicUrl, setMusicUrl] = useState<string>('');
  const [isMusicPlaying, setIsMusicPlaying] = useState(false);
  const [musicVolume, setMusicVolume] = useState(20); // Default low volume for background

  // Reading State
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [sectionContent, setSectionContent] = useState<string>('');
  const [quiz, setQuiz] = useState<any[]>([]);
  const [quizAnswers, setQuizAnswers] = useState<number[]>([]);
  const [isQuizSubmitted, setIsQuizSubmitted] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, selectedText: '' });
  const [contextAnswer, setContextAnswer] = useState<{q: string, a: string} | null>(null);

  // Focus & Accessibility State
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [isRulerActive, setIsRulerActive] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [teleprompterSpeed, setTeleprompterSpeed] = useState(1); // 1 is now slow, based on user feedback
  const [isLearnMode, setIsLearnMode] = useState(false);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [syllabus, setSyllabus] = useState<SyllabusItem[]>([]);
  const [expandedModuleId, setExpandedModuleId] = useState<string | null>(null);
  
  // UI Visibilty States
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);

  // Audio State
  const [audioState, setAudioState] = useState<AudioState>({
    isPlaying: false,
    currentVoice: 'Marco',
    playbackRate: 1.0,
    chunks: [],
    currentChunkIndex: 0,
    audioElement: null
  });
  
  // New: Current Time tracking for scrubber
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);

  // We track global progress for the ruler (0-1 based on TEXT WEIGHT)
  const [visualProgress, setVisualProgress] = useState(0); 
  const [isAutoTrackEnabled, setIsAutoTrackEnabled] = useState(false); // Can be kept for legacy logic, but Ruler Active now drives it
  const [calibrationOffset, setCalibrationOffset] = useState<number>(0);
  
  // NEW: Audio Sync Link State (Mirino)
  const [isAudioSyncLinked, setIsAudioSyncLinked] = useState(false);
  
  // NEW: TTS Connection Status
  const [ttsConnected, setTtsConnected] = useState(false);
  const ttsCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // TTS Test State
  const [testVoice, setTestVoice] = useState<VoiceName>('Marco');
  const [testText, setTestText] = useState<string>("Ciao! Sono la tua voce AI. Questo è un test del sistema di sintesi vocale.");
  const [isTestPlaying, setIsTestPlaying] = useState(false);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);

  // Refs
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioStateRef = useRef(audioState);
  
  // CRITICAL: Ref to track user intent. 
  const shouldPlayRef = useRef(false);

  // NEW: Promise Cache to handle race conditions between Pre-fetch and OnEnded
  const chunkPromisesRef = useRef<{ [index: number]: Promise<string | null> }>({});
  const playbackSessionRef = useRef(0);
  const playRequestIdRef = useRef(0);
  const generatedObjectUrlsRef = useRef<Set<string>>(new Set());
  const previousActiveSectionIdRef = useRef<string | null>(null);

  const sidebarGroups = buildSidebarGroups(learningPlan, syllabus);
  const audioDockOffset = isFocusMode ? 0 : SIDEBAR_WIDTH_PX;

  // --- Effects ---
  
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  // SYNC LOGIC: If Linked is ON, Ruler visibility follows Audio Play State
  useEffect(() => {
    if (isAudioSyncLinked) {
      setIsRulerActive(audioState.isPlaying);
      setIsAutoTrackEnabled(audioState.isPlaying);
    }
  }, [audioState.isPlaying, isAudioSyncLinked]);

  // TTS Status Check
  useEffect(() => {
    const checkTTS = async () => {
      try {
        const status = await GeminiService.checkTTSStatus();
        setTtsConnected(status.isReady);
      } catch {
        setTtsConnected(false);
      }
    };

    // Check immediately
    checkTTS();

    // Then check every 10 seconds
    ttsCheckIntervalRef.current = setInterval(checkTTS, 10000);

    return () => {
      if (ttsCheckIntervalRef.current) {
        clearInterval(ttsCheckIntervalRef.current);
      }
    };
  }, []);


  useEffect(() => {
    if (state === AppState.ASSESSMENT) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [assessmentMessages, state]);

  useEffect(() => {
    if (sidebarGroups.length === 0) {
      if (expandedModuleId !== null) {
        setExpandedModuleId(null);
      }
      previousActiveSectionIdRef.current = null;
      return;
    }

    const currentGroupStillExists = expandedModuleId
      ? sidebarGroups.some((group) => group.id === expandedModuleId)
      : false;

    if (!currentGroupStillExists) {
      const nextGroup = sidebarGroups.find((group) => group.sections.some((section) => !section.isCompleted)) || sidebarGroups[0];
      setExpandedModuleId(nextGroup.id);
      previousActiveSectionIdRef.current = activeSectionId;
      return;
    }

    if (!activeSectionId || previousActiveSectionIdRef.current === activeSectionId) {
      return;
    }

    previousActiveSectionIdRef.current = activeSectionId;

    const activeGroup = sidebarGroups.find((group) => group.sections.some((section) => section.id === activeSectionId));
    if (activeGroup && activeGroup.id !== expandedModuleId) {
      setExpandedModuleId(activeGroup.id);
    }
  }, [activeSectionId, expandedModuleId, sidebarGroups]);

  // AGGRESSIVE AUDIO CLEANUP
  // When active section changes, we must fully reset audio to prevent ghosting.
  useEffect(() => {
    stopAudio(true); // true = full reset including chunks
  }, [activeSectionId]);

  // Keep Ref updated
  useEffect(() => { audioStateRef.current = audioState; }, [audioState]);

  // Update Music URL in Plan when it changes
  useEffect(() => {
    if (learningPlan && musicUrl !== learningPlan.backgroundMusicUrl) {
        setLearningPlan({
            ...learningPlan,
            backgroundMusicUrl: musicUrl
        });
    }
  }, [musicUrl]);

  // Audio Playback Loop & Progress Calculation
  useEffect(() => {
    let interval: number;
    
    interval = window.setInterval(() => {
         const currentState = audioStateRef.current; // Always get fresh state
         const audio = currentState.audioElement;
         
         if (!audio) return;
         
         // Sync playback rate if changed
         if (audio.playbackRate !== currentState.playbackRate) {
            audio.playbackRate = currentState.playbackRate;
         }

         setPlayerCurrentTime(audio.currentTime);
         setPlayerDuration(audio.duration);

         if (!audio.paused) {
             // Calculate Local Chunk Progress (0-1)
             const localProgress = audio.duration ? audio.currentTime / audio.duration : 0;
             
             // Map to Global Text Progress
             const totalTextLength = currentState.chunks.reduce((acc, c) => acc + c.text.length, 0);
             let processedTextLength = 0;
             for (let i = 0; i < currentState.currentChunkIndex; i++) {
                processedTextLength += currentState.chunks[i].text.length;
             }
             
             const currentChunkLength = currentState.chunks[currentState.currentChunkIndex]?.text.length || 0;
             const estimatedGlobalProgress = (processedTextLength + (currentChunkLength * localProgress)) / (totalTextLength || 1);
             
             setVisualProgress(estimatedGlobalProgress);
         }
    }, 50);

    return () => clearInterval(interval);
  }, []); // Empty dependency array, relying on Refs

  // --- Helper: Chunk Text ---
  const splitContentIntoChunks = (text: string): string[] => {
    // Remove existing mark tags from text sent to Audio
    const cleanText = text.replace(/<\/?mark>/g, '').replace(/<\/?span[^>]*>/g, '');
    
    // Split by paragraphs first
    const paragraphs = cleanText.split(/\n\n+/);
    const chunks: string[] = [];
    let currentChunk = '';

    paragraphs.forEach(p => {
        if (p.length > CHUNK_SIZE_APPROX) {
            const sentences = p.match(/[^.!?]+[.!?]+(\s|$)/g) || [p];
            sentences.forEach(s => {
                if ((currentChunk.length + s.length) > CHUNK_SIZE_APPROX) {
                    chunks.push(currentChunk.trim());
                    currentChunk = s;
                } else {
                    currentChunk += s;
                }
            });
        } else {
            if ((currentChunk.length + p.length) > CHUNK_SIZE_APPROX) {
                chunks.push(currentChunk.trim());
                currentChunk = p;
            } else {
                currentChunk += (currentChunk ? '\n\n' : '') + p;
            }
        }
    });
    if (currentChunk.trim()) chunks.push(currentChunk.trim());
    return chunks;
  };

  // --- Audio Logic ---

  const revokeTrackedUrl = (url: string | null | undefined) => {
    if (!url) return;
    if (generatedObjectUrlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      generatedObjectUrlsRef.current.delete(url);
    }
  };

  const disposeAudioElement = (audio: HTMLAudioElement | null) => {
    if (!audio) return;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.src = '';
    audio.load();
  };

  const releaseCurrentAudioElement = () => {
    const current = audioStateRef.current.audioElement;
    if (current) {
      disposeAudioElement(current);
    }
  };

  useEffect(() => {
    return () => {
      releaseCurrentAudioElement();
      if (testAudioRef.current) {
        testAudioRef.current.pause();
        testAudioRef.current.src = '';
      }
      generatedObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      generatedObjectUrlsRef.current.clear();
      chunkPromisesRef.current = {};
    };
  }, []);

  const generateChunkAudio = async (index: number, retries = 2): Promise<string | null> => {
    // 1. Check if already has URL
    if (audioStateRef.current.chunks[index]?.blobUrl) {
        return audioStateRef.current.chunks[index].blobUrl;
    }

    // 2. Check if already has an ACTIVE PROMISE (Deduplication)
    if (chunkPromisesRef.current[index]) {
        return chunkPromisesRef.current[index];
    }

    // 3. Create new promise
    const promise = (async () => {
        setAudioState(prev => {
            const newChunks = [...prev.chunks];
            // Safety check in case chunks were cleared
            if (newChunks[index]) {
                newChunks[index] = { ...newChunks[index], isLoading: true };
            }
            return { ...prev, chunks: newChunks };
        });

        try {
            const chunk = audioStateRef.current.chunks[index];
            const requestedVoice = audioStateRef.current.currentVoice;
            if (!chunk) throw new Error("Chunk not found");
            const requestedText = chunk.text;

            const pcmBuffer = await GeminiService.generateSpeech(requestedText, requestedVoice);
            const wavBlob = createWavBlob(pcmBuffer);
            const url = URL.createObjectURL(wavBlob);
            generatedObjectUrlsRef.current.add(url);

            // Drop stale generation results (voice/text may have changed while request was running).
            const latestChunk = audioStateRef.current.chunks[index];
            if (!latestChunk || latestChunk.text !== requestedText || audioStateRef.current.currentVoice !== requestedVoice) {
                revokeTrackedUrl(url);
                delete chunkPromisesRef.current[index];
                return null;
            }

            const previousUrl = latestChunk.blobUrl;
            if (previousUrl && previousUrl !== url) {
                revokeTrackedUrl(previousUrl);
            }

            setAudioState(prev => {
                const newChunks = [...prev.chunks];
                if (newChunks[index]) {
                    newChunks[index] = { ...newChunks[index], blobUrl: url, isLoading: false };
                }
                return { ...prev, chunks: newChunks };
            });
            
            // Remove from promise cache once done
            delete chunkPromisesRef.current[index];
            return url;
        } catch (e) {
            console.error(`Error generating chunk ${index}`, e);
            
            if (retries > 0) {
               delete chunkPromisesRef.current[index]; 
               await new Promise(r => setTimeout(r, 1000));
               return generateChunkAudio(index, retries - 1);
            }

            setAudioState(prev => {
                const newChunks = [...prev.chunks];
                if (newChunks[index]) newChunks[index].isLoading = false; 
                return { ...prev, chunks: newChunks };
            });
            
            delete chunkPromisesRef.current[index];
            return null;
        }
    })();

    // Store promise
    chunkPromisesRef.current[index] = promise;
    return promise;
  };

  const playAudio = async (startIndex: number = 0) => {
    const requestId = ++playRequestIdRef.current;
    const sessionId = playbackSessionRef.current;
    releaseCurrentAudioElement();

    const chunk = audioStateRef.current.chunks[startIndex];
    if (!chunk) return;

    let url = chunk.blobUrl;
    
    // If no URL, we MUST wait for generation
    if (!url) {
        url = await generateChunkAudio(startIndex);
        // Intent Check: The user might have hit pause WHILE generating.
        if (!shouldPlayRef.current) return;
        if (requestId !== playRequestIdRef.current || sessionId !== playbackSessionRef.current) return;
        if (!url) return;
    }

    if (requestId !== playRequestIdRef.current || sessionId !== playbackSessionRef.current) return;

    const audio = new Audio(url);
    audio.playbackRate = audioStateRef.current.playbackRate;
    
    // Check intent again right before playing
    if (!shouldPlayRef.current) return;
    if (requestId !== playRequestIdRef.current || sessionId !== playbackSessionRef.current) return;

    setAudioState(prev => ({
        ...prev,
        audioElement: audio,
        currentChunkIndex: startIndex,
        isPlaying: true
    }));
    
    // --- AGGRESSIVE PRE-FETCH TRIGGER ---
    const nextIndex = startIndex + 1;
    if (nextIndex < audioStateRef.current.chunks.length) {
         console.log(`[Auto] Aggressive pre-fetch started for chunk ${nextIndex}`);
         generateChunkAudio(nextIndex);
    }

    audio.onended = () => {
        if (requestId !== playRequestIdRef.current || sessionId !== playbackSessionRef.current) return;
        const nextIndex = startIndex + 1;
        if (nextIndex < audioStateRef.current.chunks.length) {
            if (shouldPlayRef.current) {
                playAudio(nextIndex);
            }
        } else {
            setAudioState(prev => ({ ...prev, isPlaying: false, currentChunkIndex: 0 }));
            setVisualProgress(0);
            shouldPlayRef.current = false;
        }
    };
    
    try {
       await audio.play();
    } catch (e) {
        console.error("Play failed", e);
        if (requestId === playRequestIdRef.current && sessionId === playbackSessionRef.current) {
          setAudioState(prev => ({ ...prev, isPlaying: false }));
        }
    }
  };

  const togglePlayPause = () => {
    const currentAudio = audioStateRef.current.audioElement;
    
    if (shouldPlayRef.current) {
        // User wants to PAUSE
        shouldPlayRef.current = false;
        if (currentAudio) currentAudio.pause();
        setAudioState(prev => ({ ...prev, isPlaying: false }));
    } else {
        // User wants to PLAY
        shouldPlayRef.current = true;
        
        if (currentAudio) {
            currentAudio.play().then(() => {
              setAudioState(prev => ({ ...prev, isPlaying: true }));
            }).catch((e) => {
              console.error("Resume failed", e);
              setAudioState(prev => ({ ...prev, isPlaying: false }));
            });
        } else {
             const currentState = audioStateRef.current;
             if (currentState.chunks.length === 0) {
                 const chunks = splitContentIntoChunks(sectionContent);
                 const audioChunks: AudioChunk[] = chunks.map((t, i) => ({
                     text: t,
                     index: i,
                     blobUrl: null,
                     duration: 0,
                     isLoading: false
                 }));
                 
                 setAudioState(prev => ({ ...prev, chunks: audioChunks }));
                 setTimeout(() => {
                    startFromScratch(audioChunks);
                 }, 0);
            } else {
                playAudio(currentState.currentChunkIndex);
            }
        }
    }
  };

  const startFromScratch = async (chunks: AudioChunk[]) => {
      playbackSessionRef.current += 1;
      releaseCurrentAudioElement();
      playRequestIdRef.current += 1;

      setAudioState(prev => ({ ...prev, chunks: chunks, currentChunkIndex: 0 }));
      audioStateRef.current = { ...audioStateRef.current, chunks, currentChunkIndex: 0, audioElement: null, isPlaying: false };
      shouldPlayRef.current = true;
      chunkPromisesRef.current = {}; 
      
      await playAudio(0);
  };

  const handleNextChunk = (nextIndex: number) => {
      if (!shouldPlayRef.current) return;

      const currentChunks = audioStateRef.current.chunks;
      if (nextIndex < currentChunks.length) {
          playAudio(nextIndex); // Use centralized playAudio
      } else {
          setAudioState(prev => ({ ...prev, isPlaying: false, currentChunkIndex: 0 }));
          setVisualProgress(0);
          shouldPlayRef.current = false;
      }
  };

  const stopAudio = (clearChunks = false) => {
    shouldPlayRef.current = false;
    playbackSessionRef.current += 1;
    playRequestIdRef.current += 1;
    
    // Stop element if playing
    releaseCurrentAudioElement();
    
    // Clear the promises cache to prevent async returns from resolving into a dead state
    chunkPromisesRef.current = {};

    if (clearChunks) {
      audioStateRef.current.chunks.forEach((chunk) => revokeTrackedUrl(chunk.blobUrl));
    }

    setAudioState(prev => ({ 
        ...prev, 
        isPlaying: false, 
        currentChunkIndex: 0, 
        audioElement: null,
        // Crucial: If clearChunks is true (when switching sections), wipe the array
        // to prevent the player from seeing old text segments.
        chunks: clearChunks ? [] : prev.chunks 
    }));
    
    setVisualProgress(0);
    setCalibrationOffset(0);
  };
  
  // Seek Handler
  const handleSeek = (time: number) => {
    if (audioStateRef.current.audioElement) {
        audioStateRef.current.audioElement.currentTime = time;
        setPlayerCurrentTime(time);
    }
  };

  // Skip Chunk Handler
  const handleSkipChunk = (direction: 'prev' | 'next') => {
    const current = audioStateRef.current;
    const wasPlaying = shouldPlayRef.current && Boolean(current.audioElement) && !current.audioElement.paused;
    releaseCurrentAudioElement();
    playRequestIdRef.current += 1;
    shouldPlayRef.current = wasPlaying;

    let newIndex = current.currentChunkIndex;
    if (direction === 'next') newIndex++;
    else newIndex--;

    if (newIndex >= 0 && newIndex < current.chunks.length) {
        if (wasPlaying) {
          playAudio(newIndex);
        } else {
          setAudioState(prev => ({
            ...prev,
            currentChunkIndex: newIndex,
            audioElement: null,
            isPlaying: false
          }));
          if (!current.chunks[newIndex].blobUrl) {
            generateChunkAudio(newIndex);
          }
        }
    } else {
        if (wasPlaying && current.audioElement) {
          current.audioElement.play().catch((e) => console.error("Resume after invalid skip failed", e));
        }
    }
  };
  
  // --- Calibration: Double Click ---

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!contentRef.current || !isAutoTrackEnabled) return;

    const rect = contentRef.current.getBoundingClientRect();
    const clickY = e.clientY - rect.top; // Relative Y in container
    const relativeY = Math.max(0, Math.min(1, clickY / rect.height));
    
    const newOffset = relativeY - visualProgress;
    setCalibrationOffset(newOffset);
  };

  // --- Handlers (Existing) ---

  const handleToggleRuler = () => {
      const newState = !isRulerActive;
      setIsRulerActive(newState);
      setIsAutoTrackEnabled(newState);
      // Logic: If user manually toggles Ruler OFF, we should also break the sync link to avoid confusion
      if (!newState) {
          setIsAudioSyncLinked(false);
      }
  };

  const handleToggleAudioSyncLink = () => {
     const newState = !isAudioSyncLinked;
     setIsAudioSyncLinked(newState);
     
     if (!newState) {
         // User explicitly turning OFF sync -> Force Ruler/Mode OFF immediately
         setIsRulerActive(false);
         setIsAutoTrackEnabled(false);
     } else {
         // User turning ON sync -> Sync immediately to current audio state
         setIsRulerActive(audioState.isPlaying);
         setIsAutoTrackEnabled(audioState.isPlaying);
     }
  };

  // TTS Test Handler
  const handleTTSPlayTest = async () => {
    if (isTestPlaying && testAudioRef.current) {
      testAudioRef.current.pause();
      setIsTestPlaying(false);
      return;
    }

    setIsTestPlaying(true);
    try {
      const pcmBuffer = await GeminiService.generateSpeech(testText, testVoice);
      const wavBlob = createWavBlob(pcmBuffer);
      const url = URL.createObjectURL(wavBlob);
      
      if (testAudioRef.current) {
        testAudioRef.current.pause();
      }
      
      const audio = new Audio(url);
      testAudioRef.current = audio;
      
      audio.onended = () => {
        setIsTestPlaying(false);
        URL.revokeObjectURL(url);
      };
      
      audio.onerror = () => {
        setIsTestPlaying(false);
        alert("Errore nella riproduzione audio");
      };
      
      await audio.play();
    } catch (error: any) {
      console.error("TTS Test error:", error);
      alert("Errore TTS: " + error.message);
      setIsTestPlaying(false);
    }
  };

  // Helper to extract text from a zip file
  const processZipFile = async (file: File): Promise<FileData> => {
    const zip = new JSZip();
    try {
      const contents = await zip.loadAsync(file);
      let combinedText = `PROJECT: ${file.name}\n\n`;
      let fileCount = 0;

      // Use an array to store promises so we can wait for all text reads
      const promises: Promise<void>[] = [];

      contents.forEach((relativePath, zipEntry) => {
         // 1. Skip directories
         if (zipEntry.dir) return;

         // 2. Skip ignored directories
         const parts = relativePath.split('/');
         if (parts.some(p => IGNORED_DIRS.includes(p) || p.startsWith('.'))) return;

         // 3. CONTENT-BASED FILTERING
         // Instead of relying on extensions, we check the actual file content.
         promises.push((async () => {
             // Read as raw bytes first to inspect
             const rawData = await zipEntry.async("uint8array");
             
             // Check if it's binary
             if (isBinaryFile(rawData)) {
                 // Skip binary files (images, executables, compiled objects)
                 return;
             }

             // Decode text
             try {
                const text = new TextDecoder("utf-8").decode(rawData);
                
                // Optional: Filter out empty files or huge files to prevent context overflow
                if (text.trim().length === 0) return;
                
                // Add to project context
                combinedText += `\n\n--- START OF FILE: ${relativePath} ---\n\n${text}`;
                fileCount++;
             } catch (e) {
                // If decoding fails, it's likely a weird encoding or binary we missed
                console.warn(`Skipping ${relativePath} due to decoding error`);
             }
         })());
      });

      // Execute all reads
      await Promise.all(promises);

      if (fileCount === 0) {
        throw new Error("No readable text files found in this archive.");
      }
      
      combinedText = `This document contains the source code of a project. Analyze it as a whole codebase.\n\n${combinedText}`;

      // Convert combined text to Base64 for the Gemini Service
      // We use btoa with unescape/encodeURIComponent to handle Unicode correctly in browser environment
      const base64Content = btoa(unescape(encodeURIComponent(combinedText)));

      return {
        name: file.name,
        mimeType: 'text/plain', // We lie to Gemini and say it's plain text, because we concatenated it
        data: base64Content
      };
      
    } catch (e) {
      console.error("ZIP Error", e);
      throw new Error("Failed to process ZIP file: " + (e as any).message);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setIsLoading(true);
      setLoadingStatus("Caricamento..."); // Reset status
      try {
        let newFile: FileData;

        if (selectedFile.name.endsWith('.zip')) {
           newFile = await processZipFile(selectedFile);
        } else {
           // Existing PDF/Image logic
           const reader = new FileReader();
           newFile = await new Promise<FileData>((resolve) => {
              reader.onload = (event) => {
                const base64Data = (event.target?.result as string).split(',')[1];
                resolve({
                  name: selectedFile.name,
                  mimeType: selectedFile.type,
                  data: base64Data
                });
              };
              reader.readAsDataURL(selectedFile);
           });
        }
        setFile(newFile);
      } catch (err) {
        alert("Errore nel caricamento del file: " + (err as any).message);
      } finally {
        setIsLoading(false);
      }
    }
  };

  const handlePlanUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const json = JSON.parse(event.target?.result as string);
          
          // Check if it's a full export or just the plan
          if (json.learningPlan) {
            setImportedPlan(json.learningPlan);
            if (json.isLearnMode !== undefined) {
              setIsLearnMode(json.isLearnMode);
            } else if (json.syllabus && json.syllabus.length > 0) {
              // Infer learn mode from presence of syllabus
              setIsLearnMode(true);
            }
            if (json.userProfile) setUserProfile(json.userProfile);
            if (json.syllabus) setSyllabus(json.syllabus as SyllabusItem[]);
          } else {
            setImportedPlan(json);
            // If it's a legacy JSON but has sections with parentId, it's likely Learn Mode
            if (json.sections && json.sections.some((s: any) => s.parentId)) {
              setIsLearnMode(true);
            }
          }
        } catch (err) {
          alert("Il file JSON non è valido.");
        }
      };
      reader.readAsText(selectedFile);
    }
  };

  const handleStartJourney = () => {
    if (!file && !importedPlan) return;

    if (importedPlan) {
      setActiveSectionId(null); // Reset to force loadSection to trigger
      
      // Infer Learn Mode if not explicitly set but sections have parentId
      if (importedPlan.sections && importedPlan.sections.some(s => !!s.parentId)) {
        setIsLearnMode(true);
      }
      
      setLearningPlan(importedPlan);
      // Load music from plan if it exists
      if (importedPlan.backgroundMusicUrl) {
          setMusicUrl(importedPlan.backgroundMusicUrl);
      }
      setState(AppState.READING);
      const next = importedPlan.sections.find(s => !s.isCompleted) || importedPlan.sections[0];
      if (next) loadSection(next, importedPlan);
    } else {
      startAssessment(file);
    }
  };

  const handleExportPlan = () => {
    if (!learningPlan) return;
    
    const exportData = {
      learningPlan,
      isLearnMode,
      userProfile,
      syllabus,
      version: "2.0"
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `lumina-plan-${new Date().toISOString().slice(0,10)}.json`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const startAssessment = async (currentFile: FileData) => {
    setState(AppState.ASSESSMENT);
    setIsLoading(true);
    setLoadingStatus("Avvio Valutazione...");
    try {
      const session = GeminiService.createAssessmentChat(currentFile);
      setChatSession(session);
      const result = await session.sendMessage({ message: "Analizza il contesto (anche se è un documento lungo) e inizia la valutazione." });
      setAssessmentMessages([{ role: 'model', text: result.text || '' }]);
    } catch (err) {
      console.error(err);
      alert("Errore nell'inizializzare la chat con Gemini. Controlla la console.");
      setState(AppState.UPLOAD);
    } finally {
      setIsLoading(false);
    }
  };

  const startLearnAssessment = async () => {
    setState(AppState.ASSESSMENT);
    setIsLoading(true);
    setLoadingStatus("Avvio Profilazione...");
    try {
      const session = GeminiService.createLearnAssessmentChat("Italiano");
      setChatSession(session);
      // We don't include the trigger message in the visible history to keep the turn counter at 1
      setAssessmentMessages([
        { role: 'model', text: "Ciao! Sono il tuo Architect. Cosa vuoi imparare esattamente oggi, e qual è il tuo obiettivo finale?" }
      ]);
    } catch (err) {
      console.error(err);
      alert("Errore nell'inizializzare la chat con Gemini. Controlla la console.");
      setState(AppState.UPLOAD);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAssessmentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentAssessmentInput.trim() || !chatSession) return;

    const userMsg: Message = { role: 'user', text: currentAssessmentInput };
    setAssessmentMessages(prev => [...prev, userMsg]);
    setCurrentAssessmentInput('');
    setIsLoading(true);
    setLoadingStatus("Valutazione risposta...");

    try {
      if (isLearnMode) {
        const response = await chatSession.sendMessage({ message: userMsg.text });
        
        const call = response.functionCalls?.[0];
        if (call && call.name === 'finalizeProfile') {
          const profile = {
            ...call.args,
            language: "Italiano"
          };
          setUserProfile(profile);
          
          setAssessmentMessages(prev => [...prev, { role: 'model', text: "Perfetto, ho capito le tue esigenze. Sto creando il tuo piano di studi personalizzato..." }]);
          
          setTimeout(async () => {
            setState(AppState.PLANNING);
            setLoadingStatus("Creazione Piano Studi...");
            await generateLearnPlan(profile);
          }, 1500);
        } else {
          setAssessmentMessages(prev => [...prev, { role: 'model', text: response.text || '' }]);
        }
      } else {
        const userTurns = assessmentMessages.filter(m => m.role === 'user').length + 1;
        
        const result = await chatSession.sendMessage({ message: userMsg.text });
        const modelText = result.text || '';
        
        setAssessmentMessages(prev => [...prev, { role: 'model', text: modelText }]);

        if (modelText.includes('[ASSESSMENT_COMPLETE]') || userTurns >= ASSESSMENT_MIN_TURNS) {
          setTimeout(async () => {
             setState(AppState.PLANNING);
             setLoadingStatus("Creazione Piano Studi...");
             await generatePlan([...assessmentMessages, userMsg, { role: 'model', text: modelText }]);
          }, 1500);
        } 
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const generateLearnPlan = async (profile: any) => {
    setIsLoading(true);
    try {
      const newSyllabus = await GeminiService.generateFullCurriculum(
        profile,
        (msg) => setLoadingStatus(msg),
        (items) => setSyllabus(items as SyllabusItem[]),
        () => setLoadingStatus("Revisione finale...")
      );
      
      // Convert SyllabusItem[] to LearningPlan format to reuse existing UI
      const plan: LearningPlan = {
        title: profile.topic,
        summary: profile.context,
        sections: newSyllabus.flatMap(mod => 
          (mod.children || []).map(lesson => ({
            id: lesson.id,
            title: lesson.title,
            description: lesson.description,
            isCompleted: false,
            type: 'core' as const,
            parentId: mod.id,
            // Store contextPrompt in a custom field or just append to description for now
            // We'll need it when generating content
            contextPrompt: lesson.contextPrompt
          }))
        )
      };
      
      setLearningPlan(plan);
      setState(AppState.READING);
      
      if (plan.sections.length > 0) {
        loadSection(plan.sections[0], plan);
      }
    } catch (err) {
      console.error("Plan generation error", err);
      alert("Errore nella generazione del piano. Riprova.");
      setState(AppState.UPLOAD); 
    } finally {
      setIsLoading(false);
    }
  };

  const generatePlan = async (history: Message[]) => {
    if (!file) return;
    setIsLoading(true);
    try {
      const plan = await GeminiService.generateLearningPlan(file, history);
      setLearningPlan(plan);
      setState(AppState.READING);
      
      if (plan.sections.length > 0) {
        loadSection(plan.sections[0], plan);
      }
    } catch (err) {
      console.error("Plan generation error", err);
      alert("Errore nella generazione del piano. Riprova.");
      setState(AppState.UPLOAD); 
    } finally {
      setIsLoading(false);
    }
  };

  const loadSection = async (section: LearningSection, currentPlan: LearningPlan | null = learningPlan) => {
    if (!currentPlan) return;
    
    // 1. BLOCKING NAVIGATION if already loading another section (Fixes override issue)
    if (isLoading) return;

    // 2. Prevent reloading same section ONLY if it already has content
    if (activeSectionId === section.id && section.content && section.content.length > 0) return;
    
    // 3. IMMEDIATE RESET of Audio to prevent caching issues
    stopAudio(true);

    setActiveSectionId(section.id);
    setSectionContent('');
    setQuiz([]);
    setContextAnswer(null);
    setIsQuizSubmitted(false);
    setQuizAnswers([]);
    
    if (section.content && section.content.length > 0) {
      setSectionContent(section.content);
      if (section.quiz) {
        setQuiz(section.quiz);
        setQuizAnswers(new Array(section.quiz.length).fill(-1));
      }
      return;
    }

    // If we reach here, we need to generate content.
    // We need either a file or to be in Learn Mode (or have a syllabus to infer it)
    const hasParentIds = currentPlan.sections.some(s => !!s.parentId);
    const canGenerateInLearnMode = isLearnMode || (syllabus && syllabus.length > 0) || hasParentIds;
    
    if (!file && !canGenerateInLearnMode) {
        alert("Contenuto non disponibile. Carica il file fonte per generare questa lezione.");
        return;
    }

    setIsLoading(true);
    setLoadingStatus("Analisi contenuti...");

    const completedTitles = currentPlan.sections
      .filter(s => s.isCompleted)
      .map(s => s.title)
      .join(", ");

    try {
      // If we don't have a file but we have parentIds, we MUST use Learn Mode generation
      if (isLearnMode || (!file && hasParentIds)) {
        if (!isLearnMode) setIsLearnMode(true); // Sync state if inferred
        
        const parentModule = syllabus.find(m => m.id === section.parentId);
        const moduleTitle = parentModule ? parentModule.title : '';

        const content = await GeminiService.generateLearnLessonContent(
          section.title,
          moduleTitle,
          section.parentId!,
          section.id,
          section.contextPrompt,
          userProfile,
          syllabus,
          (status) => setLoadingStatus(status)
        );
        
        setSectionContent(content);
        setQuiz([]);
        setQuizAnswers([]);

        setLearningPlan((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            sections: prev.sections.map(s => 
              s.id === section.id ? { ...s, content: content, quiz: [] } : s
            )
          };
        });

      } else {
        const { content, quiz } = await GeminiService.generateSectionContent(
          file!, 
          section.title, 
          section.description, 
          completedTitles,
          (status) => setLoadingStatus(status)
        );
        
        setSectionContent(content);
        setQuiz(quiz);
        setQuizAnswers(new Array(quiz.length).fill(-1));

        setLearningPlan((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            sections: prev.sections.map(s => 
              s.id === section.id ? { ...s, content: content, quiz: quiz } : s
            )
          };
        });
      }

    } catch (err) {
      console.error(err);
      alert("Errore nella generazione della lezione.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleVoiceChange = (voice: VoiceName) => {
    stopAudio(true); // Changing voice invalidates cached chunks
    setAudioState(prev => ({ ...prev, currentVoice: voice }));
  };

  const handleSpeedChange = (speed: number) => {
     setAudioState(prev => ({ ...prev, playbackRate: speed }));
  };

  // ... Context Menu Handlers
  const handleContextMenu = (e: React.MouseEvent) => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      if (contentRef.current && contentRef.current.contains(selection.anchorNode?.parentElement || null)) {
        e.preventDefault();
        setContextMenu({
          visible: true,
          x: e.clientX,
          y: e.clientY,
          selectedText: selection.toString()
        });
      }
    }
  };

  const handleGlobalClick = () => {
    if (contextMenu.visible) {
        setContextMenu({ ...contextMenu, visible: false });
    }
  };

  const handleContextQuestion = async (question: string) => {
    if (!file) return;
    const { selectedText } = contextMenu;
    setIsContextLoading(true);
    try {
      const answer = await GeminiService.askContextualQuestion(file, selectedText, question);
      setContextAnswer({ q: question, a: answer });
      setContextMenu({ ...contextMenu, visible: false });
    } catch (e) { console.error(e); } finally { setIsContextLoading(false); }
  };

  const handleCreateLesson = async (instructions: string) => {
    if (!file || !learningPlan || !activeSectionId) return;
    const { selectedText } = contextMenu;
    const parentSection = learningPlan.sections.find(s => s.id === activeSectionId);
    if (!parentSection) return;
    setIsContextLoading(true);
    try {
      const newSection = await GeminiService.createSubChapterMetadata(file, parentSection, selectedText, instructions);
      const parentIndex = learningPlan.sections.findIndex(s => s.id === activeSectionId);
      const newSections = [...learningPlan.sections];
      newSections.splice(parentIndex + 1, 0, newSection);
      setLearningPlan({ ...learningPlan, sections: newSections });
      setContextMenu({ ...contextMenu, visible: false });
      alert(`Nuova lezione "${newSection.title}" aggiunta al piano!`);
    } catch (e) { console.error(e); alert("Impossibile creare la lezione."); } finally { setIsContextLoading(false); }
  };

  const applyStyleToSelection = (targetText: string) => {
      if (!activeSectionId || !learningPlan) return;

      // 1. Split selected text into alphanumeric words (Unicode supported).
      const words = targetText.match(/[\p{L}\p{N}]+/gu) || [];
      
      if (words.length === 0) return;

      // 2. Escape Regex for each word
      const escapedWords = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      
      // 3. Join words allowing for basically ANYTHING in between that isn't the next word.
      const junkPattern = '[^\\p{L}\\p{N}]+';
      
      // Pattern: word1 + junk + word2 + junk ...
      const pattern = escapedWords.join(junkPattern);
      
      // SNAP-TO-WORD LOGIC:
      // We wrap the pattern in word characters to capture partial selections.
      // e.g. "roble" -> match "\w*roble\w*" -> "problema"
      // Note: We use [\p{L}\p{N}] instead of \w to support unicode (accents).
      const wordChar = '[\\p{L}\\p{N}]';
      
      // This regex matches:
      // 0 or more word-chars + the selected text + 0 or more word-chars
      // effectively expanding the match to the nearest word boundaries.
      const expandedPattern = `${wordChar}*${pattern}${wordChar}*`;
      
      const regex = new RegExp(expandedPattern, 'iu'); // Case insensitive + Unicode
      
      // Find the expanded match in the content
      const match = sectionContent.match(regex);
      
      let newContent = sectionContent;

      if (match) {
          const startIdx = match.index!;
          const endIdx = startIdx + match[0].length;
          const matchedText = match[0]; // The FULL word(s) found
          
          // Check if ALREADY styled with specific tag (Toggle logic)
          // We need to check for both styles to allow overriding or removing
          // Use the EXACT matched text for the check
          const escapedMatch = matchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const exactHighlightedRegex = new RegExp(`<mark>${escapedMatch}</mark>`, 'i');
          
          if (exactHighlightedRegex.test(sectionContent)) {
               // Toggle OFF
               newContent = sectionContent.replace(exactHighlightedRegex, matchedText);
          } else {
               // Apply Style
               const before = sectionContent.substring(0, startIdx);
               const after = sectionContent.substring(endIdx);
               newContent = before + `<mark>${matchedText}</mark>` + after;
          }
      } else {
          // Fallback simple replace if fuzzy match fails (shouldn't happen often)
          if (sectionContent.includes(targetText)) {
               newContent = sectionContent.replace(targetText, `<mark>${targetText}</mark>`);
          }
      }
      
      setSectionContent(newContent);
      
      // Persist to plan
      setLearningPlan((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            sections: prev.sections.map(s => 
              s.id === activeSectionId ? { ...s, content: newContent } : s
            )
          };
      });
  };
  
  const handleHighlight = () => {
    const { selectedText } = contextMenu;
    if (!selectedText) return;
    
    applyStyleToSelection(selectedText);
    setContextMenu({ ...contextMenu, visible: false });
  };

  const completeSection = () => {
    if (!learningPlan || !activeSectionId) return;
    const newSections = learningPlan.sections.map(s => s.id === activeSectionId ? { ...s, isCompleted: true } : s);
    const updatedPlan = { ...learningPlan, sections: newSections };
    setLearningPlan(updatedPlan);
    const currentIndex = newSections.findIndex(s => s.id === activeSectionId);
    if (currentIndex < newSections.length - 1) loadSection(newSections[currentIndex + 1], updatedPlan);
    else alert("Percorso completato! Ricordati di esportare il tuo progresso.");
  };

  // ... (Upload View, Assessment View - Same)
  if (state === AppState.UPLOAD) {
      return (
      <div className="min-h-screen w-full flex items-center justify-center bg-paper-light dark:bg-paper-dark p-4 transition-colors duration-300">
        <button 
          onClick={() => setIsDarkMode(!isDarkMode)}
          className="absolute top-6 right-6 p-2 rounded-full text-gray-500 hover:bg-gray-200 dark:hover:bg-zinc-800 dark:text-gray-400 transition-colors"
        >
          {isDarkMode ? <Sun className="w-6 h-6" /> : <Moon className="w-6 h-6" />}
        </button>
        <div className="max-w-4xl w-full text-center space-y-12">
          <div>
            <h1 className="text-6xl font-serif font-bold text-gray-900 dark:text-white mb-6 tracking-tight">Lumina Deep Reader</h1>
            <p className="text-gray-500 dark:text-gray-400 font-sans text-xl max-w-xl mx-auto leading-relaxed">
              Il tuo compagno AI per lo studio approfondito di volumi complessi e basi di codice.
            </p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 px-4">
            <div className={`relative group transition-all duration-300 ${file ? 'opacity-100 scale-100' : 'opacity-100'}`}>
               <label className={`
                  flex flex-col items-center justify-center h-64 cursor-pointer rounded-3xl border-2 transition-all duration-300 relative overflow-hidden bg-white dark:bg-zinc-900
                  ${file 
                    ? 'border-green-500 shadow-[0_20px_40px_-10px_rgba(34,197,94,0.15)] ring-4 ring-green-50 dark:ring-green-900/20' 
                    : 'border-gray-200 dark:border-zinc-800 hover:border-orange-300 dark:hover:border-orange-700 hover:shadow-xl hover:shadow-orange-100/50 dark:hover:shadow-none dashed'
                  }
               `}>
                  {file ? (
                    <div className="flex flex-col items-center animate-in zoom-in duration-300">
                      <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 rounded-full flex items-center justify-center mb-4 shadow-sm">
                        <CheckCircle2 className="w-8 h-8" />
                      </div>
                      <span className="text-green-800 dark:text-green-200 font-bold text-lg px-8 truncate max-w-xs">{file.name}</span>
                      <span className="text-green-600/60 dark:text-green-400/60 text-sm mt-1">Pronto per l'analisi</span>
                      
                      <button 
                        onClick={(e) => { e.preventDefault(); setFile(null); }}
                        className="absolute top-4 right-4 p-2 text-gray-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full transition-colors"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                  ) : (
                    isLoading ? (
                        <div className="flex flex-col items-center">
                            <Gauge className="w-10 h-10 text-orange-500 animate-spin mb-4" />
                            <p className="text-sm font-semibold text-gray-600 dark:text-gray-300">{loadingStatus}</p>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center group-hover:scale-105 transition-transform duration-300">
                        <div className="w-20 h-20 bg-orange-50 dark:bg-orange-900/20 text-orange-500 rounded-2xl flex items-center justify-center mb-6 rotate-3 group-hover:rotate-6 transition-transform relative">
                             <FileText className="w-10 h-10 absolute -ml-4 -mt-2" />
                             <FolderArchive className="w-8 h-8 absolute ml-4 mt-4 text-orange-400" />
                        </div>
                        <p className="text-xl font-serif font-bold text-gray-800 dark:text-gray-200 mb-2">1. Carica Fonte</p>
                        <p className="text-sm text-gray-400 max-w-[200px]">PDF (Libri, Paper)<br/>o ZIP (Codice, Progetti)</p>
                        <div className="mt-6 px-4 py-1 bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-gray-400 text-xs font-bold uppercase tracking-wider rounded-full">Obbligatorio</div>
                        </div>
                    )
                  )}
                  <input type="file" className="hidden" accept=".pdf,.zip" onChange={handleFileUpload} />
               </label>
            </div>

            <div className="relative group">
              <label className={`
                  flex flex-col items-center justify-center h-64 cursor-pointer rounded-3xl border-2 border-dashed transition-all duration-300 bg-white dark:bg-zinc-900
                  ${importedPlan 
                    ? 'border-blue-500 shadow-[0_20px_40px_-10px_rgba(59,130,246,0.15)] ring-4 ring-blue-50 dark:ring-blue-900/20 border-solid' 
                    : 'border-gray-200 dark:border-zinc-800 hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-xl hover:shadow-blue-100/50 dark:hover:shadow-none'
                  }
               `}>
                 {importedPlan ? (
                    <div className="flex flex-col items-center animate-in zoom-in duration-300">
                      <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-full flex items-center justify-center mb-4 shadow-sm">
                        <CheckCircle2 className="w-8 h-8" />
                      </div>
                      <span className="text-blue-900 dark:text-blue-200 font-bold text-lg px-8 truncate max-w-xs">{importedPlan.title || "Piano Personalizzato"}</span>
                      <span className="text-blue-600/60 dark:text-blue-400/60 text-sm mt-1">{importedPlan.sections.length} Lezioni caricate</span>
                      
                      <button 
                        onClick={(e) => { e.preventDefault(); setImportedPlan(null); }}
                        className="absolute top-4 right-4 p-2 text-gray-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-full transition-colors"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center group-hover:scale-105 transition-transform duration-300">
                      <div className="w-20 h-20 bg-blue-50 dark:bg-blue-900/20 text-blue-500 rounded-2xl flex items-center justify-center mb-6 -rotate-3 group-hover:-rotate-6 transition-transform">
                        <FileJson className="w-10 h-10" />
                      </div>
                      <p className="text-xl font-serif font-bold text-gray-800 dark:text-gray-200 mb-2">2. Carica Piano</p>
                      <p className="text-sm text-gray-400 max-w-[200px]">Hai già un file .json?<br/>Riprendi da dove hai lasciato.</p>
                      <div className="mt-6 px-4 py-1 bg-gray-100 dark:bg-zinc-800 text-gray-400 text-xs font-bold uppercase tracking-wider rounded-full">Opzionale</div>
                    </div>
                  )}
                <input type="file" className="hidden" accept=".json" onChange={handlePlanUpload} disabled={!!importedPlan} />
              </label>
            </div>
          </div>
          
          <div className="pt-8">
            <button
              onClick={handleStartJourney}
              disabled={!file && !importedPlan}
              className={`
                group relative inline-flex items-center justify-center gap-3 px-12 py-5 rounded-full text-lg font-medium transition-all duration-300
                ${(file || importedPlan) 
                  ? 'bg-gray-900 dark:bg-white text-white dark:text-black hover:bg-black dark:hover:bg-gray-200 hover:scale-105 hover:shadow-2xl cursor-pointer' 
                  : 'bg-gray-200 dark:bg-zinc-800 text-gray-400 dark:text-zinc-600 cursor-not-allowed'
                }
              `}
            >
              {importedPlan ? "Riprendi lo Studio" : "Inizia Analisi & Percorso"}
              <ArrowRight className={`w-5 h-5 transition-transform duration-300 ${(file || importedPlan) ? 'group-hover:translate-x-1' : ''}`} />
            </button>
            
            <div className="mt-6">
              <button
                onClick={() => {
                  setIsLearnMode(true);
                  startLearnAssessment();
                }}
                className="group relative inline-flex items-center justify-center gap-3 px-8 py-3 rounded-full text-md font-medium transition-all duration-300 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 hover:bg-orange-200 dark:hover:bg-orange-900/50 hover:scale-105 cursor-pointer"
              >
                <BrainCircuit className="w-5 h-5" />
                Impara Qualcosa di Nuovo (Senza File)
              </button>
            </div>

            {!file && !importedPlan && (
              <p className="mt-4 text-sm text-gray-400 animate-in fade-in">
                Carica almeno il file Fonte (PDF o ZIP) per attivare l'analisi del documento.
              </p>
            )}
          </div>

          {/* TTS Test Panel */}
          <div className="mt-8 pt-8 border-t border-gray-200 dark:border-zinc-800">
            <div className="max-w-2xl mx-auto">
              <div className="bg-white dark:bg-zinc-900 rounded-2xl p-6 shadow-lg border border-gray-100 dark:border-zinc-800">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
                    <Volume2 className="w-5 h-5 text-orange-500" />
                    Test Sintesi Vocale (Qwen3-TTS)
                  </h3>
                  <div className="flex items-center gap-2">
                    {ttsConnected ? (
                      <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                        <Wifi className="w-3 h-3" /> Connesso
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                        <WifiOff className="w-3 h-3" /> Disconnesso
                      </span>
                    )}
                  </div>
                </div>
                
                <div className="space-y-4">
                  {/* Voice Selection */}
                  <div className="flex items-center gap-4">
                    <label className="text-sm text-gray-600 dark:text-gray-400">Voce:</label>
                    <div className="flex gap-2">
                      {(['Marco', 'Giulia'] as VoiceName[]).map((voice) => (
                        <button
                          key={voice}
                          onClick={() => setTestVoice(voice)}
                          className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                            testVoice === voice
                              ? 'bg-orange-600 text-white'
                              : 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-zinc-700'
                          }`}
                        >
                          {voice}
                        </button>
                      ))}
                    </div>
                  </div>
                  
                  {/* Text Input */}
                  <div>
                    <textarea
                      value={testText}
                      onChange={(e) => setTestText(e.target.value)}
                      placeholder="Inserisci il testo da sintetizzare..."
                      className="w-full p-3 border border-gray-200 dark:border-zinc-700 rounded-lg bg-gray-50 dark:bg-zinc-800 text-gray-800 dark:text-gray-200 text-sm resize-none"
                      rows={3}
                    />
                  </div>
                  
                  {/* Play Button */}
                  <button
                    onClick={handleTTSPlayTest}
                    disabled={!ttsConnected}
                    className={`w-full py-3 rounded-lg font-medium transition-all flex items-center justify-center gap-2 ${
                      ttsConnected
                        ? isTestPlaying
                          ? 'bg-red-500 text-white hover:bg-red-600'
                          : 'bg-orange-600 text-white hover:bg-orange-700'
                        : 'bg-gray-300 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                    }`}
                  >
                    {isTestPlaying ? (
                      <>
                        <Pause className="w-5 h-5" /> Interrompi
                      </>
                    ) : (
                      <>
                        <Play className="w-5 h-5" /> Riproduci Test
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (state === AppState.ASSESSMENT) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-paper-light dark:bg-paper-dark p-4 font-sans transition-colors duration-300">
        <div className="max-w-3xl w-full bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-gray-100 dark:border-zinc-800 overflow-hidden flex flex-col h-[80vh]">
          <div className="p-6 border-b border-gray-100 dark:border-zinc-800 bg-orange-50 dark:bg-zinc-900 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <BrainCircuit className="w-6 h-6 text-orange-600" />
              <div>
                <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Calibrazione Conoscenze</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">Analisi approfondita per contenuti densi</p>
              </div>
            </div>
            <div className="text-xs font-mono text-orange-600 bg-orange-100 dark:bg-orange-900/30 px-2 py-1 rounded">
               Turno {assessmentMessages.filter(m => m.role === 'user').length + 1} / {ASSESSMENT_MIN_TURNS}
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {assessmentMessages.map((msg, idx) => {
               const displayContent = msg.text.replace('[ASSESSMENT_COMPLETE]', '');
               return (
                <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] p-5 rounded-2xl text-sm leading-relaxed shadow-sm ${
                    msg.role === 'user' 
                      ? 'bg-orange-600 text-white rounded-br-none' 
                      : 'bg-white dark:bg-zinc-800 border border-gray-100 dark:border-zinc-700 text-gray-800 dark:text-gray-200 rounded-bl-none'
                  }`}>
                    <MarkdownRenderer 
                      content={displayContent} 
                      isDarkMode={isDarkMode}
                      className={`prose-sm ${
                        msg.role === 'user' 
                          ? 'prose-invert marker:text-white/70 prose-p:text-white prose-headings:text-white prose-strong:text-white prose-a:text-white prose-code:text-white' 
                          : 'dark:prose-invert prose-p:text-gray-800 dark:prose-p:text-gray-200 prose-headings:text-gray-900 dark:prose-headings:text-white prose-strong:text-orange-700 dark:prose-strong:text-orange-400'
                      }`}
                    />
                  </div>
                </div>
              );
            })}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-white dark:bg-zinc-800 border border-gray-100 dark:border-zinc-700 p-4 rounded-2xl rounded-bl-none w-auto flex gap-2 items-center text-sm text-gray-500 dark:text-gray-400 shadow-sm">
                   <div className="w-2 h-2 bg-orange-400 rounded-full animate-bounce" style={{ animationDelay: '0ms'}}></div>
                   <div className="w-2 h-2 bg-orange-400 rounded-full animate-bounce" style={{ animationDelay: '150ms'}}></div>
                   <div className="w-2 h-2 bg-orange-400 rounded-full animate-bounce" style={{ animationDelay: '300ms'}}></div>
                   <span>{loadingStatus}</span>
                </div>
              </div>
            )}
             <div ref={messagesEndRef} />
          </div>

          <form onSubmit={handleAssessmentSubmit} className="p-4 border-t border-gray-100 dark:border-zinc-800 bg-white dark:bg-zinc-900">
            <div className="flex gap-2">
              <input 
                type="text" 
                value={currentAssessmentInput}
                onChange={(e) => setCurrentAssessmentInput(e.target.value)}
                placeholder="Scrivi la tua risposta dettagliata..."
                className="flex-1 p-4 border border-gray-200 dark:border-zinc-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-200 dark:focus:ring-orange-900 bg-gray-50 dark:bg-zinc-800 text-gray-900 dark:text-white placeholder-gray-400 transition-all focus:bg-white dark:focus:bg-zinc-800"
                disabled={isLoading}
                autoFocus
              />
              <button 
                type="submit" 
                disabled={isLoading || !currentAssessmentInput.trim()}
                className="bg-orange-600 text-white px-8 py-3 rounded-xl font-medium hover:bg-orange-700 disabled:opacity-50 transition-all shadow-md hover:shadow-lg disabled:shadow-none"
              >
                Invia
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }
  if (state === AppState.PLANNING) { return <LoadingScreen message="Analisi Volume in Corso..." subMessage={loadingStatus || "Costruzione piano..."} />; }

  return (
    <div className="min-h-screen flex bg-paper-light dark:bg-paper-dark font-sans transition-colors duration-300" onClick={handleGlobalClick}>
      
      {/* IMPLICIT AUTOTRACK: If ruler is active, we pass it down */}
      {isRulerActive && (
        <ReadingRuler 
          isPlaying={audioState.isPlaying} 
          progress={visualProgress} 
          contentRef={contentRef}
          scrollContainerRef={scrollContainerRef}
          calibrationOffset={calibrationOffset}
          teleprompterSpeed={teleprompterSpeed}
          isHeaderHovered={isHeaderHovered}
        />
      )}
      
      <div className={`w-96 bg-white dark:bg-zinc-900 border-r border-gray-200/80 dark:border-zinc-800 flex flex-col flex-shrink-0 z-20 h-full transition-all duration-500 ${isFocusMode ? '-ml-96' : ''}`}>
        <div className="px-6 py-5 border-b border-gray-200/80 dark:border-zinc-800 flex flex-col gap-4">
          <div className="flex justify-between items-start gap-4">
             <h1 className="font-serif font-bold text-xl text-gray-900 dark:text-white leading-tight">
              {learningPlan?.title || "Percorso di Studio"}
             </h1>
             <button 
                onClick={() => setIsFocusMode(true)}
                className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 p-1 hover:bg-gray-100/80 dark:hover:bg-zinc-800 rounded-md transition-colors"
                title="Nascondi Menu (Focus Mode)"
             >
                <SidebarClose className="w-5 h-5" />
             </button>
          </div>

          <button 
            onClick={handleExportPlan}
            disabled={isLoading}
            className={`flex items-center justify-center gap-2 w-full py-2.5 bg-gray-100/80 dark:bg-zinc-800/90 hover:bg-gray-200/90 dark:hover:bg-zinc-700 text-gray-700 dark:text-gray-300 rounded-lg text-xs font-semibold uppercase tracking-wider transition-colors ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <Download className="w-4 h-4" /> Salva Progresso (.json)
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="space-y-3">
            {sidebarGroups.map((group) => {
              const isExpanded = expandedModuleId === group.id;

              return (
                <section key={group.id} className="border-b border-gray-200/70 dark:border-zinc-800/90 pb-3 last:border-b-0 last:pb-0">
                  <button
                    type="button"
                    onClick={() => setExpandedModuleId(group.id)}
                    className={`w-full px-3 py-2 flex items-center gap-3 rounded-lg text-left transition-colors ${
                      isExpanded
                        ? 'text-gray-900 dark:text-gray-100'
                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100/70 dark:hover:bg-zinc-800/70'
                    }`}
                  >
                    <ChevronRight className={`w-4 h-4 flex-shrink-0 transition-transform duration-300 ${isExpanded ? 'rotate-90' : ''}`} />
                    <span className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-[0.18em] truncate">
                      {group.title}
                    </span>
                  </button>

                  <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-70'}`}>
                    <div className="overflow-hidden">
                      <div className="mt-2 ml-5 space-y-1 border-l border-gray-200 dark:border-zinc-800 pl-4">
                        {group.sections.map((section) => {
                          const isActive = activeSectionId === section.id;

                          return (
                            <button
                              key={section.id}
                              onClick={() => loadSection(section)}
                              disabled={isLoading}
                              className={`w-full text-left py-2 flex items-center gap-3 transition-colors ${
                                isActive
                                  ? 'text-gray-900 dark:text-gray-100'
                                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                              } ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                              <div className={`w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center rounded-full border transition-colors ${
                                section.isCompleted
                                  ? 'border-gray-300 dark:border-zinc-600 bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-gray-400'
                                  : isActive
                                    ? 'border-gray-500 dark:border-zinc-400 bg-gray-500 dark:bg-zinc-400 text-transparent'
                                    : 'border-gray-300 dark:border-zinc-700 bg-transparent text-transparent'
                              }`}>
                                {section.isCompleted ? <CheckCircle2 className="w-3 h-3" /> : null}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className={`text-sm truncate ${isActive ? 'font-medium' : 'font-normal'}`}>
                                  {section.title}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex-1 relative flex flex-col min-h-0 bg-paper-light dark:bg-paper-dark transition-colors duration-300">
        
        {/* HEADER 
            UPDATED: Opacity changes based on isRulerActive and Hover state.
            If Ruler Active: Opacity 0 (unless hovered).
            If Ruler Inactive: Opacity 100.
        */}
        <div 
            className={`
                h-16 border-b border-gray-100 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 backdrop-blur 
                flex items-center px-8 justify-between flex-shrink-0 z-40 relative
                transition-opacity duration-500 ease-in-out
                ${isRulerActive && !isHeaderHovered ? 'opacity-0 hover:opacity-100' : 'opacity-100'}
            `}
            onMouseEnter={() => setIsHeaderHovered(true)}
            onMouseLeave={() => setIsHeaderHovered(false)}
        >
           <div className="flex items-center gap-4 min-w-0">
              {isFocusMode && (
                <button 
                  onClick={() => setIsFocusMode(false)}
                  className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all"
                  title="Mostra Menu"
                >
                  <SidebarOpen className="w-5 h-5" />
                </button>
              )}
           </div>
           
           <div className="flex items-center gap-6">
             {isLoading && (
               <div className="flex items-center gap-2 px-4 py-1.5 bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400 rounded-full text-xs font-bold animate-pulse">
                 <span className="w-2 h-2 rounded-full bg-orange-500"></span>
                 {loadingStatus.toUpperCase()}
               </div>
             )}
             
             {/* Reading Tools */}
             <div className="flex items-center bg-gray-100 dark:bg-zinc-800 rounded-full p-1 border border-gray-200 dark:border-zinc-700 transition-all shadow-sm">
               <button 
                onClick={handleToggleRuler}
                className={`p-1.5 rounded-full transition-colors ${isRulerActive ? 'bg-orange-600 shadow text-white' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}
                title="Attiva righello di lettura (Autoscroll)"
               >
                 <Ruler className="w-4 h-4" />
               </button>
               
               {/* Teleprompter Controls (SLIDER REPLACEMENT) */}
               {isRulerActive && (
                  <div className={`flex items-center gap-2 mx-2 animate-in fade-in zoom-in-95 border-l border-gray-300 dark:border-zinc-600 pl-2 ${audioState.isPlaying ? 'opacity-50 cursor-not-allowed grayscale' : ''}`}>
                      <Gauge className="w-3 h-3 text-gray-400" />
                      <input 
                        type="range"
                        min="0.1"
                        max="3"
                        step="0.1"
                        value={teleprompterSpeed}
                        onChange={(e) => !audioState.isPlaying && setTeleprompterSpeed(parseFloat(e.target.value))}
                        disabled={audioState.isPlaying}
                        className={`w-24 h-1.5 bg-gray-300 dark:bg-zinc-600 rounded-lg appearance-none accent-orange-600 ${audioState.isPlaying ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                        title={audioState.isPlaying ? "Velocità controllata dall'audio" : "Velocità Autoscroll"}
                      />
                      <span className="text-[10px] font-mono text-gray-500 w-8 text-right">{teleprompterSpeed.toFixed(1)}x</span>
                  </div>
               )}
             </div>
             
             {/* Music Player Control */}
             <MusicPlayer 
                url={musicUrl}
                setUrl={setMusicUrl}
                isPlaying={isMusicPlaying}
                setIsPlaying={setIsMusicPlaying}
                volume={musicVolume}
                setVolume={setMusicVolume}
             />

             <div className="w-px h-4 bg-gray-300 dark:bg-zinc-600 mx-1"></div>

             <button 
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="p-2 rounded-full bg-transparent hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors border border-transparent hover:border-gray-200 dark:hover:border-zinc-700"
              title="Cambia Tema"
             >
               {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
             </button>
           </div>
        </div>

        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto overflow-x-hidden relative scroll-smooth"
        >
          <div className={`mx-auto py-12 px-12 pb-48 transition-all duration-500 ${isFocusMode ? 'max-w-3xl' : 'max-w-4xl'}`}>
            
            <div 
              ref={contentRef}
              className={`mb-16 min-h-[50vh] ${isAutoTrackEnabled ? 'cursor-crosshair' : ''}`}
              onDoubleClick={handleDoubleClick}
            >
              {isLoading ? (
                  <div className="space-y-8 animate-pulse mt-8 max-w-2xl mx-auto">
                    <div className="h-8 bg-gray-200 dark:bg-zinc-800 rounded w-3/4 mb-12"></div>
                    <div className="space-y-3">
                      <div className="h-4 bg-gray-200 dark:bg-zinc-800 rounded w-full"></div>
                      <div className="h-4 bg-gray-200 dark:bg-zinc-800 rounded w-full"></div>
                      <div className="h-4 bg-gray-200 dark:bg-zinc-800 rounded w-5/6"></div>
                    </div>
                  </div>
              ) : (
                 <>
                  {sectionContent && (
                    <MarkdownRenderer 
                      content={sectionContent} 
                      isDarkMode={isDarkMode}
                      className={`prose-xl leading-loose
                        prose-p:text-gray-800 dark:prose-p:text-gray-200 
                        prose-headings:text-gray-900 dark:prose-headings:text-white 
                        prose-headings:font-serif prose-headings:font-normal 
                        prose-strong:text-orange-800 dark:prose-strong:text-orange-400 
                        prose-strong:font-semibold
                        ${isDarkMode ? 'prose-invert' : ''}
                      `}
                      onContextMenu={handleContextMenu}
                    />
                  )}
                  {!sectionContent && (
                    <div className="text-center text-gray-400 mt-20 flex flex-col items-center">
                       <BookOpen className="w-16 h-16 opacity-20 mb-4" />
                       <p>Seleziona una sezione dal piano di studi per iniziare.</p>
                    </div>
                  )}
                 </>
              )}
            </div>
            
            {/* Quiz Section (Keep existing) */}
            {quiz.length > 0 && sectionContent && (
                  <div className="mt-24 pt-12 border-t-2 border-dashed border-gray-200 dark:border-zinc-800">
                    <div className="flex items-center gap-3 mb-8">
                      <div className="p-2 bg-orange-100 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 rounded-lg">
                        <GraduationCap className="w-6 h-6" />
                      </div>
                      <h3 className="text-2xl font-serif text-gray-900 dark:text-gray-100">Verifica Comprensione</h3>
                    </div>
                    
                    <div className="grid gap-6">
                      {quiz.map((q, qIdx) => (
                        <div key={qIdx} className="bg-white dark:bg-zinc-900 p-8 rounded-2xl shadow-sm border border-gray-100 dark:border-zinc-800 transition-all hover:shadow-md">
                          <p className="text-lg font-medium text-gray-800 dark:text-gray-200 mb-6 font-serif">{q.question}</p>
                          <div className="space-y-3">
                            {q.options.map((opt: string, oIdx: number) => (
                              <button
                                key={oIdx}
                                onClick={() => {
                                  if (isQuizSubmitted) return;
                                  const newAnswers = [...quizAnswers];
                                  newAnswers[qIdx] = oIdx;
                                  setQuizAnswers(newAnswers);
                                }}
                                className={`w-full text-left p-4 rounded-xl text-base transition-all border-2 ${
                                  isQuizSubmitted
                                    ? oIdx === q.correctIndex
                                      ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-300'
                                      : quizAnswers[qIdx] === oIdx
                                        ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300'
                                        : 'border-transparent opacity-50 bg-gray-50 dark:bg-zinc-800'
                                    : quizAnswers[qIdx] === oIdx
                                      ? 'bg-orange-50 dark:bg-orange-900/10 border-orange-300 dark:border-orange-700 text-orange-900 dark:text-orange-300 shadow-sm'
                                      : 'bg-white dark:bg-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-700 border-gray-100 dark:border-zinc-700 text-gray-600 dark:text-gray-400'
                                }`}
                              >
                                <span className="inline-block w-6 font-bold opacity-40 mr-2">{String.fromCharCode(65 + oIdx)}.</span>
                                {opt}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-12 flex justify-end pb-12">
                      {!isQuizSubmitted ? (
                        <button
                          onClick={() => setIsQuizSubmitted(true)}
                          disabled={quizAnswers.includes(-1)}
                          className="bg-gray-900 dark:bg-white text-white dark:text-black px-8 py-4 rounded-xl font-medium hover:bg-black dark:hover:bg-gray-200 disabled:opacity-50 transition-colors shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
                        >
                          Controlla Risposte
                        </button>
                      ) : (
                        <button
                          onClick={completeSection}
                          className="bg-orange-600 text-white px-10 py-4 rounded-xl font-medium hover:bg-orange-700 shadow-xl shadow-orange-200 dark:shadow-none flex items-center gap-3 transition-all hover:-translate-y-1"
                        >
                          Completa e Prosegui <ChevronRight className="w-5 h-5" />
                        </button>
                      )}
                    </div>
                  </div>
                )}
          </div>
        </div>
        
        {sectionContent && (
          <AudioPlayer
            isPlaying={audioState.isPlaying}
            // CRITICAL: Only show loading on player if CURRENT chunk is loading.
            // Future chunks loading in bg should not lock UI.
            isLoading={audioState.chunks[audioState.currentChunkIndex]?.isLoading || false}
            currentVoice={audioState.currentVoice}
            playbackRate={audioState.playbackRate}
            isVertical
            dockOffsetPx={audioDockOffset}
            currentTime={playerCurrentTime}
            duration={playerDuration}
            onPlayPause={togglePlayPause}
            onVoiceChange={handleVoiceChange}
            onSpeedChange={handleSpeedChange}
            onSeek={handleSeek}
            onSkipChunk={handleSkipChunk}
            isAudioSyncLinked={isAudioSyncLinked}
            onToggleAudioSyncLink={handleToggleAudioSyncLink}
            ttsConnected={ttsConnected}
          />
        )}
        
        {/* Context Menu and Answer overlays (Same) */}
        {contextAnswer && (
          <div 
            className="fixed bottom-24 right-8 max-w-md w-full bg-white dark:bg-zinc-900 p-6 rounded-2xl shadow-[0_10px_40px_-10px_rgba(0,0,0,0.2)] border border-orange-100 dark:border-orange-900/30 animate-in slide-in-from-bottom-10 duration-500 z-50"
            onClick={(e) => e.stopPropagation()} 
          >
             <div className="flex justify-between items-start mb-4">
               <div className="flex items-center gap-2 text-orange-600 dark:text-orange-400 text-xs font-bold uppercase tracking-wider bg-orange-50 dark:bg-orange-900/20 px-3 py-1 rounded-full">
                  <MessageSquare className="w-3 h-3" /> Risposta AI
               </div>
               <button onClick={() => setContextAnswer(null)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 bg-gray-50 dark:bg-zinc-800 p-1 rounded-full"><XIcon className="w-4 h-4" /></button>
             </div>
             <p className="text-base font-serif font-bold text-gray-900 dark:text-gray-100 mb-3 border-l-2 border-orange-500 pl-3">"{contextAnswer.q}"</p>
             <div className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed max-h-80 overflow-y-auto pr-2 custom-scrollbar">
                <MarkdownRenderer content={contextAnswer.a} isDarkMode={isDarkMode} className="prose-sm prose-p:text-gray-600 dark:prose-p:text-gray-300" />
             </div>
          </div>
        )}

        {contextMenu.visible && (
          <ContextMenu 
            {...contextMenu} 
            onClose={() => setContextMenu({ ...contextMenu, visible: false })}
            onAsk={handleContextQuestion}
            onCreateLesson={handleCreateLesson}
            onHighlight={handleHighlight}
            isLoading={isContextLoading} 
          />
        )}
      </div>
    </div>
  );
};

const XIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
);

export default App;
