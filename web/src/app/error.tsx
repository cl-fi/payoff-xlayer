'use client';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="empty-state">
      <h1>Unable to load this page</h1>
      <p>Please try again. Your wallet assets are unaffected.</p>
      <button className="button primary" onClick={reset}>
        Retry
      </button>
    </div>
  );
}
