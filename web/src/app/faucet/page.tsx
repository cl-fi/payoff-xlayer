import type { Metadata } from 'next';
import { FaucetPage } from '@/components/faucet-page';
export const metadata: Metadata = { title: 'Get test USDG' };
export default function Faucet() {
  return <FaucetPage />;
}
