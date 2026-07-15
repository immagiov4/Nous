import { lazy, Suspense } from 'react';
import AuthGate from './components/auth/AuthGate.tsx';

const AdminPanel = lazy(() => import('./components/admin/AdminPanel.tsx'));
const AppContent = lazy(() => import('./app/AppContent.tsx'));

const App = () => (
  <AuthGate>
    <Suspense fallback={null}>
      {typeof window !== 'undefined' && window.location.pathname === '/admin' ? (
        <AdminPanel />
      ) : (
        <AppContent />
      )}
    </Suspense>
  </AuthGate>
);

export default App;
