import { expect, test } from "bun:test";
import assert from "node:assert/strict";

import { mapWithConcurrency } from "./concurrency";

const gateAt = <T>(gates: readonly T[], index: number): T => {
  const gate = gates[index];
  assert.ok(gate);
  return gate;
};

test("bounded mapping preserves order when work finishes out of order", async () => {
  const gates = Array.from({ length: 5 }, () =>
    Promise.withResolvers<number>()
  );
  const started: number[] = [];
  let active = 0;
  let maximum = 0;
  const mapping = mapWithConcurrency(
    [0, 1, 2, 3, 4],
    2,
    async (item, index) => {
      expect(index).toBe(item);
      started.push(item);
      active += 1;
      maximum = Math.max(maximum, active);
      const result = await gateAt(gates, item).promise;
      active -= 1;
      return result;
    }
  );
  expect(started).toEqual([0, 1]);
  gateAt(gates, 1).resolve(11);
  await gateAt(gates, 1).promise;
  await Promise.resolve();
  expect(started).toEqual([0, 1, 2]);
  gateAt(gates, 2).resolve(12);
  await gateAt(gates, 2).promise;
  await Promise.resolve();
  gateAt(gates, 3).resolve(13);
  await gateAt(gates, 3).promise;
  await Promise.resolve();
  gateAt(gates, 4).resolve(14);
  gateAt(gates, 0).resolve(10);
  expect(await mapping).toEqual([10, 11, 12, 13, 14]);
  expect(maximum).toBe(2);
  expect(active).toBe(0);
});

test("first rejection stops scheduling while in-flight calls can settle", async () => {
  const gates = Array.from({ length: 4 }, () =>
    Promise.withResolvers<number>()
  );
  const started: number[] = [];
  const mapping = mapWithConcurrency([0, 1, 2, 3], 2, (item) => {
    started.push(item);
    return gateAt(gates, item).promise;
  });
  const error = new Error("failed");
  gateAt(gates, 1).reject(error);
  await expect(mapping).rejects.toBe(error);
  gateAt(gates, 0).resolve(0);
  await gateAt(gates, 0).promise;
  await Promise.resolve();
  expect(started).toEqual([0, 1]);
});

test("empty mapping starts no work", async () => {
  let calls = 0;
  expect(
    await mapWithConcurrency([], 8, async () => {
      calls += 1;
      return await Promise.resolve(1);
    })
  ).toEqual([]);
  expect(calls).toBe(0);
});
