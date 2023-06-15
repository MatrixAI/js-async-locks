async function sleep(ms: number): Promise<void> {
  return await new Promise<void>((r) => setTimeout(r, ms));
}

async function yieldMicro(): Promise<void> {
  return await new Promise<void>((r) => queueMicrotask(r));
}

export { sleep, yieldMicro };
