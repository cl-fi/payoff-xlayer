import type { Metadata } from 'next';
import { FaucetPage } from '@/components/faucet-page';
export const metadata: Metadata = { title: 'Get test tokens' };
export default function Faucet() {
  return <FaucetPage />;
}
