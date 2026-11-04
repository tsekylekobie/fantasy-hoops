// The league's logo: a basketball. The ball takes the theme's accent; the seams
// stay dark in both themes. src/app/icon.svg is the same drawing as the favicon.
export default function LeagueLogo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <circle cx="16" cy="16" r="14" fill="var(--accent)" stroke="#431407" strokeWidth="2" />
      <path
        d="M16 2v28M2 16h28M6.1 6.1c4.6 4.6 4.6 15.2 0 19.8M25.9 6.1c-4.6 4.6-4.6 15.2 0 19.8"
        fill="none"
        stroke="#431407"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
