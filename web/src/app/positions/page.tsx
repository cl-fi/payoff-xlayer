import type { Metadata } from 'next';
import { PositionsPage } from '@/components/positions-page';
export const metadata: Metadata = { title: 'Portfolio' };
export default function Positions() {
  return <PositionsPage />;
}
