import { lazy, Suspense } from 'react';
import AuthGate from './components/auth/AuthGate.tsx';
import SurfaceErrorBoundary from './components/shared/SurfaceErrorBoundary.tsx';

const AdminPanel = lazy(() => import('./components/admin/AdminPanel.tsx'));
const YouTubeResearchLab = lazy(() => import('./components/admin/YouTubeResearchLab.tsx'));
const AppContent = lazy(() => import('./app/AppContent.tsx'));

const renderCurrentPage = () => {
  const pathname =
    typeof globalThis.window === 'undefined'
      ? '/'
      : globalThis.location.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/admin/youtube-lab') {
    return <YouTubeResearchLab />;
  }
  if (pathname === '/admin') {
    return <AdminPanel />;
  }
  return <AppContent />;
};

const App = () => (
  <AuthGate>
    <SurfaceErrorBoundary surface="shell">
      <Suspense fallback={null}>{renderCurrentPage()}</Suspense>
    </SurfaceErrorBoundary>
  </AuthGate>
);

export default App;
