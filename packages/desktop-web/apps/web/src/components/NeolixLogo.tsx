// FILE: NeolixLogo.tsx
// Purpose: Render the Neox mark as an inline SVG that follows the current text color.
//          (The component keeps its internal name; the product is called Neox.)
// Mark: the letter N drawn as a workflow graph — four nodes at the corners of the N joined by
//       three edges (up, across, up). One command, several agents, run in order.
// The geometry below is also read by .dev/brand/neolix-icons.mjs to draw the app icons.

import type { SVGProps } from "react";

import { cn } from "~/lib/utils";

/** 100x100 box. Edges of the N: up the left side, across the diagonal, up the right side. */
export const NEOX_MARK_EDGES = "M27 75V25L73 75V25";
/** Node centres as "x y" pairs, in path order; the last one is the output node. */
export const NEOX_MARK_NODES = "27 75,27 25,73 75,73 25";
export const NEOX_MARK_EDGE_WIDTH = 9;
export const NEOX_MARK_NODE_RADIUS = 11.5;

const NODES = NEOX_MARK_NODES.split(",").map((pair) => pair.split(" ").map(Number));

export function NeolixLogo({ className, ...props }: SVGProps<SVGSVGElement>) {
  const ariaLabel = props["aria-label"];

  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaLabel ? undefined : true}
      {...props}
      className={cn("shrink-0 text-foreground", className)}
    >
      <path
        d={NEOX_MARK_EDGES}
        stroke="currentColor"
        strokeWidth={NEOX_MARK_EDGE_WIDTH}
        strokeLinejoin="round"
      />
      {NODES.map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={NEOX_MARK_NODE_RADIUS} fill="currentColor" />
      ))}
    </svg>
  );
}
