import { describe, expect, test } from "vitest";
import { Semaphore } from "../semaphore.js";

describe("Semaphore", () => {
  test("constructor throws when permits < 1", () => {
    expect(() => new Semaphore(0)).toThrow("Semaphore permits must be >= 1");
    expect(() => new Semaphore(-1)).toThrow("Semaphore permits must be >= 1");
  });

  test("constructor accepts valid permits", () => {
    const sem = new Semaphore(1);
    expect(sem.available).toBe(1);

    const sem2 = new Semaphore(5);
    expect(sem2.available).toBe(5);
  });

  test("acquires up to permit count without blocking", async () => {
    const sem = new Semaphore(3);

    await sem.acquire();
    expect(sem.available).toBe(2);

    await sem.acquire();
    expect(sem.available).toBe(1);

    await sem.acquire();
    expect(sem.available).toBe(0);
  });

  test("blocks when permits exhausted", async () => {
    const sem = new Semaphore(1);

    await sem.acquire();
    expect(sem.available).toBe(0);

    let acquired = false;
    const pendingAcquire = sem.acquire().then(() => {
      acquired = true;
    });

    // Give time for the acquire to potentially resolve (it shouldn't)
    await new Promise((r) => setTimeout(r, 10));
    expect(acquired).toBe(false);

    // Release to unblock
    sem.release();
    await pendingAcquire;
    expect(acquired).toBe(true);
  });

  test("releases allow waiting acquires to proceed", async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];

    await sem.acquire();
    order.push("first acquired");

    // Queue up waiting acquirers
    const p1 = sem.acquire().then(() => order.push("second acquired"));
    const p2 = sem.acquire().then(() => order.push("third acquired"));

    // Release twice
    sem.release();
    sem.release();

    await Promise.all([p1, p2]);

    expect(order).toEqual([
      "first acquired",
      "second acquired",
      "third acquired",
    ]);
  });

  test("available property reflects state", async () => {
    const sem = new Semaphore(2);
    expect(sem.available).toBe(2);

    await sem.acquire();
    expect(sem.available).toBe(1);

    await sem.acquire();
    expect(sem.available).toBe(0);

    sem.release();
    expect(sem.available).toBe(1);

    sem.release();
    expect(sem.available).toBe(2);
  });

  test("over-release beyond initial permits throws", () => {
    const sem = new Semaphore(1);
    expect(() => sem.release()).toThrow(
      "Semaphore over-release: already at max permits (1)",
    );
    expect(sem.available).toBe(1); // Unchanged
  });

  test("release after acquire returns to max, then throws on next", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.available).toBe(0);

    sem.release();
    sem.release();
    expect(sem.available).toBe(2);

    // Now at max - next release should throw
    expect(() => sem.release()).toThrow("Semaphore over-release");
  });

  test("FIFO ordering for waiting acquires", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    await sem.acquire();

    // Queue multiple waiters
    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));
    const p3 = sem.acquire().then(() => order.push(3));

    // Release each
    sem.release();
    sem.release();
    sem.release();

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  test("concurrent usage with multiple permits", async () => {
    const sem = new Semaphore(3);
    const inFlight: number[] = [];
    let maxConcurrent = 0;

    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      await sem.acquire();
      inFlight.push(i);
      maxConcurrent = Math.max(maxConcurrent, inFlight.length);

      // Simulate some work
      await new Promise((r) => setTimeout(r, 5));

      inFlight.splice(inFlight.indexOf(i), 1);
      sem.release();
    });

    await Promise.all(tasks.map((t) => t()));

    // Max concurrent should never exceed permits
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(inFlight).toHaveLength(0);
    expect(sem.available).toBe(3);
  });
});
