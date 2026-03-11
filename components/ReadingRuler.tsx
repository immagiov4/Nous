import { memo, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { buildReadableBlocks, type ReadableBlock } from '../utils/readingText';

const Y_PERCENTAGE = 0.45;

interface ReadingRulerProps {
  isPlaying?: boolean;
  progress?: number; // 0 to 1
  contentRef?: RefObject<HTMLDivElement | null>;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  calibrationOffset: number; 
  teleprompterSpeed?: number;
  isHeaderHovered: boolean; 
}

const ReadingRuler = ({
  isPlaying, 
  progress = 0, 
  contentRef,
  scrollContainerRef, 
  calibrationOffset,
  teleprompterSpeed = 1,
  isHeaderHovered
}: ReadingRulerProps) => {
  const [y, setY] = useState(window.innerHeight * Y_PERCENTAGE); 
  const [segments, setSegments] = useState<ReadableBlock[]>([]);
  const teleprompterRef = useRef<number>(0);
  
  // Float accumulator for smooth sub-pixel scrolling
  const scrollAccumulatorRef = useRef<number>(0);
  const contentMarkup = contentRef?.current?.innerHTML ?? '';

  // Initialize accumulator
  useEffect(() => {
    if (scrollContainerRef?.current) {
        scrollAccumulatorRef.current = scrollContainerRef.current.scrollTop;
    }
  }, [scrollContainerRef]);

  useEffect(() => {
    const handleResize = () => setY(window.innerHeight * Y_PERCENTAGE);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const calculateSegments = useCallback(() => {
    void contentMarkup;

    const container = contentRef?.current;
    if (!container) {
      setSegments([]);
      return;
    }

    const nextSegments = buildReadableBlocks(container);
    if (nextSegments.length === 0) {
      setSegments([]);
      return;
    }

    setSegments(nextSegments);
  }, [contentMarkup, contentRef]);

  useEffect(() => {
    calculateSegments();
    window.addEventListener('resize', calculateSegments);

    return () => {
      window.removeEventListener('resize', calculateSegments);
    };
  }, [calculateSegments]);

  const getCalibratedY = useCallback((rawProgress: number, rect: DOMRect): number => {
    let effectiveProgress = rawProgress + calibrationOffset;
    effectiveProgress = Math.max(0, Math.min(1, effectiveProgress));

    const segment = segments.find(s => effectiveProgress >= s.startAudio && effectiveProgress <= s.endAudio);
    
    let targetPxRelativeToContainer = 0;
    
    if (segment) {
       const segmentLocalProgress = (effectiveProgress - segment.startAudio) / (segment.endAudio - segment.startAudio);
       targetPxRelativeToContainer = segment.top + (segmentLocalProgress * (segment.bottom - segment.top));
    } else {
       let prevSegment = null;
       let nextSegment = null;
       
       for (let i = 0; i < segments.length; i++) {
         if (effectiveProgress > segments[i].endAudio) {
           prevSegment = segments[i];
         } else {
           nextSegment = segments[i];
           break;
         }
       }

       if (prevSegment && nextSegment) {
          const gapStartAudio = prevSegment.endAudio;
          const gapEndAudio = nextSegment.startAudio;
          const gapProgress = (effectiveProgress - gapStartAudio) / (gapEndAudio - gapStartAudio);
          const gapVisualStart = prevSegment.bottom;
          const gapVisualEnd = nextSegment.top;
          targetPxRelativeToContainer = gapVisualStart + (gapProgress * (gapVisualEnd - gapVisualStart));
       } else if (prevSegment && !nextSegment) {
          targetPxRelativeToContainer = prevSegment.bottom;
       } else if (!prevSegment && nextSegment) {
          targetPxRelativeToContainer = nextSegment.top;
       }
    }
    
    return rect.top + targetPxRelativeToContainer;
  }, [calibrationOffset, segments]);

  // --- AUDIO SYNC SCROLLING ---
  useEffect(() => {
    const contentElement = contentRef?.current;
    const scrollElement = scrollContainerRef?.current;

    if (isPlaying && contentElement && scrollElement) {
      const sweetSpotY = window.innerHeight * Y_PERCENTAGE;
      const rect = contentElement.getBoundingClientRect();
      const targetPointOnScreen = getCalibratedY(progress, rect);
      
      if (Math.abs(targetPointOnScreen - sweetSpotY) > 2) {
         const delta = targetPointOnScreen - sweetSpotY;
         scrollElement.scrollBy({ top: delta, behavior: 'auto' }); 
         scrollAccumulatorRef.current = scrollElement.scrollTop;
      }
    } 
  }, [contentRef, getCalibratedY, isPlaying, progress, scrollContainerRef]);

  // --- TELEPROMPTER MODE (Fixed Physics) ---
  useEffect(() => {
    const scrollElement = scrollContainerRef?.current;

    // Implicit: If Ruler is rendered and Audio is NOT playing, we auto-scroll.
    if (!isPlaying && scrollElement && teleprompterSpeed && teleprompterSpeed > 0) {
       let lastTime = performance.now();
       
       scrollAccumulatorRef.current = scrollElement.scrollTop;

       const animate = (time: number) => {
         const delta = time - lastTime;
         
         if (delta >= 16) { 
            // RECALIBRATED SPEED:
            // Previous was 0.5 * speed. Too fast.
            // New base: 0.05. This means at 1x, it moves very slowly (reading speed).
            const BASE_SPEED_MULTIPLIER = 0.08; 
            const speedPxPerFrame = (BASE_SPEED_MULTIPLIER * teleprompterSpeed) * (delta / 16);
            
            scrollAccumulatorRef.current += speedPxPerFrame;
            
            scrollElement.scrollTop = scrollAccumulatorRef.current;

            lastTime = time;
         }
         teleprompterRef.current = requestAnimationFrame(animate);
       };
       
       teleprompterRef.current = requestAnimationFrame(animate);
       return () => cancelAnimationFrame(teleprompterRef.current);
    }
  }, [isPlaying, scrollContainerRef, teleprompterSpeed]); 


  const clearHeight = 60; 
  const half = clearHeight / 2;
  const fade = 250; 
  
  // Smooth opacity transition logic
  // If hovered, we drop to 0.1 (almost transparent). 
  // If not hovered, we stay at 0.75 (standard dim).
  // The transition is handled by CSS class on the div.
  const currentOpacity = isHeaderHovered ? 0.1 : 0.75; 

  return (
    <>
      {/* Ruler Shade Container - Using CSS transition for smoothness */}
      <div 
        className="fixed inset-0 pointer-events-none z-[30] hidden md:block transition-opacity duration-700 ease-in-out"
        style={{ opacity: currentOpacity }}
      >
          <div 
            className="w-full h-full"
            style={{
            background: `linear-gradient(
                to bottom, 
                rgba(0, 0, 0, 1) 0%,
                rgba(0, 0, 0, 1) ${Math.max(0, y - half - fade)}px,
                rgba(0, 0, 0, 0.95) ${Math.max(0, y - half - fade * 0.7)}px,
                rgba(0, 0, 0, 0.8) ${Math.max(0, y - half - fade * 0.5)}px,
                rgba(0, 0, 0, 0.5) ${Math.max(0, y - half - fade * 0.3)}px,
                rgba(0, 0, 0, 0.2) ${Math.max(0, y - half - fade * 0.15)}px,
                rgba(0, 0, 0, 0) ${Math.max(0, y - half)}px, 
                
                rgba(0, 0, 0, 0) ${Math.min(window.innerHeight, y + half)}px, 
                rgba(0, 0, 0, 0.2) ${Math.min(window.innerHeight, y + half + fade * 0.15)}px,
                rgba(0, 0, 0, 0.5) ${Math.min(window.innerHeight, y + half + fade * 0.3)}px,
                rgba(0, 0, 0, 0.8) ${Math.min(window.innerHeight, y + half + fade * 0.5)}px,
                rgba(0, 0, 0, 0.95) ${Math.min(window.innerHeight, y + half + fade * 0.7)}px,
                rgba(0, 0, 0, 1) ${Math.min(window.innerHeight, y + half + fade)}px,
                rgba(0, 0, 0, 1) 100%
            )`
            }}
          />
          <div
            className="absolute left-0 right-0"
            style={{ top: y - half, height: clearHeight }}
          >
            <div
              className="mx-auto h-full rounded-full"
              style={{
                width: 'min(70vw, 920px)',
                background: `linear-gradient(
                  to right,
                  rgba(255, 255, 255, 0) 0%,
                  rgba(255, 255, 255, 0.05) 12%,
                  rgba(255, 255, 255, 0.14) 28%,
                  rgba(255, 255, 255, 0.24) 50%,
                  rgba(255, 255, 255, 0.14) 72%,
                  rgba(255, 255, 255, 0.05) 88%,
                  rgba(255, 255, 255, 0) 100%
                )`,
                boxShadow: '0 0 48px rgba(255, 255, 255, 0.08)',
              }}
            />
          </div>
      </div>
      
      {/* Calibration Hint Cursor/Marker */}
      <div 
           className="fixed right-10 z-[31] pointer-events-none transition-all duration-300"
           style={{ top: y, transform: 'translateY(-50%)' }}
        >
            <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]' : 'bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]'} animate-pulse`}></div>
                <span className={`text-[10px] font-mono opacity-60 ${isPlaying ? 'text-red-400' : 'text-blue-400'}`}>
                  {isPlaying ? 'AUDIO SYNC' : 'AUTOSCROLL'}
                </span>
            </div>
      </div>
    </>
  );
};

export default memo(ReadingRuler);
