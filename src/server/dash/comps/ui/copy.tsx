'use client';

import './copy.css';

import { useState } from 'preact/hooks';

import { iCheck, iCopy } from '@/comps/ui/icons';
import { IconButton } from '@/comps/ui/button';

/** An icon button that copies `value` and shows a check once it did. */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      icon={copied ? iCheck : iCopy}
      label={copied ? 'Copied' : label}
      class={copied ? 'copied' : undefined}
      onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
    />
  );
}

/** One value to copy, such as a command or an address; `link` also opens it in a new tab. */
export function CopyLine({
  value,
  label = 'Copy command',
  link,
}: {
  value: string;
  label?: string;
  link?: boolean;
}) {
  return (
    <div class="copy-line">
      {link ? (
        <a href={value} target="_blank" rel="noreferrer">
          <code>{value}</code>
        </a>
      ) : (
        <code>{value}</code>
      )}
      <CopyButton value={value} label={label} />
    </div>
  );
}
