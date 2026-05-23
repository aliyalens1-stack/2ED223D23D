import { useEffect, useState } from 'react';
import { Wrench, Lightning } from '@phosphor-icons/react';

/**
 * Hero matching radar — technological animation that visualises the platform
 * matching engine: masters orbit on rings, scan-line sweeps the area, when
 * scan-line crosses a master they pulse + a connection line draws to centre.
 */
type Master = { angle: number; radius: number; eta: number; rating: number; };

const MASTERS: Master[] = [
  { angle: 24,  radius: 38, eta: 4,  rating: 4.9 },
  { angle: 78,  radius: 62, eta: 8,  rating: 4.7 },
  { angle: 152, radius: 48, eta: 6,  rating: 4.8 },
  { angle: 208, radius: 80, eta: 11, rating: 4.6 },
  { angle: 256, radius: 32, eta: 3,  rating: 5.0 },
  { angle: 308, radius: 70, eta: 9,  rating: 4.5 },
  { angle: 340, radius: 54, eta: 7,  rating: 4.8 },
];

export default function HeroRadar() {
  const [scan, setScan] = useState(0);
  const [hits, setHits] = useState<number[]>([]);
  const [matchedIdx, setMatchedIdx] = useState<number | null>(null);

  // Drive the scanner angle (0..360) at 6s/rev — smooth, feels deliberate
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = t - last; last = t;
      setScan(prev => (prev + (dt / 6000) * 360) % 360);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Detect when scanner sweeps past a master — flash + remember as "hit"
  useEffect(() => {
    const next: number[] = [];
    MASTERS.forEach((m, i) => {
      const delta = ((scan - m.angle + 360) % 360);
      if (delta < 6) next.push(i);
    });
    if (next.length) setHits(prev => Array.from(new Set([...prev, ...next])).slice(-5));
  }, [scan]);

  // Pick a "matched" master every ~3.6s, animate connecting line
  useEffect(() => {
    let i = 0;
    const t = setInterval(() => {
      i = (i + 1) % MASTERS.length;
      setMatchedIdx(i);
    }, 3600);
    return () => clearInterval(t);
  }, []);

  // SVG coordinate space: 400×400 centred at (200,200). Radius scaled.
  const cx = 200, cy = 200;
  const polar = (r: number, a: number) => ({
    x: cx + (r / 100) * 170 * Math.cos((a - 90) * Math.PI / 180),
    y: cy + (r / 100) * 170 * Math.sin((a - 90) * Math.PI / 180),
  });
  const matched = matchedIdx !== null ? MASTERS[matchedIdx] : null;
  const matchedPos = matched ? polar(matched.radius, matched.angle) : null;
  const scanEnd = polar(95, scan);

  return (
    <div className="relative w-full aspect-square max-w-[480px] mx-auto select-none">
      {/* Soft amber glow background */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: 'radial-gradient(circle at center, rgba(255,184,0,0.15) 0%, rgba(255,184,0,0.04) 40%, transparent 70%)',
        }}
      />

      <svg viewBox="0 0 400 400" className="absolute inset-0 w-full h-full">
        <defs>
          <radialGradient id="scan-grad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(255,184,0,0.55)" />
            <stop offset="60%" stopColor="rgba(255,184,0,0.05)" />
            <stop offset="100%" stopColor="rgba(255,184,0,0)" />
          </radialGradient>
          <linearGradient id="conn-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FFB800" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#FFB800" stopOpacity="0.05" />
          </linearGradient>
          <filter id="dot-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* concentric rings */}
        {[34, 65, 100, 140, 170].map((r, i) => (
          <circle
            key={r}
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke="rgba(255,184,0,0.10)"
            strokeWidth={i === 4 ? 1 : 0.7}
            strokeDasharray={i === 4 ? '0' : '2 6'}
          />
        ))}

        {/* compass crosshair */}
        <line x1={cx} y1={cy - 170} x2={cx} y2={cy + 170} stroke="rgba(255,184,0,0.06)" strokeWidth="0.8" />
        <line x1={cx - 170} y1={cy} x2={cx + 170} y2={cy} stroke="rgba(255,184,0,0.06)" strokeWidth="0.8" />

        {/* SCAN beam — wedge gradient that rotates */}
        <g transform={`rotate(${scan} ${cx} ${cy})`}>
          <path
            d={`M ${cx} ${cy} L ${cx} ${cy - 170} A 170 170 0 0 1 ${cx + 170 * Math.sin(40 * Math.PI / 180)} ${cy - 170 * Math.cos(40 * Math.PI / 180)} Z`}
            fill="url(#scan-grad)"
            opacity="0.85"
          />
          {/* leading edge bright line */}
          <line x1={cx} y1={cy} x2={cx} y2={cy - 170}
                stroke="#FFB800" strokeWidth="1.2" opacity="0.85" />
        </g>

        {/* connection line center → matched master */}
        {matchedPos && (
          <g key={`conn-${matchedIdx}`}>
            <line
              x1={cx} y1={cy} x2={matchedPos.x} y2={matchedPos.y}
              stroke="url(#conn-grad)" strokeWidth="1.5"
              className="conn-line"
            />
            <circle cx={matchedPos.x} cy={matchedPos.y} r="14"
                    fill="none" stroke="#FFB800" strokeWidth="1.5" className="conn-pulse" />
          </g>
        )}

        {/* masters */}
        {MASTERS.map((m, i) => {
          const p = polar(m.radius, m.angle);
          const isHit = hits.includes(i);
          const isMatched = matchedIdx === i;
          return (
            <g key={i} transform={`translate(${p.x} ${p.y})`}>
              {(isHit || isMatched) && (
                <circle r="10" fill="rgba(255,184,0,0.18)" className="hit-ring" />
              )}
              <circle r="3.5"
                      fill={isMatched ? '#FFB800' : isHit ? '#FFB800' : '#666'}
                      filter={isMatched ? 'url(#dot-glow)' : undefined}
                      className={isMatched ? 'master-pulse' : ''} />
            </g>
          );
        })}

        {/* central beacon */}
        <g>
          <circle cx={cx} cy={cy} r="22" fill="rgba(255,184,0,0.10)" />
          <circle cx={cx} cy={cy} r="14" fill="rgba(255,184,0,0.20)" />
          <circle cx={cx} cy={cy} r="8"  fill="#FFB800" filter="url(#dot-glow)" />
          <circle cx={cx} cy={cy} r="22" fill="none" stroke="rgba(255,184,0,0.4)" strokeWidth="0.8"
                  className="beacon-ring" />
          <circle cx={cx} cy={cy} r="22" fill="none" stroke="rgba(255,184,0,0.3)" strokeWidth="0.8"
                  className="beacon-ring beacon-ring-2" />
        </g>

        {/* radial readout label inside ring */}
        <text x={cx} y={cy + 50} textAnchor="middle"
              fill="rgba(255,255,255,0.5)" fontSize="9"
              fontFamily="Outfit, sans-serif"
              letterSpacing="3"
              fontWeight="700">
          MATCHING ENGINE
        </text>
      </svg>

      {/* Floating telemetry HUD */}
      <div className="absolute top-3 left-3 px-3 py-2 rounded bg-black/70 backdrop-blur-sm">
        <div className="text-[9px] uppercase tracking-[0.25em] text-gray-500 font-bold">scan radius</div>
        <div className="text-[15px] font-heading font-black text-amber leading-none mt-1">5 km</div>
      </div>
      <div className="absolute top-3 right-3 px-3 py-2 rounded bg-black/70 backdrop-blur-sm text-right">
        <div className="text-[9px] uppercase tracking-[0.25em] text-gray-500 font-bold">live masters</div>
        <div className="text-[15px] font-heading font-black text-amber leading-none mt-1">{MASTERS.length}</div>
      </div>
      {matched && (
        <div key={matchedIdx} className="hud-match absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-2 rounded bg-black/85 backdrop-blur-sm flex items-center gap-3 whitespace-nowrap">
          <span className="live-dot" />
          <div className="text-[10px] uppercase tracking-[0.2em] text-gray-400 font-bold">matched</div>
          <div className="text-xs text-white font-bold">★ {matched.rating}</div>
          <div className="text-xs text-amber font-bold">ETA {matched.eta} мин</div>
        </div>
      )}

      {/* CSS keyframes (scoped via global classes used above) */}
      <style>{`
        .conn-line {
          stroke-dasharray: 200;
          stroke-dashoffset: 200;
          animation: conn-draw 0.55s cubic-bezier(0.16,1,0.3,1) forwards;
        }
        .conn-pulse {
          animation: conn-pulse 1.2s ease-out forwards;
          transform-origin: center;
        }
        .master-pulse  { animation: master-pulse 1.2s ease-out forwards; transform-origin: center; }
        .hit-ring      { animation: hit-ring 1s ease-out forwards; transform-origin: center; }
        .beacon-ring   { animation: beacon-pulse 2.4s cubic-bezier(0.16,1,0.3,1) infinite; transform-origin: center; transform-box: fill-box; }
        .beacon-ring-2 { animation-delay: 1.2s; }
        .hud-match     { animation: hud-pop 0.35s cubic-bezier(0.16,1,0.3,1) forwards; }

        @keyframes conn-draw   { to { stroke-dashoffset: 0; } }
        @keyframes conn-pulse  { 0%{ r: 4; opacity: 1 } 100%{ r: 26; opacity: 0 } }
        @keyframes master-pulse{ 0%,100%{ r: 5 } 50%{ r: 7 } }
        @keyframes hit-ring    { 0%{ r: 5; opacity: 0.8 } 100%{ r: 18; opacity: 0 } }
        @keyframes beacon-pulse{ 0%{ transform: scale(1); opacity: 0.6 } 100%{ transform: scale(1.6); opacity: 0 } }
        @keyframes hud-pop     { from { opacity: 0; transform: translate(-50%, 6px) } to { opacity: 1; transform: translate(-50%, 0) } }
      `}</style>
    </div>
  );
}
