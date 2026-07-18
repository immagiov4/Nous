import { lazy, Suspense } from 'react';
import AuthGate from './components/auth/AuthGate.tsx';

const AdminPanel = lazy(() => import('./components/admin/AdminPanel.tsx'));
const YouTubeResearchLab = lazy(() => import('./components/admin/YouTubeResearchLab.tsx'));
const AppContent = lazy(() => import('./app/AppContent.tsx'));

const renderCurrentPage = () => {
  const pathname =
    typeof window === 'undefined' ? '/' : window.location.pathname.replace(/\/+$/, '') || '/';

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
    <Suspense fallback={null}>{renderCurrentPage()}</Suspense>
  </AuthGate>
);

export default App;
