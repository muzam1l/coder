'use client';

import { useEffect, useState } from 'preact/hooks';

import type { IntegrationInfo } from '@coder/client/types';
import type { CreateStep } from '@coder/integrations/types';
import { client } from '@/utils/client';
import { toastFailure } from '@/utils/action';
import { Loading } from '@/comps/ui/card';
import { Button } from '@/comps/ui/button';
import {
  CreateDialog,
  createForm,
} from '@/app/dash/[org]/agents/[slug]/(tabs)/platforms/platform-actions';

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
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState<CreateStep>();
  const start = () => client.apps.start(integration, state);

  useEffect(() => {
    void createForm(info?.create, state, start)
      .then(setStep)
      .catch(reason => {
        setFailed(true);
        toastFailure(reason);
      });
  }, []);

  if (failed) return null;
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
    <Button onClick={() => setOpen(true)}>{step.submit}</Button>
  );
}
