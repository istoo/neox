import { useLocalAppSetting } from "~/appSettings";
import { useReduceMotion } from "~/lib/motionPreference";
import { cn } from "~/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  const loadingAnimation = useLocalAppSetting("loadingAnimation");
  const reduceMotion = useReduceMotion();
  // Settings' Loading animations switch (the native UI's "loading bird"): off leaves the
  // placeholder still instead of sweeping its highlight.
  const animate = loadingAnimation && !reduceMotion;

  return (
    <div
      className={cn(
        "rounded-sm [--skeleton-highlight:--alpha(var(--color-white)/64%)] [background:linear-gradient(120deg,transparent_40%,var(--skeleton-highlight),transparent_60%)_var(--color-muted)_0_0/200%_100%_fixed] dark:[--skeleton-highlight:--alpha(var(--color-white)/4%)]",
        animate && "animate-skeleton",
        className,
      )}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };
