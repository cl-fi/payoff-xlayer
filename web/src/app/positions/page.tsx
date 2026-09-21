import type { Metadata } from 'next';
import { PositionsPage } from '@/components/positions-page';
export const metadata: Metadata = { title: 'My positions' };
export default function Positions() {
  return <PositionsPage />;
}
