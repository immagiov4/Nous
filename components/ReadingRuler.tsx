import React, { useEffect, useState, useRef } from 'react';

interface ReadingRulerProps {
  isPlaying?: boolean;
  progress?: number; // 0 to 1
  contentRef?: React.RefObject<HTMLDivElement>;
  scrollContainerRef?: React.RefObject<HTMLDivElement>; 
  calibrationOffset: number; 
  teleprompterSpeed?: number;
  isHeaderHovered: boolean; 
}

interface TextSegment {
  startAudio: number;
  endAudio: number;
  top: number;
  bottom: number;
}

const ReadingRuler: React.FC<ReadingRulerProps> = ({ 
  isPlaying, 
  progress = 0, 
  contentRef,
  scrollContainerRef, 
  calibrationOffset,
  teleprompterSpeed = 1,
  isHeaderHovered
}) => {
  const Y_PERCENTAGE = 0.45;
  const [y, setY] = useState(window.innerHeight * Y_PERCENTAGE); 
  const [segments, setSegments] = useState<TextSegment[]>([]);
  const teleprompterRef = useRef<number>(0);
  
  // Float accumulator for smooth sub-pixel scrolling
  const scrollAccumulatorRef = useRef<number>(0);

  // UPDATED: Heavily weighted to simulate human reading pauses
  const getReadingWeight = (text: string): number => {
    const baseLength = text.length;
    const periods = (text.match(/[.!?]/g) || []).length;
    const commas = (text.match(/[,;:]/g) || []).length;
    return baseLength + (periods * 60) + (commas * 20);
  };

  const BLOCK_PAUSE_WEIGHT = 200; 

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

  useEffect(() => {
    if (!contentRef?.current) return;
    
    const calculateSegments = () => {
       const container = contentRef.current;
       if (!container) return;
       const containerRect = container.getBoundingClientRect();

       const proseContainer = container.querySelector('.prose') || container;
       const textElements = proseContainer.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote');
       
       let totalWeight = 0;
       
       textElements.forEach(el => {
          totalWeight += getReadingWeight((el as HTMLElement).innerText) + BLOCK_PAUSE_WEIGHT;
       });

       if (totalWeight === 0) return;

       const newSegments: TextSegment[] = [];
       let weightSoFar = 0;
       
       textElements.forEach(el => {
         const element = el as HTMLElement;
         const text = element.innerText;
         const weight = getReadingWeight(text);
         
         if (weight === 0) return;

         const startPct = weightSoFar / totalWeight;
         const endPct = (weightSoFar + weight) / totalWeight;
         
         const elRect = element.getBoundingClientRect();
         const elTop = elRect.top - containerRect.top;
         const elHeight = elRect.height;

         newSegments.push({
            startAudio: startPct,
            endAudio: endPct,
            top: elTop,
            bottom: elTop + elHeight
         });

         weightSoFar += (weight + BLOCK_PAUSE_WEIGHT);
       });
       
       setSegments(newSegments);
    };

    calculateSegments();
    window.addEventListener('resize', calculateSegments);
    return () => window.removeEventListener('resize', calculateSegments);

  }, [contentRef?.current?.innerHTML]);


  const getCalibratedY = (rawProgress: number, rect: DOMRect): number => {
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
  };

  // --- AUDIO SYNC SCROLLING ---
  useEffect(() => {
    if (isPlaying && contentRef?.current && scrollContainerRef?.current) {
      const sweetSpotY = window.innerHeight * Y_PERCENTAGE;
      const rect = contentRef.current.getBoundingClientRect();
      const targetPointOnScreen = getCalibratedY(progress, rect);
      
      if (Math.abs(targetPointOnScreen - sweetSpotY) > 2) {
         const delta = targetPointOnScreen - sweetSpotY;
         scrollContainerRef.current.scrollBy({ top: delta, behavior: 'auto' }); 
         scrollAccumulatorRef.current = scrollContainerRef.current.scrollTop;
      }
    } 
  }, [isPlaying, progress, contentRef, scrollContainerRef, segments, calibrationOffset]);

  // --- TELEPROMPTER MODE (Fixed Physics) ---
  useEffect(() => {
    // Implicit: If Ruler is rendered and Audio is NOT playing, we auto-scroll.
    if (!isPlaying && scrollContainerRef?.current && teleprompterSpeed && teleprompterSpeed > 0) {
       let lastTime = performance.now();
       
       scrollAccumulatorRef.current = scrollContainerRef.current.scrollTop;

       const animate = (time: number) => {
         const delta = time - lastTime;
         
         if (delta >= 16) { 
            // RECALIBRATED SPEED:
            // Previous was 0.5 * speed. Too fast.
            // New base: 0.05. This means at 1x, it moves very slowly (reading speed).
            const BASE_SPEED_MULTIPLIER = 0.08; 
            const speedPxPerFrame = (BASE_SPEED_MULTIPLIER * teleprompterSpeed) * (delta / 16);
            
            scrollAccumulatorRef.current += speedPxPerFrame;
            
            if (scrollContainerRef.current) {
                scrollContainerRef.current.scrollTop = scrollAccumulatorRef.current;
            }

            lastTime = time;
         }
         teleprompterRef.current = requestAnimationFrame(animate);
       };
       
       teleprompterRef.current = requestAnimationFrame(animate);
       return () => cancelAnimationFrame(teleprompterRef.current);
    }
  }, [isPlaying, teleprompterSpeed]); 


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
          {/* Inner Gradient Div - Static Gradient, Opacity controlled by parent */}
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

export default ReadingRuler;