/**
 * Loadout mark: a panel with HUD corner brackets; "loaded" (●, as in the matrix) on the left, "off" (○) on the right,
 * with the pink slash from the LOAD/OUT name between them. Source: `build/icon.svg` (the exe icon is made from it too).
 */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg className="mark" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="60" height="60" rx="10" fill="#21222c" stroke="#44475a" strokeWidth="2" />
      <path
        d="M10 22V13a3 3 0 0 1 3-3h9M42 10h9a3 3 0 0 1 3 3v9M54 42v9a3 3 0 0 1-3 3h-9M22 54h-9a3 3 0 0 1-3-3v-9"
        fill="none"
        stroke="#8be9fd"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {[22, 32, 42].map((y) => (
        <circle key={`a${y}`} cx="20" cy={y} r="3.6" fill="#50fa7b" />
      ))}
      {[22, 32, 42].map((y) => (
        <circle key={`b${y}`} cx="44" cy={y} r="3" fill="none" stroke="#6272a4" strokeWidth="2" />
      ))}
      <path d="M28 46 36 18" stroke="#ff79c6" strokeWidth="4" strokeLinecap="round" />
    </svg>
  )
}
