import type { ComponentProps } from 'react';

const THUMB_SIZE_PX = 40;
const getThumbCenterOffset = (progressPercent: number): number =>
  THUMB_SIZE_PX * (0.5 - progressPercent / 100);

interface MarkedSliderProps
  extends Pick<
    ComponentProps<'input'>,
    | 'id'
    | 'aria-label'
    | 'aria-labelledby'
    | 'aria-describedby'
    | 'aria-valuetext'
    | 'title'
    | 'onChange'
    | 'onKeyDown'
    | 'disabled'
  > {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly markerCount: number;
}

/** Native range input with the shared audio/course track and thumb geometry. */
export function MarkedSlider({
  min,
  max,
  step,
  value,
  markerCount,
  disabled,
  ...inputProps
}: MarkedSliderProps) {
  const stepIndex = Math.round((value - min) / step);
  const stepCount = Math.round((max - min) / step);
  const progressPercent = (stepIndex / stepCount) * 100;
  const fillOffset = getThumbCenterOffset(progressPercent);
  return (
    <div className={`relative h-9 w-full ${disabled ? 'opacity-50' : ''}`}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-full bg-gray-200 dark:bg-zinc-700"
      >
        <span
          data-slider-fill
          className="absolute inset-y-0 left-0 rounded-full bg-orange-500 dark:bg-orange-400"
          style={{ width: `calc(${progressPercent}% + ${fillOffset}px)` }}
        />
        {Array.from({ length: markerCount }, (_, index) => {
          const markerProgress = index / (markerCount - 1);
          const markerProgressPercent = markerProgress * 100;
          const markerOffset = getThumbCenterOffset(markerProgressPercent);
          return (
            <span
              key={markerProgress}
              data-slider-marker={markerProgress}
              className={`absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                markerProgressPercent <= progressPercent
                  ? 'bg-orange-200 dark:bg-orange-100/80'
                  : 'bg-gray-400 dark:bg-zinc-500'
              }`}
              style={{ left: `calc(${markerProgressPercent}% + ${markerOffset}px)` }}
            />
          );
        })}
      </div>

      <input
        type="range"
        tabIndex={disabled ? -1 : 0}
        {...inputProps}
        aria-orientation="horizontal"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        className="absolute inset-0 z-10 m-0 h-9 w-full cursor-pointer touch-pan-y appearance-none bg-transparent disabled:cursor-not-allowed [&::-moz-range-thumb]:box-border [&::-moz-range-thumb]:h-10 [&::-moz-range-thumb]:w-10 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-gray-200 [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:shadow-md [&::-moz-range-track]:h-9 [&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:h-9 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:-mt-0.5 [&::-webkit-slider-thumb]:h-10 [&::-webkit-slider-thumb]:w-10 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-gray-200 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md motion-safe:[&::-moz-range-thumb]:delay-100 motion-safe:[&::-moz-range-thumb]:duration-300 motion-safe:[&::-moz-range-thumb]:ease-[cubic-bezier(0.22,1,0.36,1)] motion-safe:[&::-moz-range-thumb]:transition-transform motion-safe:[&::-moz-range-thumb:hover]:delay-0 motion-safe:[&::-moz-range-thumb:hover]:scale-110 motion-safe:[&::-webkit-slider-thumb]:delay-100 motion-safe:[&::-webkit-slider-thumb]:duration-300 motion-safe:[&::-webkit-slider-thumb]:ease-[cubic-bezier(0.22,1,0.36,1)] motion-safe:[&::-webkit-slider-thumb]:transition-transform motion-safe:[&::-webkit-slider-thumb:hover]:delay-0 motion-safe:[&::-webkit-slider-thumb:hover]:scale-110 dark:[&::-moz-range-thumb]:border-zinc-600 dark:[&::-moz-range-thumb]:bg-zinc-100 dark:[&::-webkit-slider-thumb]:border-zinc-600 dark:[&::-webkit-slider-thumb]:bg-zinc-100"
      />
    </div>
  );
}
