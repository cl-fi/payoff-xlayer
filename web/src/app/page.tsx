import type { Metadata } from 'next';
import { ProductPage } from '@/components/product-page';

export const metadata: Metadata = { title: 'Dual Investment' };

export default function Home() {
  return <ProductPage />;
}
