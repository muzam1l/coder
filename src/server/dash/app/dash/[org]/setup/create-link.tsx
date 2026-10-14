'use client';

import { useEffect, useState } from 'preact/hooks';

import type { IntegrationInfo } from '@coder/client/types';
import type { CreateStep } from '@coder/integrations/types';
import { client } from '@/utils/client';
import { reasonText } from '@/utils/format';
import { Loading } from '@/comps/ui/card';
import { ErrorText } from '@/comps/ui/field';
import { CreateDialog, createForm } from '@/app/dash/[org]/agents/[slug]/(tabs)/platforms/platform-actions';

/** A create link opened outside the Platforms tab: its form here, or the platform's own. */
export function CreateLink({
  integration,
  state,
  info,
}: {
  integration: string;
  state: Record<string, string>;
  info?: IntegrationInfo;
}) {
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState<CreateStep>();
  const start = () => client.apps.start(integration, state);

  useEffect(() => {
    void createForm(info?.create, state, start)
      .then(setStep)
      .catch(reason => setError(reasonText(reason)));
  }, []);

  if (error) return <ErrorText value={error} />;
  if (!step) return <Loading label={`Opening ${info?.name ?? integration}`} />;

  return open ? (
    <CreateDialog
      integration={integration}
      step={step}
      start={start}
      unreachable={info?.unreachable}
      onClose={() => setOpen(false)}
    />
  ) : (
    <button type="button" class="btn" onClick={() => setOpen(true)}>
      {step.submit}
    </button>
  );
}
