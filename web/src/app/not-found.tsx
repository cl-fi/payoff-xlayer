import Link from 'next/link';
export default function NotFound() {
  return (
    <div className="empty-state">
      <span className="eyebrow">404</span>
      <h1>This page does not exist</h1>
      <Link className="button primary" href="/">
        Back to products
      </Link>
    </div>
  );
}
