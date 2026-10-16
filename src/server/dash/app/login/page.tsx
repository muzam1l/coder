import './page.css';

import { AuthPanel } from '@/comps/frame/auth-panel';
import { Button } from '@/comps/ui/button';
import { safeReturnPath } from '@coder/server/auth/sign-in';

const WULAR_LOGO = (
  <svg class="logo" viewBox="6 12 52 36" aria-hidden="true">
    <path
      d="M8 14 18 46 26 26h12l8 20 10-32"
      fill="none"
      stroke="currentColor"
      stroke-width="5"
      stroke-linejoin="miter"
    />
  </svg>
);

const ERRORS: Record<string, string> = {
  expired: 'That sign-in took too long. Sign in again.',
  unavailable: 'Wular Auth could not be reached. Try again in a moment.',
  access_denied: 'Sign-in was cancelled.',
};

function LoginPage({ signIn, error }: { signIn: string; error?: string | null }) {
  return (
    <AuthPanel
      tag="sign in"
      title="Continue to Coder"
      lead="Coder signs you in with your Wular Auth account."
    >
      <div class="provider-grid">
        <Button variant="outline" class="provider" href={signIn}>
          {WULAR_LOGO}
          <span>Sign in with Wular Auth</span>
        </Button>
      </div>
      {error ? (
        <p class="flash err" role="alert">
          {ERRORS[error] ?? 'Sign-in did not finish. Try again.'}
        </p>
      ) : null}
    </AuthPanel>
  );
}

export default function Page({ request }: { request?: Request }) {
  if (!request) return null;
  const url = new URL(request.url);
  return (
    <LoginPage
      signIn={`/api/auth/sign-in?return=${encodeURIComponent(safeReturnPath(url.searchParams.get('return'), url.origin))}`}
      error={url.searchParams.get('error')}
    />
  );
}
