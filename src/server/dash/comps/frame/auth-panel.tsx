import './auth-panel.css';
import type { ComponentChildren } from 'preact';

import { Mark } from '@/comps/ui/icon';

/** The one centered panel every server page outside the dashboard uses. */
export function AuthPanel({
  tag,
  title,
  lead,
  children,
}: {
  tag: string;
  title: string;
  lead?: ComponentChildren;
  children?: ComponentChildren;
}) {
  return (
    <section class="auth">
      <div class="auth-side">
        <div class="auth-frame frame">
          <div class="bar">
            <a class="brand" href="/">
              <Mark />
              <span class="lockup">
                coder <small>wular</small>
              </span>
            </a>
            <span class="tag">{tag}</span>
          </div>
          <div class="auth-body">
            <h1>{title}</h1>
            {lead ? <p class="lead">{lead}</p> : null}
            {children}
          </div>
        </div>
        <nav class="auth-links">
          <a href="https://wular.ai">wular.ai</a>
          <a href="https://coder.wular.ai">hosted service</a>
        </nav>
      </div>
    </section>
  );
}
