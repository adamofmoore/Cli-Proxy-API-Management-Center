import { useEffect, useState, type ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

export function ProtectedRoute({ children }: { children: ReactElement }) {
  const location = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const restoreSession = useAuthStore((state) => state.restoreSession);
  const [restoreFailed, setRestoreFailed] = useState(false);

  // Restore in place, so a reload keeps its URL; only a failed restore goes to the login page.
  useEffect(() => {
    if (isAuthenticated) return;
    let active = true;
    restoreSession().then((outcome) => {
      if (active && outcome.status !== 'restored') setRestoreFailed(true);
    });
    return () => {
      active = false;
    };
  }, [isAuthenticated, restoreSession]);

  if (isAuthenticated) {
    return children;
  }

  if (!restoreFailed) {
    return (
      <div className="main-content">
        <LoadingSpinner />
      </div>
    );
  }

  return <Navigate to="/login" replace state={{ from: location }} />;
}
