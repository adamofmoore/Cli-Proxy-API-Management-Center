import { useEffect, useState, type ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { toRestoreFailureHandoff, type RestoreFailureHandoff } from '@/features/auth/restoreRetry';

type RestoreResult = { failure: RestoreFailureHandoff | null };

export function ProtectedRoute({ children }: { children: ReactElement }) {
  const location = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const restoreSession = useAuthStore((state) => state.restoreSession);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);

  // Restore in place, so a reload keeps its URL; only a failed restore goes to the login page.
  useEffect(() => {
    if (isAuthenticated) return;
    let active = true;
    restoreSession().then((outcome) => {
      if (active && outcome.status !== 'restored') {
        setRestoreResult({ failure: toRestoreFailureHandoff(outcome) });
      }
    });
    return () => {
      active = false;
    };
  }, [isAuthenticated, restoreSession]);

  if (isAuthenticated) {
    return children;
  }

  if (!restoreResult) {
    return (
      <div className="main-content">
        <LoadingSpinner />
      </div>
    );
  }

  // The login page reports this failure and retries it on its own schedule, rather than
  // sending the same key again at once.
  return (
    <Navigate
      to="/login"
      replace
      state={{ from: location, restoreFailure: restoreResult.failure }}
    />
  );
}
