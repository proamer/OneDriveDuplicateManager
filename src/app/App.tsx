import { AuthProvider } from '../features/auth/AuthProvider';
import { AppRouter } from './router';

export function App() {
  return (
    <AuthProvider>
      <AppRouter />
    </AuthProvider>
  );
}
