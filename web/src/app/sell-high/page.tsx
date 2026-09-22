import type { Metadata } from 'next';
import { ProductPage } from '@/components/product-page';

export const metadata: Metadata = { title: 'Sell High' };

export default function SellHigh() {
  return <ProductPage initialSide={1} />;
}
