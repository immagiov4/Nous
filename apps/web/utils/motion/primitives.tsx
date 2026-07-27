import { AnimatePresence, type HTMLMotionProps, motion, type Transition } from 'framer-motion';
import {
  type CSSProperties,
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { SPRING_TAP, TAP_SCALE, VARIANTS_BACKDROP, VARIANTS_DIALOG } from './tokens.ts';
import { useShouldAnimate } from './useShouldAnimate.ts';

interface MotionDialogProps {
  children: ReactNode;
  containerClassName?: string;
  contentClassName?: string;
  isOpen: boolean;
  onRequestClose?: () => void;
  /** z-index layer for the backdrop container. Defaults to 60 (matches existing dialog stacking). */
  zIndexClassName?: string;
}

/**
 * Accessible modal shell with a fading backdrop and a pop-in content panel.
 *
 * The caller keeps full control of the inner styling (border, rounding,
 * padding). This component only owns the overlay, the entrance/exit motion,
 * and the backdrop dismiss behavior.
 */
export const MotionDialog = ({
  children,
  containerClassName,
  contentClassName,
  isOpen,
  onRequestClose,
  zIndexClassName = 'z-[100]',
}: MotionDialogProps) => {
  const shouldAnimate = useShouldAnimate();
  const portalContainer = typeof document === 'undefined' ? null : document.body;

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onRequestClose?.();
    }
  };

  const handleBackdropKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      onRequestClose?.();
    }
  };

  return (
    <AnimatePresence>
      {isOpen && portalContainer
        ? createPortal(
            <motion.div
              className={`fixed inset-0 ${zIndexClassName} flex items-center justify-center bg-black/50 px-4 py-6 backdrop-blur-sm ${containerClassName || ''}`}
              initial={shouldAnimate ? 'hidden' : false}
              animate="visible"
              exit="exit"
              variants={VARIANTS_BACKDROP}
              onClick={handleBackdropClick}
              onKeyDown={handleBackdropKey}
              role={onRequestClose ? 'presentation' : undefined}
            >
              <motion.div
                className={contentClassName}
                initial={shouldAnimate ? 'hidden' : false}
                animate="visible"
                exit="exit"
                variants={VARIANTS_DIALOG}
              >
                {children}
              </motion.div>
            </motion.div>,
            portalContainer
          )
        : null}
    </AnimatePresence>
  );
};

interface MotionPopoverProps extends Omit<HTMLMotionProps<'div'>, 'children'> {
  children: ReactNode;
  /** `transform-origin` for the pop-in morph. Ex: `'top right'`, `'10px 20px'`. */
  originX?: CSSProperties['transformOrigin'];
  isOpen: boolean;
}

/**
 * Generic popover shell for small contextual menus and dropdowns.
 *
 * Renders nothing when closed. When opened the popover morphs in from the
 * provided `originX` with a subtle spring, matching the selection context
 * menu feel. No exit animation — dismiss is immediate.
 *
 * The caller positions this absolutely / fixed.
 */
export const MotionPopover = ({
  children,
  originX,
  isOpen,
  style,
  ...rest
}: MotionPopoverProps) => {
  const shouldAnimate = useShouldAnimate();

  if (!isOpen) {
    return null;
  }

  return (
    <motion.div
      {...rest}
      initial={shouldAnimate ? { opacity: 0, scale: 0.94 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={{
        opacity: { duration: 0.09, ease: [0.2, 0.85, 0.25, 1] },
        scale: { duration: 0.12, ease: [0.2, 0.85, 0.25, 1] },
      }}
      style={{
        transformOrigin: originX ?? 'top right',
        willChange: 'transform, opacity',
        ...style,
      }}
    >
      {children}
    </motion.div>
  );
};

interface PressableProps extends HTMLMotionProps<'button'> {
  /**
   * Disable the tap animation while keeping the button interactive.
   */
  quiet?: boolean;
}

/**
 * Button drop-in with a subtle tap-scale feedback only.
 * No hover lift — hover uses the existing CSS color/bg transitions.
 *
 * Respects `prefers-reduced-motion` automatically.
 */
export const Pressable = forwardRef<HTMLButtonElement, PressableProps>(
  ({ children, quiet = false, type = 'button', ...rest }, ref) => {
    const shouldAnimate = useShouldAnimate();
    const animationsActive = shouldAnimate && !quiet;

    return (
      <motion.button
        ref={ref}
        type={type}
        whileTap={animationsActive ? { scale: TAP_SCALE } : undefined}
        transition={SPRING_TAP as Transition}
        {...rest}
      >
        {children}
      </motion.button>
    );
  }
);

Pressable.displayName = 'Pressable';
