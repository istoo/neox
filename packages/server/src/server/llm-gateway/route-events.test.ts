import { afterEach, describe, expect, it } from "vitest";
import { clearRouteEvents, publishRoute, routeCursor, routesAfter } from "./route-events.js";

afterEach(() => clearRouteEvents());

describe("the route-events ring", () => {
  it("numbers each route and resumes after a cursor", () => {
    publishRoute({ id: "a" });
    publishRoute({ id: "b" });
    publishRoute({ id: "c" });
    expect(routeCursor()).toBe(3);
    expect(routesAfter(1).routes.map((entry) => entry.route.id)).toEqual(["b", "c"]);
    expect(routesAfter(3).routes).toEqual([]);
  });

  it("keeps the newest 512 changes", () => {
    for (let index = 0; index < 600; index += 1) {
      publishRoute({ index });
    }
    const kept = routesAfter(0).routes;
    expect(kept).toHaveLength(512);
    expect(kept[0]?.route.index).toBe(88);
    expect(routeCursor()).toBe(600);
  });
});
