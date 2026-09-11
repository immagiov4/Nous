import { lazy, Suspense } from 'react';
import { AccountSetupGate } from './components/account/setup/AccountSetupPage.tsx';
import AuthGate from './components/auth/AuthGate.tsx';
import SurfaceErrorBoundary from './components/shared/SurfaceErrorBoundary.tsx';
import { useAccountLocale } from './hooks/useAccountLocale.ts';
import { ACCOUNT_SETUP_DEMO_PATH } from './services/preferences/accountSetup.ts';
import { normalizePathname } from './utils/pathname.ts';

const AccountSetupDemo = lazy(() => import('./components/account/setup/AccountSetupDemo.tsx'));
const DiagnosticDemo = lazy(() => import('./components/library/diagnostic/DiagnosticDemo.tsx'));

const AdminPanel = lazy(() => import('./components/admin/AdminPanel.tsx'));
const YouTubeResearchLab = lazy(() => import('./components/admin/YouTubeResearchLab.tsx'));
const AppContent = lazy(() => import('./app/AppContent.tsx'));

const renderCurrentPage = () => {
  const pathname =
    typeof globalThis.window === 'undefined'
      ? '/'
      : normalizePathname(globalThis.location.pathname);

  if (pathname === '/admin/youtube-lab') {
    return <YouTubeResearchLab />;
  }
  if (pathname === '/admin') {
    return <AdminPanel />;
  }
  return <AppContent />;
};

const AuthenticatedApp = () => {
  useAccountLocale();
  return (
    <AuthGate>
      <SurfaceErrorBoundary surface="shell">
        <AccountSetupGate>
          <Suspense fallback={null}>{renderCurrentPage()}</Suspense>
        </AccountSetupGate>
      </SurfaceErrorBoundary>
    </AuthGate>
  );
};

const App = () => {
  if (
    import.meta.env.DEV &&
    normalizePathname(globalThis.location.pathname) === '/dev/diagnostic'
  ) {
    return (
      <Suspense fallback={null}>
        <DiagnosticDemo />
      </Suspense>
    );
  }
  return import.meta.env.DEV &&
    normalizePathname(globalThis.location.pathname) === ACCOUNT_SETUP_DEMO_PATH ? (
    <Suspense fallback={null}>
      <AccountSetupDemo />
    </Suspense>
  ) : (
    <AuthenticatedApp />
  );
};

export default App;
