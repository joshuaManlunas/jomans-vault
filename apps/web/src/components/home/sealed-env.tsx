import { useEffect, useState } from "react";

const envLines = [
  { name: "DATABASE_URL", width: 19 },
  { name: "STRIPE_SECRET_KEY", width: 14 },
  { name: "OPENAI_API_KEY", width: 17 },
  { name: "RESEND_API_KEY", width: 11 },
  { name: "BETTER_AUTH_SECRET", width: 16 },
] as const;

const scrambleDuration = 400;
const lineDelay = 60;
const scrambleCharacters =
  "7fxv!z8%2ks#r^06t&39d$ph@m5cyq!4g+6z*8jr3v%nt9s#d^2ky4&bhp5w";

export const SealedEnv = () => {
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const duration = scrambleDuration + (envLines.length - 1) * lineDelay;
    let start: number | undefined;
    let frame: number;
    const tick = (timestamp: number) => {
      if (start === undefined) {
        start = timestamp;
      }
      const time = timestamp - start;
      if (time >= duration) {
        setElapsed(null);
        return;
      }

      setElapsed(time);
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <figure className="min-w-0 font-mono">
      <div className="bg-card text-card-foreground rounded-lg border p-4 sm:p-6 lg:p-7">
        <code className="mb-4 block border-b pb-4 font-mono text-sm font-medium sm:text-base">
          <span className="text-muted-foreground">$</span> jv run -- bun dev
        </code>
        <ul className="space-y-2 text-xs leading-6 sm:text-sm">
          {envLines.map(({ name, width }, index) => {
            const time = elapsed === null ? -1 : elapsed - index * lineDelay;
            const scrambling = time >= 0 && time < scrambleDuration;
            const offset = (Math.floor(time / 40) * 7 + index * 5) % 32;

            return (
              <li key={name} className="flex items-center gap-2">
                <code className="shrink-0 font-mono">{name}=</code>
                <span className="sr-only">value hidden</span>
                <span
                  aria-hidden="true"
                  className="relative flex h-6 max-w-full min-w-0 shrink items-center overflow-hidden"
                  style={{ width: `${width}ch` }}
                >
                  <span
                    className={`bg-foreground/80 block h-2.5 w-full rounded-sm motion-safe:transition-transform motion-safe:duration-100 motion-reduce:scale-y-100 ${scrambling ? "scale-y-0" : "scale-y-100"}`}
                  />
                  {scrambling && (
                    <span className="absolute inset-0 whitespace-nowrap motion-reduce:hidden">
                      {scrambleCharacters.slice(offset, offset + width)}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <figcaption className="text-muted-foreground mt-3 text-xs leading-relaxed sm:text-sm">
        Injected at runtime without writing values to disk.
      </figcaption>
    </figure>
  );
};
