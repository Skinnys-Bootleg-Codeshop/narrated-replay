import type { ReactNode } from 'react';
import Link from 'next/link';
import 'narrated-replay/talk-button.css';
import { Talk } from './talk';

export const metadata = { title: 'Notes (narrated-replay example)' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui', margin: 24 }}>
        <nav style={{ display: 'flex', gap: 16 }}>
          <Link href="/" id="nav-home">Add note</Link>
          <Link href="/notes" id="nav-notes">All notes</Link>
        </nav>
        {children}
        <Talk />
      </body>
    </html>
  );
}
