// Run: npx tsx --test src/lib/queries/yeoJohnson.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitPowerScaler, yeoJohnson } from "./yeoJohnson";

const close = (a: number, b: number, tol = 1e-5) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

test("yeoJohnson: the four branches", () => {
  close(yeoJohnson(3, 1), 3); // λ = 1 is the identity
  close(yeoJohnson(-3, 1), -3);
  close(yeoJohnson(3, 0), Math.log(4));
  close(yeoJohnson(-3, 2), -Math.log(4));
  close(yeoJohnson(3, 0.5), (Math.sqrt(4) - 1) / 0.5);
  close(yeoJohnson(-3, 0.5), -(Math.pow(4, 1.5) - 1) / 1.5);
});

// Expected values from scikit-learn 1.x: PowerTransformer(method="yeo-johnson").fit(xs), lambdas_ and transform.
test("fitPowerScaler matches scikit-learn's PowerTransformer", () => {
  const cases: [number[], number, number, number][] = [
    [[0, 0, 1, 2, 3, 10, 0.5, 4, 7, 25], -0.22050337943418405, -1.3919763033627357, 1.7157385760173047],
    [[-3.2, -1, 0, 0.5, 2, 2.2, 5, -0.4, 1.1, 9.5], 0.6815203897085248, -1.9892622482736688, 1.941710931888586],
    [[12.5, 30.1, 8, 15, 22, 9.9, 11, 27, 18, 14], -0.31481904443041847, -0.46844072295981487, -0.1821240791112754],
  ];
  for (const [xs, lambda, first, last] of cases) {
    const f = fitPowerScaler(xs);
    close(f.lambda, lambda, 1e-4);
    close(f(xs[0]), first, 1e-4);
    close(f(xs[xs.length - 1]), last, 1e-4);
  }
});

test("fitPowerScaler: standardized over the sample, order kept, no spread scores 0", () => {
  const xs = [0, 1, 1, 2, 3, 5, 8, 13, 40];
  const f = fitPowerScaler(xs);
  const ys = xs.map(f);
  close(ys.reduce((a, b) => a + b, 0) / ys.length, 0);
  close(ys.reduce((a, b) => a + b * b, 0) / ys.length, 1);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] >= ys[i - 1]);
  const flat = fitPowerScaler([4, 4, 4]);
  assert.equal(flat(4), 0);
  assert.equal(flat(9), 0);
});
