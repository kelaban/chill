import { describe, expect, it } from "vitest";
import { thumbAt } from "./trickplay";

const m = { intervalS: 10, width: 320, height: 134, cols: 10, rows: 10, count: 250, sheets: ["/s1", "/s2", "/s3"], a: 1, b: 0 };

describe("thumbAt", () => {
  it("picks the nearest frame, across sheets", () => {
    expect(thumbAt(m, 0)).toEqual({ sheet: "/s1", x: 0, y: 0 });
    expect(thumbAt(m, 124)).toEqual({ sheet: "/s1", x: 2 * 320, y: 1 * 134 }); // frame 12
    expect(thumbAt(m, 1000)).toEqual({ sheet: "/s2", x: 0, y: 0 }); // frame 100
  });
  it("maps the playing copy's time onto the sheets' file", () => {
    expect(thumbAt({ ...m, b: 2.5 }, 37.6)).toEqual(thumbAt(m, 40.1));
  });
  it("clamps to the frames that exist", () => {
    expect(thumbAt(m, -50)).toEqual({ sheet: "/s1", x: 0, y: 0 });
    expect(thumbAt(m, 99_999)).toEqual({ sheet: "/s3", x: 9 * 320, y: 4 * 134 }); // frame 249
  });
});
