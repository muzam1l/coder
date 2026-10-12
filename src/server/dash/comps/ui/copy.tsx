'use client';

import './copy.css';

import { useState } from 'preact/hooks';

import { iCheck, iCopy } from '@/comps/ui/icons';
import { Icon } from '@/comps/ui/icon';

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
  const [copied, setCopied] = useState(false);
  return (
    <div class="copy-line">
      {link ? (
        <a href={value} target="_blank" rel="noreferrer">
          <code>{value}</code>
        </a>
      ) : (
        <code>{value}</code>
      )}
      <button
        type="button"
        class={copied ? 'icon-btn copied' : 'icon-btn'}
        aria-label={copied ? 'Copied' : label}
        title={copied ? 'Copied' : label}
        onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
      >
        <Icon d={copied ? iCheck : iCopy} />
      </button>
    </div>
  );
}
