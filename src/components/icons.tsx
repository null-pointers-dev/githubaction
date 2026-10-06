export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <rect width="28" height="28" rx="7" fill="#1E6A62" />
      <path d="M5 18h6c3 0 3-8 6-8h6" fill="none" stroke="#CFE3DF" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="6" cy="18" r="2.6" fill="#F2F8F6" />
      <circle cx="14" cy="14" r="2.6" fill="#F2F8F6" />
      <circle cx="22" cy="10" r="2.6" fill="#D8901F" />
    </svg>
  );
}

export function Shield({ size = 12, filled = true }: { size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <path
        d="M9 2.5l6 2.2v4.1c0 3.4-2.5 5.9-6 6.7-3.5-.8-6-3.3-6-6.7V4.7z"
        fill={filled ? "currentColor" : "none"}
        stroke={filled ? "none" : "currentColor"}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Diamond({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      <rect x="3" y="3" width="6" height="6" transform="rotate(45 6 6)" fill="currentColor" />
    </svg>
  );
}

export function Check({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const NavIcons = {
  workflows: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M3 4h12M3 9h12M3 14h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  runs: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M2 12h4c2 0 2-6 4-6h6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="3" cy="12" r="1.8" fill="currentColor" />
      <circle cx="15" cy="6" r="1.8" fill="currentColor" />
    </svg>
  ),
  approvals: <Shield size={18} filled={false} />,
  settings: (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M2 10h3l2-5 4 9 2-4h3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};
