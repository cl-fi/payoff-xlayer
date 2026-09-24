// Decorative token avatars. The NVIDIA eye is the trace shipped in public/nvidia.svg (TradingView's
// symbol-logo redraw of NVIDIA Corporation's trademark). Wrapped variants carry a small "w" corner badge.
// USDG uses the Global Dollar token logo shipped in public/usdg.svg (the issuer's partner asset).
const NVIDIA_EYE =
  'M12.087 26.332s3.692-4.799 10.913-5.3v-1.994C15.002 19.62 8 26 8 26s3.998 10.245 15 11.187V35.32c-8.073-.921-10.913-8.99-10.913-8.99zM23 31.61v1.709c-6.102-.986-7.871-6.738-7.871-6.738S18.134 23.477 23 23v2.035c.003 0-.004 0 0 0-2.554-.278-4.634 1.886-4.634 1.886S19.56 30.562 23 31.61zM23 16v3.038c.235-.017.394-.03.63-.038 9.093-.278 15.018 6.962 15.018 6.962s-6.805 7.503-13.894 7.503c-.65 0-1.183-.054-1.754-.146v2.002c.489.056.92.09 1.448.09 6.597 0 11.368-3.056 15.988-6.672.766.557 3.902 1.91 4.546 2.502-4.392 3.335-14.63 6.023-20.433 6.023-.56 0-1.02-.031-1.549-.077V40h25V16H23zm0 7v-1.967c.232-.015.391-.026.63-.033 6.539-.186 10.829 5.055 10.829 5.055S29.969 32 25 32c-.715 0-1.423-.214-2-.39v-6.575c2.546.28 2.982 1.3 4.513 3.613l3.403-2.602S28.19 23 24 23c-.455 0-.572-.041-1 0z';

export function TokenIcon({
  symbol,
  size = 24,
  className,
}: {
  symbol: string;
  size?: number;
  className?: string;
}) {
  const nvidia = symbol.endsWith('NVDAx');
  const wrapped = nvidia && /^t?w/.test(symbol);
  const classes = ['token-icon', className].filter(Boolean).join(' ');
  if (symbol.endsWith('USDG'))
    return <img src="/usdg.svg" width={size} height={size} alt="" className={classes} />;
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" aria-hidden="true" className={classes}>
      {nvidia ? (
        <>
          <circle cx="28" cy="28" r="28" fill="#111418" />
          <path d={NVIDIA_EYE} fill="#76b900" />
        </>
      ) : (
        <>
          <circle cx="28" cy="28" r="27" fill="var(--n-100)" stroke="var(--n-200)" strokeWidth="2" />
          <text
            x="28"
            y="37"
            textAnchor="middle"
            fontFamily="var(--mono)"
            fontSize="26"
            fontWeight="500"
            fill="var(--n-900)"
          >
            {symbol.replace(/^t(?=[A-Z])/, '').slice(0, 1)}
          </text>
        </>
      )}
      {wrapped && (
        <>
          <circle cx="44" cy="44" r="11" fill="var(--n-0)" stroke="var(--n-300)" strokeWidth="1.5" />
          <text
            x="44"
            y="48.5"
            textAnchor="middle"
            fontFamily="var(--mono)"
            fontSize="14"
            fontWeight="500"
            fill="var(--n-900)"
          >
            w
          </text>
        </>
      )}
    </svg>
  );
}
