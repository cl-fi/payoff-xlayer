import type { Metadata } from 'next';
import { IBM_Plex_Mono, Inter } from 'next/font/google';
import { AppProvider } from '@/components/provider';
import { Shell } from '@/components/shell';
import './globals.css';
const sans = Inter({ subsets: ['latin'], variable: '--font-sans' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono' });
export const metadata: Metadata = {
  title: { default: 'Payoff — Your price. Your payoff.', template: '%s · Payoff' },
  description:
    'Explore Buy Low and Sell High strategies for tokenized stocks, with fixed wrapped-token settlement terms.',
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <AppProvider>
          <Shell>{children}</Shell>
        </AppProvider>
      </body>
    </html>
  );
}
