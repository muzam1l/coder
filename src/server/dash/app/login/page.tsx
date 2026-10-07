import './page.css';
import { redirect } from '@wular/pnext/navigation';

import { ErrorText } from '@/comps/ui/field';
import { AuthPanel } from '@/comps/frame/auth-panel';
import { safeReturnPath } from '@coder/server/auth/sign-in';
import { load } from '@/api/load';

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
        <a class="btn outline provider" href={signIn}>
          {WULAR_LOGO}
          <span>Sign in with Wular Auth</span>
        </a>
      </div>
      <ErrorText value={error ? (ERRORS[error] ?? 'Sign-in did not finish. Try again.') : ''} />
    </AuthPanel>
  );
}

export default async function Page({ request }: { request?: Request }) {
  if (!request) return null;
  const url = new URL(request.url);
  const { wular } = await load(request).info();
  // A memory server keeps no accounts: its dashboard asks for the admin token.
  if (!wular) redirect('/dash');
  return (
    <LoginPage
      signIn={`/api/auth/sign-in?return=${encodeURIComponent(safeReturnPath(url.searchParams.get('return'), url.origin))}`}
      error={url.searchParams.get('error')}
    />
  );
}
