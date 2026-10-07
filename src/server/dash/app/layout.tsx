import type { ComponentChildren } from 'preact';
import type { NextRequest } from '@wular/pnext/server';

import './globals.css';
import './responsive.css';
import { Zone } from './zone';

export const metadata = {
  title: 'Coder',
  icons: {
    icon: [
      { url: '/assets/favicon.ico', sizes: '16x16 32x32' },
      { url: '/assets/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: '/assets/apple-touch-icon.png',
  },
};

// Fonts arrive with the stylesheet, so text never repaints in another face.
const FONTS = [
  'fira-code-latin-400-normal-717ee080',
  'fira-code-latin-500-normal-530b6706',
  'fira-code-latin-700-normal-98730669',
];

export default function RootLayout({
  request,
  children,
}: {
  request?: NextRequest;
  children: ComponentChildren;
}) {
  const theme = request?.cookies.get('theme')?.value;
  return (
    <html lang="en" data-theme={theme === 'light' || theme === 'dark' ? theme : undefined}>
      <body>
        {FONTS.map(name => (
          <link
            key={name}
            rel="preload"
            href={`/assets/fonts/${name}.woff2`}
            as="font"
            type="font/woff2"
            crossOrigin="anonymous"
          />
        ))}
        <Zone />
        {children}
      </body>
    </html>
  );
}
