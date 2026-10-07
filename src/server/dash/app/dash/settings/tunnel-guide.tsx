import { Card } from '@/comps/ui/card';

/** How a server on this machine receives platform events: a public tunnel to its port, then PUBLIC_URL. */
export function TunnelGuide({ port }: { port: string }) {
  return (
    <Card title="Receive platform events">
      <div class="guide">
        <p>
          Platforms reach this server through a public address. Expose port {port} with one of
          these.
        </p>
        <ul class="steps-list">
          <li>
            <code>ngrok http {port}</code>
          </li>
          <li>
            <code>cloudflared tunnel --url http://localhost:{port}</code>
          </li>
          <li>VS Code's Ports panel, with the port's visibility set to Public</li>
        </ul>
        <p>
          Then restart with <code>PUBLIC_URL=&lt;tunnel URL&gt; coder server serve</code>. The
          tunnel serves only webhooks and app setup, never this dashboard.
        </p>
      </div>
    </Card>
  );
}
