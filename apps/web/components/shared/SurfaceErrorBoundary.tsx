import { Component, type ErrorInfo, type ReactNode } from 'react';
import { SURFACE_ERROR_MESSAGES, translateUiMessage as t } from '../../i18n/uiMessages.ts';

type SurfaceKind = 'chat' | 'reader' | 'shell' | 'visual';

interface SurfaceErrorBoundaryProps {
  readonly children: ReactNode;
  readonly resetKey?: string | null;
  readonly surface: SurfaceKind;
}

interface SurfaceErrorBoundaryState {
  readonly hasError: boolean;
}

export default class SurfaceErrorBoundary extends Component<
  SurfaceErrorBoundaryProps,
  SurfaceErrorBoundaryState
> {
  state: SurfaceErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): SurfaceErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`[Nous][SurfaceError] ${this.props.surface}`, error, errorInfo);
  }

  componentDidUpdate(previousProps: SurfaceErrorBoundaryProps): void {
    if (this.state.hasError && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
        role="alert"
      >
        {t(SURFACE_ERROR_MESSAGES[this.props.surface])}
      </div>
    );
  }
}
